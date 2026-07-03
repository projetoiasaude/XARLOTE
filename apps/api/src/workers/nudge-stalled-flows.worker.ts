/**
 * nudge-stalled-flows — re-engaja fluxos que morreram esperando o usuário.
 *
 * Caso real (02/07, 1º dia com usuários): "Preciso de um Imunologista" → Xarlote
 * perguntou região/plano → usuário não respondeu → o pedido morreu EM SILÊNCIO.
 * Idem "quero novalgina" → pediu confirmação → silêncio → nada. É exatamente no
 * momento de maior intenção que a conversão morre.
 *
 * Este cron (15min, sob cron-lock) manda UM lembrete gentil quando:
 *   a) pedido de farmácia 'quoted' (opções apresentadas, sem escolha) há 3-20h
 *   b) consulta 'quoted' (opções apresentadas, sem escolha) há 3-20h
 *   c) clarificação de estabelecimento 'awaiting_user' há 3-20h
 *
 * Travas anti-spam (NUNCA relaxar sem pensar):
 *   - 1 nudge por entidade (dedup por prefixo da mensagem já enviada na conversa)
 *   - só dentro da janela de 24h do WABA (última msg RECEBIDA < 22h — sem template)
 *   - máx 10 nudges por tick (circuit-break de segurança)
 *   - kill-switch: NUDGE_ENABLED=false desliga tudo
 */
import { db, writeLog, writeEvent } from '@iasaude/db';
import { sendOutbound } from '../handlers/outbound.js';
import { withCronLock } from '../middleware/cron-lock.js';
import { loadPrompts } from '../config/prompts.js';

const POLL_MS = 15 * 60 * 1000;
const MIN_AGE_MS = 3 * 60 * 60 * 1000;   // não afoba: 3h de silêncio antes do nudge
const MAX_AGE_MS = 20 * 60 * 60 * 1000;  // depois de 20h, deixa quieto (fora da janela logo)
const WABA_SAFE_MS = 22 * 60 * 60 * 1000; // margem de 2h antes da janela de 24h fechar
const MAX_NUDGES_PER_TICK = 10;

const COPY = {
  order: 'Oi! Vi que as opções de farmácia ainda estão te esperando 💙 Quer que eu siga com alguma delas? Se preferir cancelar, sem problema também — é só falar!',
  consultation: 'Oi! As opções de consulta que te mandei ainda estão de pé 💙 Quer confirmar alguma? Se nenhuma servir, me fala que eu busco outros horários!',
  clarification: 'Oi! Ficou faltando só uma respostinha sua pra eu continuar (dá uma olhadinha na minha última pergunta ali em cima 👆). Quando puder, me fala que eu sigo daqui 💙',
} as const;

interface NudgeTarget {
  kind: keyof typeof COPY;
  entityId: string;
  conversationId: string;
  entityTs: string; // dedup: só considera nudge enviado DEPOIS disso
}

async function phoneForConversation(conversationId: string): Promise<string | null> {
  const { data } = await db.from('conversations').select('whatsapp_jid').eq('id', conversationId).maybeSingle();
  const digits = data?.whatsapp_jid?.replace('@s.whatsapp.net', '');
  return digits ? `+${digits}` : null;
}

/** Última mensagem RECEBIDA (do usuário) — âncora da janela de 24h do WABA. */
async function lastInboundAt(conversationId: string): Promise<number | null> {
  const { data } = await db
    .from('messages')
    .select('created_at')
    .eq('conversation_id', conversationId)
    .eq('direction', 'in')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return data?.created_at ? new Date(data.created_at).getTime() : null;
}

/** Já mandamos ESTE tipo de nudge nesta conversa depois da entidade nascer? */
async function alreadyNudged(conversationId: string, kind: keyof typeof COPY, sinceIso: string): Promise<boolean> {
  const prefix = COPY[kind].slice(0, 30);
  const { data } = await db
    .from('messages')
    .select('id')
    .eq('conversation_id', conversationId)
    .eq('direction', 'out')
    .ilike('content', `${prefix.replace(/[\\%_]/g, (c) => `\\${c}`)}%`)
    .gt('created_at', sinceIso)
    .limit(1)
    .maybeSingle();
  return Boolean(data?.id);
}

async function collectTargets(): Promise<NudgeTarget[]> {
  const now = Date.now();
  const newest = new Date(now - MIN_AGE_MS).toISOString();
  const oldest = new Date(now - MAX_AGE_MS).toISOString();
  const targets: NudgeTarget[] = [];

  // a) Pedidos de farmácia com opções apresentadas e sem escolha
  const { data: orders } = await db
    .from('orders')
    .select('id, conversation_id, created_at')
    .eq('status', 'quoted')
    .gt('created_at', oldest)
    .lt('created_at', newest)
    .limit(20);
  for (const o of orders ?? []) {
    if (o.conversation_id) targets.push({ kind: 'order', entityId: o.id, conversationId: o.conversation_id, entityTs: o.created_at });
  }

  // b) Consultas com opções apresentadas e sem escolha
  const { data: consults } = await db
    .from('consultations')
    .select('id, conversation_id, created_at')
    .eq('status', 'quoted')
    .gt('created_at', oldest)
    .lt('created_at', newest)
    .limit(20);
  for (const c of consults ?? []) {
    if (c.conversation_id) targets.push({ kind: 'consultation', entityId: c.id, conversationId: c.conversation_id, entityTs: c.created_at });
  }

  // c) Clarificações de estabelecimento aguardando o usuário (farmácia + clínica)
  const { data: pharmClarifs } = await db
    .from('quotes')
    .select('id, clarification_asked_at, orders(conversation_id)')
    .eq('clarification_status', 'awaiting_user')
    .gt('clarification_asked_at', oldest)
    .lt('clarification_asked_at', newest)
    .limit(20);
  for (const q of pharmClarifs ?? []) {
    const convId = (q.orders as { conversation_id?: string | null } | null)?.conversation_id;
    if (convId) targets.push({ kind: 'clarification', entityId: q.id, conversationId: convId, entityTs: q.clarification_asked_at });
  }
  const { data: clinicClarifs } = await db
    .from('consultation_quotes')
    .select('id, clarification_asked_at, consultations!consultation_quotes_consultation_id_fkey(conversation_id)')
    .eq('clarification_status', 'awaiting_user')
    .gt('clarification_asked_at', oldest)
    .lt('clarification_asked_at', newest)
    .limit(20);
  for (const q of clinicClarifs ?? []) {
    const convId = (q.consultations as { conversation_id?: string | null } | null)?.conversation_id;
    if (convId) targets.push({ kind: 'clarification', entityId: q.id, conversationId: convId, entityTs: q.clarification_asked_at });
  }

  // d) STALL PRÉ-TOOL (os casos E7/E8 que motivaram este worker): a Xarlote fez uma
  //    PERGUNTA de triagem ("é em Goiânia? plano ou particular?", "confirma a
  //    novalgina?") ANTES de chamar start_pharmacy_order/start_consultation_search
  //    — não existe order/consultation no banco, então (a)/(b)/(c) nunca veem. Aqui
  //    olhamos a própria conversa: última mensagem é OUT terminando em '?' e o
  //    usuário sumiu. É onde a conversão mais morre (maior intenção).
  const { data: convs } = await db
    .from('conversations')
    .select('id, last_message_at')
    .eq('party_type', 'user')
    .not('user_id', 'is', null)
    .gt('last_message_at', oldest)
    .lt('last_message_at', newest)
    .order('last_message_at', { ascending: false })
    .limit(40);
  for (const c of convs ?? []) {
    const { data: last } = await db
      .from('messages')
      .select('direction, content, created_at')
      .eq('conversation_id', c.id)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (last?.direction === 'out' && (last.content ?? '').trim().endsWith('?')) {
      targets.push({ kind: 'clarification', entityId: c.id, conversationId: c.id, entityTs: last.created_at });
    }
  }

  return targets;
}

export async function nudgeStalledFlows(): Promise<void> {
  if (process.env['NUDGE_ENABLED'] === 'false') return; // kill-switch (env, legado)
  if (!loadPrompts().nudges_enabled) return;            // kill-switch (hot-reload via /prompts)

  try {
    const targets = await collectTargets();
    if (!targets.length) return;

    let sent = 0;
    const nudgedConvs = new Set<string>(); // máx 1 nudge por conversa por tick

    for (const t of targets) {
      if (sent >= MAX_NUDGES_PER_TICK) break;
      if (nudgedConvs.has(t.conversationId)) continue;

      // Janela WABA: só mensagem livre se o usuário falou conosco há < 22h.
      const lastIn = await lastInboundAt(t.conversationId);
      if (!lastIn || Date.now() - lastIn > WABA_SAFE_MS) continue;

      // Se o usuário mandou mensagem DEPOIS da entidade nascer, a conversa não está
      // morta — a Xarlote já está lidando com ele. Nudge é só pra silêncio real.
      if (lastIn > new Date(t.entityTs).getTime()) continue;

      if (await alreadyNudged(t.conversationId, t.kind, t.entityTs)) continue;

      const phone = await phoneForConversation(t.conversationId);
      if (!phone) continue;

      const traceId = `nudge-${t.kind}-${t.entityId.slice(0, 8)}`;
      await sendOutbound(t.conversationId, phone, COPY[t.kind], traceId);
      nudgedConvs.add(t.conversationId);
      sent++;

      await writeEvent({
        eventName: 'nudge.sent',
        conversationId: t.conversationId,
        traceId,
        payload: { kind: t.kind, entity_id: t.entityId },
      });
      await writeLog('info', 'nudge', `Nudge '${t.kind}' enviado (fluxo parado desde ${t.entityTs})`, {
        traceId, conversationId: t.conversationId,
      });
    }

    if (sent > 0) await writeLog('info', 'nudge', `nudge-stalled-flows: ${sent} nudge(s) neste tick`, {});
  } catch (err) {
    await writeLog('error', 'nudge', `nudge-stalled-flows falhou: ${String(err).slice(0, 200)}`, {});
  }
}

let interval: NodeJS.Timeout | null = null;

export function startNudgeWorker(): void {
  if (interval) return;
  setTimeout(() => {
    void withCronLock('nudge-stalled-flows', POLL_MS, nudgeStalledFlows);
    interval = setInterval(() => void withCronLock('nudge-stalled-flows', POLL_MS, nudgeStalledFlows), POLL_MS);
  }, 90 * 1000); // 1ª run 90s após boot
  void writeLog('info', 'nudge', 'nudge-stalled-flows worker iniciado (cada 15min)', {});
}

export function stopNudgeWorker(): void {
  if (interval) {
    clearInterval(interval);
    interval = null;
  }
}
