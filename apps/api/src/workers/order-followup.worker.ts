/**
 * order-followup — acompanhamento PÓS-FECHAMENTO do pedido de farmácia.
 *
 * Incidente Santa Lúcia (07/07): o pedido fechou às 18:13 com prazo prometido de 19h,
 * a farmácia NUNCA confirmou o preparo e ninguém cobrou — o fundador teve que mandar
 * mensagens manuais pelo painel e LIGAR pra farmácia. A Xarlote fechava e "ia embora".
 *
 * Este cron (2min, sob cron-lock) cuida de pedidos 'handed_off' recentes (<24h):
 *   a) FARMÁCIA MUDA: 20min sem NENHUMA resposta da farmácia após o fechamento →
 *      cobra UMA vez, tom humano variado ("oi, conseguiram separar o pedido?").
 *   b) PRAZO PROMETIDO: delivery_deadline (extraído do aceite: "antes das 19h")
 *      chegando/estourado sem confirmação → avisa o CLIENTE com honestidade e
 *      pergunta se insiste ou troca.
 *
 * Travas anti-spam:
 *   - 1 cobrança por pedido (followup_nudged_at) e 1 alerta por pedido (deadline_alert_at)
 *   - só dentro da janela de 24h do WABA (última msg da farmácia < 22h)
 *   - máx 5 ações por tick; kill-switches: pharmacy_outbound_enabled (farmácia),
 *     NUDGE_ENABLED (alerta ao cliente)
 */
import { db, writeLog, writeEvent } from '@iasaude/db';
import { sendOutbound } from '../handlers/outbound.js';
import { sendOutboundToSupplier } from '../handlers/outbound-agent.js';
import { withCronLock } from '../middleware/cron-lock.js';
import { loadPrompts } from '../config/prompts.js';
import { isPlaceholderPhone } from '@iasaude/shared';

const POLL_MS = 2 * 60 * 1000;
const SILENT_NUDGE_MS = 20 * 60 * 1000;      // 20min de silêncio da farmácia → cobra
const DEADLINE_MARGIN_MS = 10 * 60 * 1000;   // alerta a partir de 10min antes do prazo
const WABA_SAFE_MS = 22 * 60 * 60 * 1000;    // margem antes da janela de 24h fechar
const MAX_ACTIONS_PER_TICK = 5;
const ABANDONED_QUOTE_MS = 7 * 24 * 60 * 60 * 1000; // 'quoted' sem escolha há 7+ dias = cotação vencida

// Cobrança à farmácia: humana e VARIADA (nunca a mesma frase sempre — tell de robô).
const SUPPLIER_NUDGES = [
  'oi! conseguiram separar o pedido? me avisa quando sair a entrega 🙏',
  'oi, tudo certo com o pedido? qualquer coisa me fala',
  'e aí, conseguiram ver o pedido? fico no aguardo',
];

function hourBRT(iso: string): string {
  return new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
}

interface HandedOffOrder {
  id: string;
  conversation_id: string | null;
  selected_quote_id: string | null;
  closed_at: string;
  delivery_deadline: string | null;
  followup_nudged_at: string | null;
  deadline_alert_at: string | null;
  supplier_confirmed_at: string | null;
}

async function lastSupplierInboundAfter(conversationId: string, afterIso: string): Promise<string | null> {
  const { data } = await db.from('messages')
    .select('created_at')
    .eq('conversation_id', conversationId)
    .eq('direction', 'in')
    .eq('sender_role', 'supplier')
    .gt('created_at', afterIso)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data?.created_at as string | null) ?? null;
}

async function lastSupplierInboundAt(conversationId: string): Promise<number | null> {
  const { data } = await db.from('messages')
    .select('created_at')
    .eq('conversation_id', conversationId)
    .eq('direction', 'in')
    .eq('sender_role', 'supplier')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return data?.created_at ? new Date(data.created_at).getTime() : null;
}

/** Última msg RECEBIDA do CLIENTE — âncora da janela de 24h do WABA na perna do usuário. */
async function lastUserInboundAt(conversationId: string): Promise<number | null> {
  const { data } = await db.from('messages')
    .select('created_at')
    .eq('conversation_id', conversationId)
    .eq('direction', 'in')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return data?.created_at ? new Date(data.created_at).getTime() : null;
}

/**
 * EXPIRA cotações abandonadas (auditoria 20/07). Um pedido 'quoted' é opções apresentadas
 * aguardando a ESCOLHA do paciente. O nudge-stalled-flows cutuca UMA vez entre 3–20h e depois
 * deixa quieto — então o pedido fica 'quoted' PARA SEMPRE quando a pessoa não responde (Marina
 * desde 10/06 = 40 dias; vários outros). Depois de 7 dias a cotação está VENCIDA de qualquer
 * forma (preço/estoque de farmácia mudam numa semana). Marca 'failed' com MOTIVO + evento.
 *
 * NÃO é destrutivo: 'failed' é revivível (inbound-supplier revive failed→quoting quando a
 * farmácia responde) e o paciente pode recomeçar com cotação FRESCA (melhor que uma de 1 semana).
 * Não mexe em pedido com escolha já feita (selected_quote_id) nem em pós-fechamento (handed_off).
 */
export async function expireAbandonedQuotes(): Promise<void> {
  try {
    const cutoff = new Date(Date.now() - ABANDONED_QUOTE_MS).toISOString();
    // created_at (não updated_at): a migration 0022 bumpou updated_at de todos os antigos; e a
    // revivência (inbound-supplier) reseta created_at → ele reflete o ciclo de cotação atual.
    const { data: stale } = await db.from('orders')
      .select('id, user_id, created_at')
      .eq('status', 'quoted')
      .is('selected_quote_id', null)
      .lt('created_at', cutoff)
      .limit(20);
    if (!stale?.length) return;
    for (const o of stale) {
      // Claim atômico (.eq('status','quoted')) — se outro processo/fechamento mexeu, não pisa.
      const { data: claimed } = await db.from('orders')
        .update({ status: 'failed', cancelled_reason: 'cotação expirada — 7+ dias sem escolha do paciente (preços/estoque desatualizados)' })
        .eq('id', o.id).eq('status', 'quoted').is('selected_quote_id', null).select('id');
      if (claimed?.length) {
        await writeLog('info', 'order', `cotação abandonada expirada (>7d sem escolha) — pedido ${o.id.slice(0, 8)} → failed`, { orderId: o.id });
        void writeEvent({ eventName: 'order.quote_expired', userId: (o.user_id as string | null) ?? undefined, payload: { order_id: o.id } });
      }
    }
  } catch (err) {
    await writeLog('error', 'order', `expire-abandoned-quotes falhou: ${String(err).slice(0, 160)}`, {});
  }
}

export async function followUpHandedOffOrders(): Promise<void> {
  // Guarda de tick inteiro: como todo worker-irmão deste diretório, um erro transitório
  // (blip de rede no Supabase, dado inesperado) NÃO pode virar unhandled rejection e
  // derrubar o processo ROLE=all (HTTP + workers juntos) — review 08/07.
  try {
    const now = Date.now();
    const sinceIso = new Date(now - 24 * 60 * 60 * 1000).toISOString();
    const { data: orders } = await db.from('orders')
      .select('id, conversation_id, selected_quote_id, closed_at, delivery_deadline, followup_nudged_at, deadline_alert_at, supplier_confirmed_at')
      .eq('status', 'handed_off')
      .not('closed_at', 'is', null)
      .gte('closed_at', sinceIso)
      .limit(30);
    if (!orders?.length) return;

    let actions = 0;
    for (const o of orders as HandedOffOrder[]) {
      if (actions >= MAX_ACTIONS_PER_TICK) break;
      // Guarda POR-PEDIDO: um pedido problemático não aborta o follow-up dos outros 29.
      try {
        if (!o.selected_quote_id) continue;

        // Cotação escolhida → conversa + telefone + nome da farmácia
        const { data: quote } = await db.from('quotes')
          .select('conversation_id, suppliers(name, whatsapp_e164, phone_e164)')
          .eq('id', o.selected_quote_id)
          .maybeSingle();
        const sup = quote?.suppliers as { name?: string; whatsapp_e164?: string; phone_e164?: string } | null;
        const supConvId = (quote?.conversation_id as string | null) ?? null;
        const supPhone = sup?.whatsapp_e164 || sup?.phone_e164 || null;
        if (!supConvId || !supPhone || isPlaceholderPhone(supPhone)) continue;

        const ackAt = await lastSupplierInboundAfter(supConvId, o.closed_at);

        // (a) FARMÁCIA MUDA → cobra UMA vez (tom humano, variado), dentro da janela WABA.
        // "Qualquer resposta" basta aqui: o objetivo é só "não está muda"; se ela respondeu
        // algo (mesmo "já vi"), não re-cutuca.
        if (!ackAt && !o.followup_nudged_at && now - new Date(o.closed_at).getTime() > SILENT_NUDGE_MS) {
          if (loadPrompts().pharmacy_outbound_enabled) {
            const lastIn = await lastSupplierInboundAt(supConvId);
            const inWindow = lastIn != null && now - lastIn < WABA_SAFE_MS;
            if (inWindow) {
              // Claim atômico ANTES do envio (réplicas/ticks concorrentes não duplicam).
              const { data: claimed } = await db.from('orders')
                .update({ followup_nudged_at: new Date().toISOString() })
                .eq('id', o.id).is('followup_nudged_at', null).select('id');
              if (claimed?.length) {
                const msg = SUPPLIER_NUDGES[Math.abs(o.id.charCodeAt(0) + o.id.charCodeAt(5)) % SUPPLIER_NUDGES.length] as string;
                await sendOutboundToSupplier(supConvId, supPhone, msg, `followup-${o.id.slice(0, 8)}`);
                await writeLog('info', 'order', `📦 Follow-up: cobrei ${sup?.name ?? 'a farmácia'} (silêncio pós-fechamento >20min)`, { orderId: o.id });
                actions++;
              }
            } else {
              await writeLog('warn', 'order', 'Follow-up: farmácia fora da janela de 24h — sem cobrança por texto livre', { orderId: o.id });
              // Marca pra não re-avaliar a cada tick (fora da janela não vai voltar sozinho).
              await db.from('orders').update({ followup_nudged_at: new Date().toISOString() }).eq('id', o.id).is('followup_nudged_at', null);
            }
          }
        }

        // (b) PRAZO PROMETIDO chegando/estourado SEM CONFIRMAÇÃO REAL → avisa o CLIENTE.
        // Gate é supplier_confirmed_at (record_order_confirmation), NÃO ackAt: um "blz"
        // jogado da farmácia não é confirmação de saída e não pode calar o aviso ao cliente
        // (era o incidente Santa Lúcia mascarado — review 08/07).
        if (o.delivery_deadline && !o.deadline_alert_at && !o.supplier_confirmed_at
            && now > new Date(o.delivery_deadline).getTime() - DEADLINE_MARGIN_MS) {
          if (process.env['NUDGE_ENABLED'] !== 'false' && o.conversation_id) {
            const { data: uconv } = await db.from('conversations').select('whatsapp_jid').eq('id', o.conversation_id).maybeSingle();
            const userPhone = uconv?.whatsapp_jid ? `+${uconv.whatsapp_jid.replace('@s.whatsapp.net', '')}` : null;
            // Janela WABA da perna do CLIENTE (zpro/oficial): texto livre fora de 24h é
            // rejeitado pela Meta (sem fallback de template) e o claim 1x queimaria sem
            // entregar — o cliente nunca seria avisado. Só envia dentro da janela; fora
            // dela NÃO queima o claim (se o cliente voltar a falar, o próximo tick avisa).
            const lastUserIn = o.conversation_id ? await lastUserInboundAt(o.conversation_id) : null;
            const userInWindow = lastUserIn != null && now - lastUserIn < WABA_SAFE_MS;
            if (userPhone && userInWindow) {
              const { data: claimed } = await db.from('orders')
                .update({ deadline_alert_at: new Date().toISOString() })
                .eq('id', o.id).is('deadline_alert_at', null).select('id');
              if (claimed?.length) {
                const passou = now > new Date(o.delivery_deadline).getTime();
                const h = hourBRT(o.delivery_deadline);
                const msg = passou
                  ? `O prazo das ${h} passou e a farmácia ainda não me confirmou a saída da entrega 😕 Já cobrei eles aqui. Quer que eu insista mais, ou prefere que eu procure outra opção pra você?`
                  : `Tá chegando o prazo das ${h} e a farmácia ainda não me confirmou a saída 😕 Já estou em cima — te aviso assim que responderem!`;
                await sendOutbound(o.conversation_id, userPhone, msg, `followup-${o.id.slice(0, 8)}`);
                await writeLog('info', 'order', `⏰ Follow-up: cliente avisado do prazo (${passou ? 'estourado' : 'chegando'})`, { orderId: o.id });
                actions++;
              }
            } else if (userPhone && !userInWindow) {
              await writeLog('warn', 'order', 'Follow-up: cliente fora da janela de 24h — alerta de prazo adiado (texto livre não entrega)', { orderId: o.id });
            }
          }
        }
      } catch (err) {
        await writeLog('error', 'order', `order-followup: pedido ${o.id.slice(0, 8)} falhou — ${String(err).slice(0, 160)}`, { orderId: o.id });
      }
    }
  } catch (err) {
    await writeLog('error', 'order', `order-followup crashed: ${String(err).slice(0, 200)}`, {});
  }
}

let interval: ReturnType<typeof setInterval> | null = null;

/** Tick do worker: cobra pós-fechamento + expira cotação abandonada. Cada um tem seu try/catch
 *  interno — uma falha não impede a outra tarefa (nem derruba o processo ROLE=all). */
async function orderFollowupTick(): Promise<void> {
  await followUpHandedOffOrders();
  await expireAbandonedQuotes();
}

export function startOrderFollowupWorker(): void {
  if (interval) return;
  setTimeout(() => {
    void withCronLock('order-followup', POLL_MS, orderFollowupTick);
    interval = setInterval(() => void withCronLock('order-followup', POLL_MS, orderFollowupTick), POLL_MS);
  }, 60 * 1000); // 1ª run 60s após boot
  void writeLog('info', 'order', 'order-followup worker iniciado (cada 2min)', {});
}

export function stopOrderFollowupWorker(): void {
  if (interval) {
    clearInterval(interval);
    interval = null;
  }
}
