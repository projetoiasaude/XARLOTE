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
import { db, writeLog } from '@iasaude/db';
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

export async function followUpHandedOffOrders(): Promise<void> {
  const now = Date.now();
  const sinceIso = new Date(now - 24 * 60 * 60 * 1000).toISOString();
  const { data: orders } = await db.from('orders')
    .select('id, conversation_id, selected_quote_id, closed_at, delivery_deadline, followup_nudged_at, deadline_alert_at')
    .eq('status', 'handed_off')
    .not('closed_at', 'is', null)
    .gte('closed_at', sinceIso)
    .limit(30);
  if (!orders?.length) return;

  let actions = 0;
  for (const o of orders as HandedOffOrder[]) {
    if (actions >= MAX_ACTIONS_PER_TICK) break;
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

    // (b) PRAZO PROMETIDO chegando/estourado sem confirmação → avisa o CLIENTE.
    if (o.delivery_deadline && !o.deadline_alert_at && !ackAt
        && now > new Date(o.delivery_deadline).getTime() - DEADLINE_MARGIN_MS) {
      if (process.env['NUDGE_ENABLED'] !== 'false' && o.conversation_id) {
        const { data: uconv } = await db.from('conversations').select('whatsapp_jid').eq('id', o.conversation_id).maybeSingle();
        const userPhone = uconv?.whatsapp_jid ? `+${uconv.whatsapp_jid.replace('@s.whatsapp.net', '')}` : null;
        if (userPhone) {
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
        }
      }
    }
  }
}

let interval: ReturnType<typeof setInterval> | null = null;

export function startOrderFollowupWorker(): void {
  if (interval) return;
  setTimeout(() => {
    void withCronLock('order-followup', POLL_MS, followUpHandedOffOrders);
    interval = setInterval(() => void withCronLock('order-followup', POLL_MS, followUpHandedOffOrders), POLL_MS);
  }, 60 * 1000); // 1ª run 60s após boot
  void writeLog('info', 'order', 'order-followup worker iniciado (cada 2min)', {});
}

export function stopOrderFollowupWorker(): void {
  if (interval) {
    clearInterval(interval);
    interval = null;
  }
}
