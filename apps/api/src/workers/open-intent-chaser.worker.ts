/**
 * open-intent-chaser — cobra o que o PACIENTE pediu e nós não entregamos.
 *
 * ─── POR QUE ISTO EXISTE (auditoria 04/08) ────────────────────────────────────
 * Duas dívidas nossas com o mesmo paciente, e a mesma forma de falha nas duas: alguém
 * ficou esperando e ninguém cobrou.
 *
 * 1. **INTENÇÃO DE CONSULTA ABERTA** (caso Glauber, 01/08). Ele pediu cardiologista, a
 *    Xarlote fez duas perguntas desnecessárias, uma resposta ambígua foi lida como
 *    desistência e o assunto morreu. Nunca existiu linha em `consultations`, e todos os
 *    vigilantes varrem tabela — a intenção era invisível por construção.
 *
 * 2. **DOCUMENTO PENDENTE** (caso Glauber, 30/07). A recepção do Dr. Marco Elísio pediu
 *    foto da carteirinha do Ipasgo e do pedido médico. O backstop de repasse levou o
 *    recado ao paciente — e aí paramos. Ele nunca mandou, ninguém cobrou, e a consulta
 *    ficou esperando um documento por tempo indeterminado.
 *
 * O padrão é claro: **nós tratamos "avisei o paciente" como fim de tarefa, quando é o
 * começo de uma espera.** Espera sem dono e sem prazo é a mesma doença de estado
 * não-terminal sem vigilante — só que do lado de fora do banco.
 *
 * Disciplina: cobra no máximo 2× com intervalo CRESCENTE, respeita quiet hours, e depois
 * encerra com honestidade. Cobrar é serviço; cobrar sem limite é perseguição.
 */
import { db, writeLog, writeEvent } from '@iasaude/db';
import { shouldNudgeIntent, type OpenConsultationIntent } from '@iasaude/shared';
import { withCronLock } from '../middleware/cron-lock.js';
import { loadPrompts } from '../config/prompts.js';
import { sendOutbound } from '../handlers/outbound.js';
import { LIVE_CONSULTATION_STATUSES } from '../handlers/entity-resolve.js';

const POLL_INTERVAL_MS = 60 * 60_000; // 1x/h — cobrança não é urgência

/** Teto por rodada: protege a fila e evita rajada de mensagem proativa. */
const MAX_PER_RUN = 5;

/** Documento pedido pela clínica e não enviado: cobra depois disto. */
const DOC_NUDGE_AFTER_MS = 24 * 60 * 60_000;
const DOC_MAX_NUDGES = 2;

/** Quiet hours de Brasília — mesma regra do `nudge-stalled-flows`. */
export function isQuietHourBrt(nowMs: number): boolean {
  const h = Number(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'America/Sao_Paulo', hour: '2-digit', hour12: false,
  }).format(new Date(nowMs)));
  return h >= 22 || h < 7;
}

/** Telefone do paciente a partir da conversa. */
async function phoneOf(conversationId: string): Promise<string | null> {
  const { data } = await db.from('conversations').select('whatsapp_jid').eq('id', conversationId).maybeSingle();
  const tel = data?.whatsapp_jid?.replace('@s.whatsapp.net', '');
  return tel ? `+${tel}` : null;
}

/** Conversa canônica do paciente (a da perna `sara`). */
async function conversationOf(userId: string): Promise<string | null> {
  const { data } = await db
    .from('conversations')
    .select('id')
    .eq('user_id', userId)
    .eq('party_type', 'user')
    .order('last_message_at', { ascending: false })
    .limit(1);
  return (data?.[0]?.id as string | undefined) ?? null;
}

// ─── 1. Intenção de consulta aberta ──────────────────────────────────────────

async function chaseOpenIntents(nowMs: number): Promise<number> {
  const { data: users, error } = await db
    .from('users')
    .select('id, preferred_name, metadata')
    .not('metadata->open_consultation_intent', 'is', null)
    .is('deleted_at', null)
    .limit(50);
  if (error) {
    await writeLog('error', 'open-intent', `varredura de intenção falhou: ${error.message.slice(0, 120)}`, {});
    return 0;
  }

  let sent = 0;
  for (const u of users ?? []) {
    if (sent >= MAX_PER_RUN) break;
    const intent = ((u.metadata as Record<string, unknown>)?.['open_consultation_intent'] ?? null) as OpenConsultationIntent | null;
    if (!intent) continue;

    const { data: vivas } = await db
      .from('consultations')
      .select('id')
      .eq('user_id', u.id)
      .in('status', LIVE_CONSULTATION_STATUSES)
      .limit(1);
    const temViva = (vivas ?? []).length > 0;

    // A intenção foi atendida por outro caminho → limpa e segue.
    if (temViva) {
      const { open_consultation_intent: _d, ...resto } = (u.metadata as Record<string, unknown>) ?? {};
      await db.from('users').update({ metadata: resto }).eq('id', u.id);
      continue;
    }
    const verdict = shouldNudgeIntent(intent, nowMs, { hasLiveConsultation: false, quietHours: isQuietHourBrt(nowMs) });
    if (!verdict.nudge) continue;

    const convId = await conversationOf(u.id as string);
    const phone = convId ? await phoneOf(convId) : null;
    if (!convId || !phone) continue;

    const nome = String(u.preferred_name ?? '').split(/\s+/)[0] ?? '';
    const qual = intent.specialty ? ` de ${intent.specialty}` : '';
    // A mensagem assume a dívida como NOSSA — porque é. Ele pediu e nós não entregamos.
    const msg = intent.nudged === 0
      ? `Oi${nome ? `, ${nome}` : ''}! Ficou uma coisa pendente aqui do meu lado: você me pediu uma consulta${qual} e eu não cheguei a abrir a busca. Ainda quer que eu procure? Se sim, é só me dizer "pode procurar" que eu começo agora 💙`
      : `Oi${nome ? `, ${nome}` : ''}! Só pra fechar isso aqui: quer que eu procure a consulta${qual} que você tinha me pedido? Se preferir deixar pra depois, sem problema — me avisa que eu tiro da minha lista 💙`;

    // ⚠️ Dedup CURTO de propósito (revisão adversarial deste worker): uma janela de horas
    // seria MAIOR que o intervalo de cobrança, então uma supressão por duplicata devolveria
    // `false`, o contador `nudged` nunca avançaria e a cobrança ficaria travada pra sempre
    // sem nunca sair. 5 min cobre a corrida de dois ticks; quem garante o resto é o contador.
    const ok = await sendOutbound(convId, phone, msg, `intent-chase-${String(u.id).slice(0, 8)}`, {}, { dedup: true, dedupWindowMs: 5 * 60_000 });
    if (!ok) continue;

    const { data: fresh } = await db.from('users').select('metadata').eq('id', u.id).maybeSingle();
    const base = (fresh?.metadata as Record<string, unknown> | null) ?? {};
    await db.from('users').update({
      metadata: { ...base, open_consultation_intent: { ...intent, nudged: intent.nudged + 1, last_nudge_at: new Date(nowMs).toISOString() } },
    }).eq('id', u.id);

    await writeLog('info', 'open-intent', `intenção de consulta cobrada (${verdict.reason})`, { userId: u.id });
    void writeEvent({ eventName: 'consultation.intent_chased', userId: u.id as string, payload: { nudged: intent.nudged + 1, specialty: intent.specialty } });
    sent += 1;
  }
  return sent;
}

// ─── 2. Documento que a clínica pediu e o paciente não mandou ────────────────

async function chasePendingDocs(nowMs: number): Promise<number> {
  if (isQuietHourBrt(nowMs)) return 0;
  const cutoff = new Date(nowMs - DOC_NUDGE_AFTER_MS).toISOString();
  const { data: quotes, error } = await db
    .from('consultation_quotes')
    // Embed DESAMBIGUADO — existem DUAS FKs entre consultation_quotes e consultations, e
    // sem o hint o PostgREST devolve PGRST201/HTTP 300 com `data` null (o erro que já matou
    // o nudge de consulta inteiro em silêncio, auditoria 03/08).
    .select('id, clarification_question, clarification_asked_at, notes, consultations!consultation_quotes_consultation_id_fkey(id, user_id, status, conversation_id, specialty, preferences)')
    .eq('clarification_status', 'pending')
    .not('clarification_asked_at', 'is', null)
    .lt('clarification_asked_at', cutoff)
    .limit(30);
  if (error) {
    await writeLog('error', 'open-intent', `varredura de documento pendente falhou: ${error.message.slice(0, 120)}`, {});
    return 0;
  }

  let sent = 0;
  for (const q of quotes ?? []) {
    if (sent >= MAX_PER_RUN) break;
    const c = q.consultations as { id?: string; user_id?: string; status?: string; conversation_id?: string; specialty?: string; preferences?: Record<string, unknown> } | null;
    if (!c?.id || !c.user_id || !c.conversation_id) continue;
    // Consulta que já morreu ou já fechou não tem pendência a cobrar.
    if (!(LIVE_CONSULTATION_STATUSES as readonly string[]).includes(String(c.status))) continue;

    const prefs = c.preferences ?? {};
    const chase = (prefs['_doc_chase'] ?? null) as { count?: number; last_at?: string } | null;
    const count = Number(chase?.count ?? 0);
    const ancora = Date.parse(chase?.last_at ?? (q.clarification_asked_at as string));
    if (!Number.isFinite(ancora)) continue;
    // Intervalo CRESCENTE, igual à intenção: 24h, depois 72h.
    const espera = DOC_NUDGE_AFTER_MS * (count === 0 ? 1 : 3);
    if (nowMs - ancora < espera) continue;

    const phone = await phoneOf(c.conversation_id);
    if (!phone) continue;
    const pergunta = String(q.clarification_question ?? '').trim();

    if (count >= DOC_MAX_NUDGES) {
      // Encerra com HONESTIDADE em vez de deixar a consulta esperando pra sempre.
      await db.from('consultation_quotes').update({ clarification_status: 'timeout' }).eq('id', q.id);
      await sendOutbound(c.conversation_id, phone,
        `Oi! Sobre a consulta de ${c.specialty ?? 'que a gente estava vendo'}: o consultório precisava de um documento seu e eu não recebi, então vou pausar essa busca pra não te encher. Quando quiser retomar, me manda o documento ou só diz "vamos de novo" que eu reabro na hora 💙`,
        `doc-chase-${String(q.id).slice(0, 8)}`, {}, { dedup: true, dedupWindowMs: 5 * 60_000 });
      await writeLog('warn', 'open-intent', `documento pendente há muito tempo — busca pausada com honestidade após ${count} cobranças`, {
        consultationId: c.id, quoteId: q.id,
      });
      sent += 1;
      continue;
    }

    const msg = count === 0
      ? `Oi! Voltando naquele ponto da consulta: o consultório pediu ${pergunta ? `o seguinte — "${pergunta}"` : 'um documento seu'}. Consegue me mandar por aqui? É só isso que está faltando pra eu fechar o horário 💙`
      : `Oi! Só pra não perder o horário: ainda estou esperando ${pergunta ? `aquilo que o consultório pediu ("${pergunta}")` : 'o documento que o consultório pediu'}. Se ficou difícil de conseguir, me fala que eu vejo outra saída com eles 💙`;

    const ok = await sendOutbound(c.conversation_id, phone, msg, `doc-chase-${String(q.id).slice(0, 8)}`, {}, { dedup: true, dedupWindowMs: 5 * 60_000 });
    if (!ok) continue;

    await db.from('consultations')
      .update({ preferences: { ...prefs, _doc_chase: { count: count + 1, last_at: new Date(nowMs).toISOString() } } })
      .eq('id', c.id);
    await writeLog('info', 'open-intent', `documento pendente cobrado (${count + 1}ª vez)`, { consultationId: c.id, quoteId: q.id });
    void writeEvent({ eventName: 'consultation.doc_chased', userId: c.user_id, payload: { consultation_id: c.id, count: count + 1 } });
    sent += 1;
  }
  return sent;
}

export async function runOpenIntentChaserOnce(nowMs = Date.now()): Promise<{ intents: number; docs: number }> {
  if (!loadPrompts().nudges_enabled) return { intents: 0, docs: 0 };
  const intents = await chaseOpenIntents(nowMs).catch(async (e) => {
    await writeLog('error', 'open-intent', `cobrança de intenção falhou: ${String(e).slice(0, 140)}`, {});
    return 0;
  });
  const docs = await chasePendingDocs(nowMs).catch(async (e) => {
    await writeLog('error', 'open-intent', `cobrança de documento falhou: ${String(e).slice(0, 140)}`, {});
    return 0;
  });
  return { intents, docs };
}

let interval: NodeJS.Timeout | null = null;

export function startOpenIntentChaserWorker(): void {
  if (interval) return;
  const tick = () => void withCronLock('open-intent-chaser', POLL_INTERVAL_MS, async () => {
    const { intents, docs } = await runOpenIntentChaserOnce();
    if (intents + docs > 0) {
      await writeLog('info', 'open-intent', `${intents} intenção(ões) e ${docs} documento(s) cobrados`, {});
    }
  });
  // 10 min após o boot: dá tempo do resto subir e não coincide com o pico de reinício.
  setTimeout(() => {
    tick();
    interval = setInterval(tick, POLL_INTERVAL_MS);
  }, 10 * 60_000);
  void writeLog('info', 'open-intent', 'open-intent-chaser worker iniciado (1x/h)', {});
}

export function stopOpenIntentChaserWorker(): void {
  if (interval) {
    clearInterval(interval);
    interval = null;
  }
}
