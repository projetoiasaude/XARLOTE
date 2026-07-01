import { db, writeLog } from '@iasaude/db';
import { sendOutbound } from './outbound.js';
import { hasPendingClarification } from './clarification.js';

const CHECK_3MIN_MS = 3 * 60 * 1000;
const CHECK_5MIN_MS = 5 * 60 * 1000;
const scheduledTimeouts = new Set<string>();

// F1.A3: além de quantos minutos um pedido preso em 'quoting' é considerado órfão
// (timer de consolidação perdido num restart) e resgatado pelo dispatcher.
const RESCUE_WINDOW_MIN = Number(process.env['PHARMACY_RESCUE_WINDOW_MIN'] ?? 10);

/**
 * Timers por pedido:
 *
 *  3 min → se ≥3 cotações: consolida agora. Senão: fica em silêncio.
 *  5 min → se ≥1 cotação:  consolida agora com o que tiver.
 *         se 0 cotações:   entra em modo "eager" (status_5min_done=true).
 *
 * Modo eager: a próxima cotação que chegar via notifyUserQuoteArrived
 * dispara consolidação imediata, sem esperar mais.
 */
export function scheduleQuoteTimeout(
  orderId: string,
  userConversationId: string,
  userPhoneE164: string,
  traceId: string,
): void {
  if (scheduledTimeouts.has(orderId)) return;
  scheduledTimeouts.add(orderId);

  setTimeout(() => {
    check3min(orderId, userConversationId, userPhoneE164, traceId).catch((err) =>
      writeLog('error', 'order', `3min check failed: ${String(err)}`, { traceId, orderId }),
    );
  }, CHECK_3MIN_MS);

  setTimeout(() => {
    check5min(orderId, userConversationId, userPhoneE164, traceId)
      .catch((err) => writeLog('error', 'order', `5min check failed: ${String(err)}`, { traceId, orderId }))
      .finally(() => scheduledTimeouts.delete(orderId));
  }, CHECK_5MIN_MS);
}

/**
 * F1.A3 — RESGATE DURÁVEL. Os timers de 3/5min vivem em memória
 * (scheduleQuoteTimeout); se o processo reinicia no meio (deploy/crash), a
 * consolidação se perde e o pedido fica 'quoting' PARA SEMPRE — o usuário nunca
 * recebe as opções. Este scan roda no worker (consultation-dispatcher, a cada
 * 30s) e consolida qualquer pedido preso em 'quoting' além de RESCUE_WINDOW_MIN.
 * É SEGURO rodar junto com os setTimeouts: consolidateQuotes faz transição
 * atômica quoting→quoted, então quem chegar segundo vira no-op.
 */
export async function rescueOrphanedPharmacyQuotes(): Promise<void> {
  try {
    const cutoff = new Date(Date.now() - RESCUE_WINDOW_MIN * 60_000).toISOString();
    const { data: orders } = await db
      .from('orders')
      .select('id, conversation_id, created_at')
      .eq('status', 'quoting')
      .lt('created_at', cutoff)
      .limit(50);

    for (const o of orders ?? []) {
      try {
        if (!o.conversation_id) continue;
        const { data: conv } = await db
          .from('conversations')
          .select('whatsapp_jid')
          .eq('id', o.conversation_id)
          .single();
        const phone = conv?.whatsapp_jid?.replace('@s.whatsapp.net', '');
        if (!phone) continue;
        const traceId = `rescue-${o.id}`;
        await writeLog('warn', 'order', `Resgatando pedido órfão preso em 'quoting' (>${RESCUE_WINDOW_MIN}min)`, { traceId, orderId: o.id });
        await consolidateQuotesEarly(o.id, o.conversation_id, `+${phone}`, traceId);
      } catch (err) {
        await writeLog('error', 'order', `rescue de pedido falhou: ${String(err).slice(0, 160)}`, { orderId: o.id });
      }
    }
  } catch (err) {
    await writeLog('error', 'order', `rescueOrphanedPharmacyQuotes falhou: ${String(err).slice(0, 160)}`, {});
  }
}

async function check3min(
  orderId: string,
  userConversationId: string,
  userPhoneE164: string,
  traceId: string,
): Promise<void> {
  const { data: order } = await db.from('orders').select('status').eq('id', orderId).single();
  if (!order || order.status !== 'quoting') return;

  const { data: quotes } = await db.from('quotes').select('status').eq('order_id', orderId);
  const quotedCount = (quotes ?? []).filter((q) => q.status === 'quoted').length;

  await db.from('orders').update({ status_3min_sent: true }).eq('id', orderId);

  if (quotedCount >= 3) {
    await writeLog('info', 'order', `3min: ${quotedCount} cotações — consolidando agora`, { traceId, orderId });
    await consolidateQuotesEarly(orderId, userConversationId, userPhoneE164, traceId);
  } else {
    await writeLog('info', 'order', `3min: ${quotedCount} cotação(ões) — aguardando silenciosamente`, { traceId, orderId });
  }
}

async function check5min(
  orderId: string,
  userConversationId: string,
  userPhoneE164: string,
  traceId: string,
): Promise<void> {
  const { data: order } = await db.from('orders').select('status').eq('id', orderId).single();
  if (!order || order.status !== 'quoting') return;

  const { data: quotes } = await db.from('quotes').select('status').eq('order_id', orderId);
  const quotedCount = (quotes ?? []).filter((q) => q.status === 'quoted').length;

  if (quotedCount >= 1) {
    await writeLog('info', 'order', `5min: ${quotedCount} cotação(ões) — consolidando agora`, { traceId, orderId });
    await consolidateQuotesEarly(orderId, userConversationId, userPhoneE164, traceId);
  } else {
    // Sem cotações ainda → modo eager: próxima que chegar consolida imediatamente
    await db.from('orders').update({ status_5min_done: true }).eq('id', orderId);
    await writeLog('info', 'order', '5min: 0 cotações — modo eager ativado', { traceId, orderId });
  }
}

/** Snapshot do estado atual — usado pelo get_order_status da Xarlote e idempotência do start. */
export async function sendCurrentOrderStatus(
  orderId: string,
  userConversationId: string,
  userPhoneE164: string,
  traceId: string,
): Promise<void> {
  const { data: order } = await db.from('orders').select('status').eq('id', orderId).single();
  if (!order) return;

  if (['quoted', 'confirming', 'handed_off'].includes(order.status)) {
    await sendOutbound(
      userConversationId,
      userPhoneE164,
      order.status === 'quoted'
        ? 'Suas cotações já estão prontas! 💙 Olha as opções na nossa última mensagem aí em cima — me diz qual prefere.'
        : 'Seu pedido já foi confirmado com a farmácia escolhida 💙 Se precisar de qualquer coisa é só falar.',
      traceId,
    );
    return;
  }

  const { data: quotes } = await db.from('quotes').select('status').eq('order_id', orderId);
  const total = (quotes ?? []).length;
  const quoted = (quotes ?? []).filter((q) => q.status === 'quoted').length;
  const closed = (quotes ?? []).filter((q) => ['unavailable', 'timeout'].includes(q.status)).length;
  const pending = total - quoted - closed;

  // Tem pelo menos 1 cotação? Consolida agora.
  if (quoted >= 1) {
    await consolidateQuotesEarly(orderId, userConversationId, userPhoneE164, traceId);
    return;
  }

  let msg: string;
  if (total === 0) {
    msg = 'Ainda estou organizando as farmácias daqui 💙 me dá só mais um instantinho.';
  } else if (pending > 0) {
    msg = `Ainda nenhuma resposta com preço, mas ${pending} farmácia${pending > 1 ? 's' : ''} ${pending > 1 ? 'estão' : 'está'} olhando ✨ assim que alguma responder eu te aviso na hora.`;
  } else {
    msg = 'As farmácias que contatei não conseguiram responder dessa vez 😕 Posso tentar de novo em outra região, se você quiser.';
  }
  await sendOutbound(userConversationId, userPhoneE164, msg, traceId);
}

/**
 * Chamado de inbound-supplier após record_quote_price.
 * - Se modo eager (5min sem cotação): consolida imediatamente.
 * - Senão: avisa o usuário que chegou mais uma cotação.
 */
export async function notifyUserQuoteArrived(
  orderId: string,
  supplierName: string,
  traceId: string,
): Promise<void> {
  const { data: order } = await db
    .from('orders')
    .select('status, status_5min_done, conversation_id')
    .eq('id', orderId)
    .single();
  if (!order || order.status !== 'quoting') return;

  const { data: userConv } = await db
    .from('conversations')
    .select('whatsapp_jid')
    .eq('id', order.conversation_id)
    .single();
  const userPhone = userConv?.whatsapp_jid?.replace('@s.whatsapp.net', '');
  if (!userPhone) return;

  const userConversationId = order.conversation_id;
  const userPhoneE164 = `+${userPhone}`;

  // Modo eager: 5 min já passaram sem cotação — consolida imediatamente com o que chegou
  if (order.status_5min_done) {
    await writeLog('info', 'order', `Modo eager: cotação de ${supplierName} disparou consolidação imediata`, { traceId, orderId });
    await consolidateQuotesEarly(orderId, userConversationId, userPhoneE164, traceId);
    return;
  }

  // Modo normal: notifica chegada incremental
  const { data: quotes } = await db.from('quotes').select('status').eq('order_id', orderId);
  const quotedCount = (quotes ?? []).filter((q) => q.status === 'quoted').length;
  const total = (quotes ?? []).length;

  const msg =
    quotedCount === 1
      ? `Boa, recebi a primeira cotação aqui (${supplierName}) 💙 vou aguardar mais umas pra te trazer as melhores opções.`
      : `Mais uma cotação chegando (${supplierName}) — ${quotedCount} de ${total} ✨`;

  await sendOutbound(userConversationId, userPhoneE164, msg, traceId);
}

/** Consolida prematuramente fechando as quotes ainda pendentes. */
async function consolidateQuotesEarly(
  orderId: string,
  userConversationId: string,
  userPhoneE164: string,
  traceId: string,
): Promise<void> {
  // Não force timeout das cotações enquanto uma está aguardando o cliente.
  if (await hasPendingClarification(orderId)) {
    await writeLog('info', 'order', 'Consolidação (early) pausada — aguardando cliente', { traceId, orderId });
    return;
  }
  await db
    .from('quotes')
    .update({ status: 'timeout', completed_at: new Date().toISOString() })
    .eq('order_id', orderId)
    .in('status', ['pending', 'contacting', 'negotiating']);
  await consolidateQuotes(orderId, userConversationId, userPhoneE164, traceId);
}

interface QuoteRow {
  id: string;
  status: string;
  total: number | null;
  subtotal: number | null;
  delivery_fee: number | null;
  eta_minutes: number | null;
  payment_methods: string[] | null;
  pix_key: string | null;
  payment_link: string | null;
  notes: string | null;
  distance_km: number | null;
  supplier_id: string;
}

interface SupplierRow {
  id: string;
  name: string;
}

export async function consolidateQuotes(
  orderId: string,
  userConversationId: string,
  userPhoneE164: string,
  traceId: string,
): Promise<void> {
  // Guard: only consolidate once per order
  const { data: order } = await db.from('orders').select('status').eq('id', orderId).single();
  if (!order || ['quoted', 'confirming', 'handed_off', 'cancelled'].includes(order.status)) return;

  // Loop agêntico: não fecha as opções enquanto uma farmácia espera um dado do
  // cliente (clarificação). Auto-libera após a janela (hasPendingClarification só
  // conta as recentes); o rescue de órfãos garante que nunca trava pra sempre.
  if (await hasPendingClarification(orderId)) {
    await writeLog('info', 'order', 'Consolidação pausada — aguardando resposta do cliente a uma clarificação', { traceId, orderId });
    return;
  }

  // Transição ATÔMICA quoting→quoted: quem chegar em segundo casa 0 linhas e vira
  // no-op — evita apresentar as cotações ao cliente DUAS vezes quando timer/rescue
  // disparam juntos (o .eq('status','quoting') filtrava, mas o código seguia mesmo
  // com 0 linhas afetadas). O .select('id') expõe o count.
  const { data: transitioned } = await db.from('orders')
    .update({ status: 'quoted' }).eq('id', orderId).eq('status', 'quoting').select('id');
  if (!transitioned || transitioned.length === 0) {
    await writeLog('info', 'order', 'Consolidação já em curso/feita por outro processo — no-op', { traceId, orderId });
    return;
  }

  const { data: quotes } = await db
    .from('quotes')
    .select('id, status, total, subtotal, delivery_fee, eta_minutes, payment_methods, pix_key, payment_link, notes, distance_km, supplier_id')
    .eq('order_id', orderId);

  const successful = (quotes ?? []).filter((q) => q.status === 'quoted') as QuoteRow[];

  if (successful.length === 0) {
    await sendOutbound(
      userConversationId,
      userPhoneE164,
      'Infelizmente não consegui cotação em nenhuma farmácia próxima agora 😔 Posso tentar de novo mais tarde ou em uma região diferente?',
      traceId,
    );
    await db.from('orders').update({ status: 'failed' }).eq('id', orderId);
    await writeLog('warn', 'order', 'No successful quotes for order', { traceId, orderId });
    return;
  }

  // Load supplier names
  const supplierIds = successful.map((q) => q.supplier_id);
  const { data: suppliers } = await db.from('suppliers').select('id, name').in('id', supplierIds);
  const supplierMap = new Map<string, string>((suppliers ?? []).map((s: SupplierRow) => [s.id, s.name]));

  // Sort by total price (ascending), show up to 3
  const sorted = [...successful]
    .filter((q) => q.total != null)
    .sort((a, b) => (a.total ?? 999) - (b.total ?? 999))
    .slice(0, 3);

  if (sorted.length === 0) {
    await sendOutbound(
      userConversationId,
      userPhoneE164,
      'As farmácias responderam mas sem preço claro 😕 Posso tentar contato novamente?',
      traceId,
    );
    return;
  }

  // Build message
  const NUMBERS = ['1️⃣', '2️⃣', '3️⃣'];
  const lines: string[] = ['Consegui cotações pra você! 🎉\n'];

  for (let i = 0; i < sorted.length; i++) {
    const q = sorted[i] as QuoteRow;
    const name = supplierMap.get(q.supplier_id) ?? 'Farmácia';
    const total = q.total?.toFixed(2);
    const frete = q.delivery_fee != null ? (q.delivery_fee === 0 ? 'frete grátis' : `frete R$${q.delivery_fee.toFixed(2)}`) : '';
    const eta = q.eta_minutes ? `~${q.eta_minutes}min` : '';
    const payment = (q.payment_methods ?? []).join('/') || 'consulte';
    const pix = q.pix_key ? ` · Pix: ${q.pix_key}` : '';

    const parts = [frete, eta, payment].filter(Boolean).join(' · ');
    lines.push(`${NUMBERS[i] ?? `${i + 1}.`} *${name}* — R$${total}\n   ${parts}${pix}`);
  }

  const unavailableCount = (quotes ?? []).filter((q) => ['unavailable', 'timeout'].includes(q.status)).length;
  if (unavailableCount > 0) {
    lines.push(`\n_(${unavailableCount} farmácia${unavailableCount > 1 ? 's' : ''} não respondeu ou não tinha em estoque)_`);
  }

  lines.push('\nQual você prefere? Pode me dizer o número ou o nome da farmácia 😊');

  await sendOutbound(userConversationId, userPhoneE164, lines.join('\n'), traceId);

  // Store quote options in order summary so Xarlote can reference quote_ids when user picks
  const summaryForLLM = {
    order_id: orderId,
    status: 'quoted',
    options: sorted.map((q, i) => ({
      option: i + 1,
      quote_id: q.id,
      supplier_name: supplierMap.get(q.supplier_id) ?? 'Farmácia',
      total: q.total,
      delivery_fee: q.delivery_fee,
      eta_minutes: q.eta_minutes,
      payment_methods: q.payment_methods,
      pix_key: q.pix_key,
      payment_link: q.payment_link,
    })),
    instructions: 'Quando o usuário escolher uma opção (ex: "quero a 1", "prefiro a Droga Raia", "pode ser a mais barata"), identifique qual option corresponde e chame confirm_order_selection com o order_id e o quote_id corretos.',
  };

  await db.from('orders').update({
    summary: JSON.stringify(summaryForLLM, null, 2),
  }).eq('id', orderId);

  await writeLog('info', 'order', `Consolidated ${sorted.length} quotes for order`, {
    traceId, orderId, quotes: sorted.length,
  });
}
