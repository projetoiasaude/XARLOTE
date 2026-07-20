import { db, writeLog } from '@iasaude/db';
import { sanitizeSupplierNote, noteSignalsConditionalOffer, formatOrderTotal } from '@iasaude/shared';
import { sendOutbound } from './outbound.js';
import { hasPendingClarification } from './clarification.js';

const CHECK_3MIN_MS = 3 * 60 * 1000;
const CHECK_5MIN_MS = 5 * 60 * 1000;
const PROGRESS_NOTE_MS = 10 * 60 * 1000; // aviso honesto de "ainda aguardando"
const scheduledTimeouts = new Set<string>();

// JANELA REAL DE COTAÇÃO (recalibrada com dados do 1º dia real: 19/20 cotações
// morreram no muro de 10min — farmácia de verdade demora 15-60min pra responder
// WhatsApp). O pedido fica aberto até aqui; o modo eager (5min) consolida na
// PRIMEIRA resposta que chegar, então janela longa NÃO atrasa quem responde rápido.
const QUOTE_WINDOW_MIN = Number(
  process.env['PHARMACY_QUOTE_WINDOW_MIN'] ?? process.env['PHARMACY_RESCUE_WINDOW_MIN'] ?? 45,
);
const RESCUE_WINDOW_MIN = QUOTE_WINDOW_MIN;
// Assim que houver >=N cotações prontas, apresenta JÁ (event-driven, não espera timer).
// Incidente Vadivino: 2 cotações em mãos às 15:12 mas as opções só apareceram às 15:52
// (timeout de 60min) — o cliente esperou 40min à toa. Velocidade > completude (fundador).
const EAGER_PRESENT_COUNT = Number(process.env['PHARMACY_EAGER_PRESENT_COUNT'] ?? 2);

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
  force = false,
): void {
  // force (expand): re-arma os timers pro pedido reaberto mesmo que já tenham rodado antes.
  if (force) scheduledTimeouts.delete(orderId);
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

  // 10min sem NENHUMA resposta → aviso honesto de progresso (uma vez). A janela
  // real segue aberta (QUOTE_WINDOW_MIN); farmácia costuma demorar. Sem isso o
  // usuário ficava no vácuo achando que a Xarlote esqueceu dele.
  setTimeout(() => {
    void (async () => {
      const { data: order } = await db.from('orders').select('status').eq('id', orderId).single();
      if (!order || order.status !== 'quoting') return;
      const { data: quotes } = await db.from('quotes').select('status').eq('order_id', orderId);
      if ((quotes ?? []).some((q) => q.status === 'quoted')) return;
      await sendOutbound(
        userConversationId,
        userPhoneE164,
        'As farmácias ainda não responderam — elas costumam demorar um pouquinho no WhatsApp 🙏 Sigo insistindo aqui e te aviso na hora em que a primeira resposta chegar!',
        traceId,
      );
    })().catch((err) => writeLog('warn', 'order', `progress note failed: ${String(err)}`, { traceId, orderId }));
  }, PROGRESS_NOTE_MS);
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
    const windowAgo = new Date(Date.now() - RESCUE_WINDOW_MIN * 60_000).toISOString();
    const fiveMinAgo = new Date(Date.now() - CHECK_5MIN_MS).toISOString();

    // (A) JANELA FECHADA (>RESCUE_WINDOW): consolida com o que tiver (mesmo 0 cotações → msg honesta).
    const { data: expired } = await db
      .from('orders')
      .select('id, conversation_id, created_at')
      .eq('status', 'quoting')
      .lt('created_at', windowAgo)
      .limit(50);

    // (B) TIMER PERDIDO (review M2 — durabiliza a consolidação): um deploy/crash apaga os setTimeout
    // de 3/5min (vivem em memória); um pedido com cotação JÁ PRONTA que perdeu o timer esperaria os
    // 45min do passo (A). Aqui pegamos os que já passaram do ponto de 5min E têm ≥1 cotação 'quoted' e
    // consolidamos em ≤30s (próximo tick do worker). Casa a regra do check5min; idempotente (CAS
    // quoting→quoted, então rodar junto com um timer sobrevivente vira no-op). Faixa [5min, janela).
    const { data: staleWithQuotes } = await db
      .from('orders')
      .select('id, conversation_id, created_at, quotes!inner(status)')
      .eq('status', 'quoting')
      .lt('created_at', fiveMinAgo)
      .gte('created_at', windowAgo)
      .eq('quotes.status', 'quoted')
      .limit(50);

    // dedup por id (as bandas de tempo são disjuntas, mas o Map protege de qualquer sobreposição).
    const byId = new Map<string, { id: string; conversation_id: string | null }>();
    for (const o of expired ?? []) byId.set(o.id, { id: o.id, conversation_id: o.conversation_id });
    for (const o of staleWithQuotes ?? []) byId.set(o.id, { id: o.id, conversation_id: o.conversation_id });

    for (const o of byId.values()) {
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
        await writeLog('warn', 'order', `Resgatando pedido preso em 'quoting' (timer perdido ou janela fechada)`, { traceId, orderId: o.id });
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
  const { data: order } = await db.from('orders').select('status, created_at').eq('id', orderId).single();
  if (!order || order.status !== 'quoting') return;

  const { data: quotes } = await db.from('quotes').select('status, created_at').eq('order_id', orderId);
  const roundStart = new Date(order.created_at as string).getTime();
  const quotedCount = (quotes ?? []).filter((q) => q.status === 'quoted' && new Date(q.created_at as string).getTime() >= roundStart).length;

  await db.from('orders').update({ status_3min_sent: true }).eq('id', orderId);

  if (quotedCount >= EAGER_PRESENT_COUNT) {
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
      {},
      // Dedup: se o usuário pressiona ("e aí?") várias vezes seguidas, não repete a
      // MESMA frase "olha acima" a cada 5s (era parte do delírio no incidente Cefaliv).
      { dedup: true, dedupWindowMs: 20_000 },
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
    .select('status, status_5min_done, conversation_id, created_at')
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
  const { data: quotes } = await db.from('quotes').select('status, created_at').eq('order_id', orderId);
  const quotedCount = (quotes ?? []).filter((q) => q.status === 'quoted').length;
  const total = (quotes ?? []).length;
  // Cotações da RODADA ATUAL (expand reseta orders.created_at → cotações antigas ficam de fora).
  // Sem isto, o eager-present dispararia com as cotações VELHAS logo após um expand, matando
  // as farmácias novas antes de responderem (review 09/07).
  const roundStart = new Date(order.created_at as string).getTime();
  const quotedThisRound = (quotes ?? []).filter((q) => q.status === 'quoted' && new Date(q.created_at as string).getTime() >= roundStart).length;

  // EAGER PRESENT: com >=2 cotações DA RODADA em mãos, apresenta JÁ (não espera o timer).
  if (quotedThisRound >= EAGER_PRESENT_COUNT) {
    await writeLog('info', 'order', `${quotedThisRound} cotações da rodada em mãos — consolidando já (eager present)`, { traceId, orderId });
    await consolidateQuotesEarly(orderId, userConversationId, userPhoneE164, traceId);
    return;
  }

  const msg =
    quotedCount === 1
      ? `Boa, recebi a primeira cotação aqui (${supplierName}) 💙 vou aguardar mais umas pra te trazer as melhores opções.`
      : `Mais uma cotação chegando (${supplierName}) — ${quotedCount} de ${total} ✨`;

  await sendOutbound(userConversationId, userPhoneE164, msg, traceId);
}

/**
 * 💰 COTAÇÃO MELHOR PÓS-APRESENTAÇÃO (incidente Glauber 12/07): as opções já foram
 * mostradas (order 'quoted') mas o cliente AINDA não confirmou, e chega uma cotação MAIS
 * BARATA. Antes, notifyUserQuoteArrived saía cedo (status != 'quoting') e a opção melhor
 * era ENGOLIDA — o Glauber confirmou a Portal (R$42,90) 45s depois da Extra Mais (R$40,
 * frete grátis) chegar, sem nunca vê-la. Agora: avisa o cliente E anexa a nova opção ao
 * summary (pra ele conseguir escolher por nome). Silencioso se a nova não for mais barata.
 */
// Throttle: no máx 1 aviso "opção melhor" por pedido a cada 5min (evita rajada de avisos
// quando várias cotações mais baratas chegam em sequência). Estado local do processo.
const betterQuotePingSeen = new Map<string, number>();
const BETTER_QUOTE_COOLDOWN_MS = 5 * 60_000;

export async function notifyBetterQuoteIfPresented(
  orderId: string,
  newQuoteId: string,
  traceId: string,
): Promise<void> {
  const { data: order } = await db
    .from('orders')
    .select('status, selected_quote_id, summary, conversation_id')
    .eq('id', orderId)
    .maybeSingle();
  // Só quando JÁ apresentado ('quoted') e AINDA não escolhido.
  if (!order || order.status !== 'quoted' || order.selected_quote_id || !order.summary) return;

  const originalSummary = order.summary as string;
  let summary: { options?: Array<{ option: number; quote_id: string; supplier_name?: string; total?: number; delivery_fee?: number | null }> };
  try { summary = JSON.parse(originalSummary); } catch { return; }
  const options = summary.options ?? [];
  if (!options.length) return;
  if (options.some((o) => o.quote_id === newQuoteId)) return; // já apresentada

  const { data: nq } = await db
    .from('quotes')
    .select('id, total, delivery_fee, supplier_id, suppliers(name)')
    .eq('id', newQuoteId)
    .maybeSingle();
  if (!nq || nq.total == null) return;
  const newTotal = Number(nq.total);
  const newFee = nq.delivery_fee == null ? null : Number(nq.delivery_fee);

  // COMPARAÇÃO HONESTA (review 12/07): só avisa se o REMÉDIO for estritamente mais barato E
  // nenhuma opção já apresentada com frete CONHECIDO tiver efetivo ≤ o efetivo (melhor caso)
  // da nova — senão uma "mais barata no remédio" com frete alto pareceria melhor sem ser.
  const minPresentedTotal = Math.min(...options.map((o) => (o.total == null ? Infinity : Number(o.total))));
  if (!(newTotal < minPresentedTotal)) return;
  const newEffBestCase = newTotal + (newFee ?? 0);
  const presentedEffKnown = Math.min(
    Infinity,
    ...options
      .filter((o) => o.delivery_fee != null && o.total != null)
      .map((o) => Number(o.total) + Number(o.delivery_fee)),
  );
  if (newEffBestCase >= presentedEffKnown) return; // uma apresentada com frete conhecido já é ≤

  const supName = (nq.suppliers as { name?: string } | null)?.name ?? 'outra farmácia';

  // Anexa ao summary de forma ATÔMICA (CAS pela string original — review 12/07: 2 cotações
  // gravando quase juntas perdiam uma no read-modify-write). Se outra atualização entrou no
  // meio, não sobrescreve (o aviso ainda sai; a próxima passada anexa).
  const nextOption = Math.max(0, ...options.map((o) => o.option)) + 1;
  options.push({ option: nextOption, quote_id: nq.id as string, supplier_name: supName, total: newTotal, delivery_fee: newFee });
  summary.options = options;
  await db.from('orders')
    .update({ summary: JSON.stringify(summary, null, 2) })
    .eq('id', orderId)
    .eq('summary', originalSummary);

  // Throttle do AVISO (não do append): no máx 1 ping / 5min por pedido.
  const nowMs = Date.now();
  // Prune entradas velhas (evita leak — o Map só cresce por pedido com opção melhor).
  for (const [k, ts] of betterQuotePingSeen) if (nowMs - ts >= BETTER_QUOTE_COOLDOWN_MS) betterQuotePingSeen.delete(k);
  const last = betterQuotePingSeen.get(orderId) ?? 0;
  if (nowMs - last < BETTER_QUOTE_COOLDOWN_MS) {
    await writeLog('info', 'order', `Cotação mais barata anexada ao summary, mas aviso throttled (<5min do último) — ${supName}`, { traceId, orderId });
    return;
  }
  betterQuotePingSeen.set(orderId, Date.now());

  const userPhone = await userPhoneForOrder(order.conversation_id as string);
  if (!userPhone) return;
  const freteTxt = newFee === 0 ? ', com frete grátis' : (newFee != null ? `, frete R$${newFee.toFixed(2)}` : ' (frete a confirmar)');
  await sendOutbound(
    order.conversation_id as string,
    userPhone,
    `Opa, chegou uma opção com o remédio mais barato: *${supName}* por R$${newTotal.toFixed(2)}${freteTxt} 💙 Quer trocar pra ela? É só me dizer o nome — ou seguimos com a que você já ia escolher.`,
    traceId,
  );
  await writeLog('info', 'order', `💰 Cotação mais barata pós-apresentação avisada (${supName} R$${newTotal} < R$${minPresentedTotal})`, {
    traceId, orderId, newQuoteId,
  });
}

/** Telefone E.164 do cliente a partir da conversa do pedido. */
async function userPhoneForOrder(conversationId: string): Promise<string | null> {
  const { data: c } = await db.from('conversations').select('whatsapp_jid').eq('id', conversationId).maybeSingle();
  const digits = (c?.whatsapp_jid as string | null)?.replace('@s.whatsapp.net', '');
  return digits ? `+${digits}` : null;
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
  // Guard: only consolidate once per order. Inclui 'failed' (review Cefaliv): um pedido
  // já 'failed' era re-consolidado e re-mandava "não consegui cotação" várias vezes.
  const { data: order } = await db.from('orders').select('status').eq('id', orderId).single();
  if (!order || ['quoted', 'confirming', 'handed_off', 'cancelled', 'failed'].includes(order.status)) return;

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
    // MINI-RELATÓRIO honesto (incidente São Benedito 07/07): em vez do "não consegui"
    // chapado, conta o que CADA farmácia disse — e, se alguma respondeu de forma útil
    // (tem o item / ofereceu alternativa), oferece re-engajar aquela (message_supplier)
    // ou ampliar o raio. Sanitiza a nota pra não vazar marcador interno.
    const allQuotes = (quotes ?? []) as QuoteRow[];
    const supIds = [...new Set(allQuotes.map((q) => q.supplier_id))];
    const { data: sups } = await db.from('suppliers').select('id, name').in('id', supIds);
    const nameOf = new Map<string, string>((sups ?? []).map((s: SupplierRow) => [s.id, s.name]));

    await sendOutbound(userConversationId, userPhoneE164, buildFailureReport(allQuotes, nameOf), traceId);
    await db.from('orders').update({ status: 'failed' }).eq('id', orderId);
    await writeLog('warn', 'order', 'No successful quotes for order', { traceId, orderId, total: allQuotes.length });
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
    // TOTAL FINAL = remédios + frete (auditoria 1º pedido: antes mostrava só os remédios e o
    // frete solto, o cliente via "R$28,89" mas pagava R$35,89). frete null = "a confirmar" (NÃO
    // vira "grátis" — mentira, caso Hiago 06/07); 0 = grátis; >0 = somado no total.
    const totalStr = formatOrderTotal(q.total, q.delivery_fee);
    const eta = q.eta_minutes ? `~${q.eta_minutes}min` : '';
    const payment = (q.payment_methods ?? []).join('/') || 'consulte';
    const pix = q.pix_key ? ` · Pix: ${q.pix_key}` : '';

    const parts = [eta, payment].filter(Boolean).join(' · ');
    // Substituição de apresentação (Fix #3): SÓ do marcador canônico "subst:só tem N comp"
    // que o fallback determinístico grava — nunca de texto livre do LLM (que poderia
    // vazar nota interna truncada tipo "só tem plano Unimed" ao usuário; review).
    const substMatch = (q.notes ?? '').match(/subst:\s*(só tem \d+\s*comp)/i);
    const subst = substMatch ? `\n   ⚠️ ${(substMatch[1] as string).trim()}` : '';
    lines.push(`${NUMBERS[i] ?? `${i + 1}.`} *${name}* — ${totalStr}\n   ${parts}${pix}${subst}`);
  }

  const unavailableCount = (quotes ?? []).filter((q) => ['unavailable', 'timeout'].includes(q.status)).length;
  if (unavailableCount > 0) {
    const plural = unavailableCount > 1;
    const verb = plural ? 'não responderam ou não tinham em estoque' : 'não respondeu ou não tinha em estoque';
    lines.push(`\n_(${unavailableCount} farmácia${plural ? 's' : ''} ${verb})_`);
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

  // O `summary` vai SOZINHO: se ele falhar junto de outra coluna, as opções ficam
  // apresentadas ao paciente mas invisíveis pro LLM e pro backstop (nenhuma escolha
  // resolveria). Update separado = uma falha não leva a outra junto (review).
  await db.from('orders').update({
    summary: JSON.stringify(summaryForLLM, null, 2),
  }).eq('id', orderId);

  // `presented_at` = o instante em que o paciente VIU as opções. É a âncora de CONSENTIMENTO:
  // um aceite genérico ("ok"/"sim") só pode fechar o pedido se for resposta a ESTA apresentação
  // (ver backstop 11b em inbound-user.ts). Sem essa âncora, um "ok" sobre outro assunto dias
  // depois fechava a compra — incidente Vadivino 17/07.
  // ⚠️ Usa o created_at da PRÓPRIA mensagem de apresentação (relógio do Postgres), não
  // `new Date()` (relógio do Node): com skew entre os dois, a própria apresentação contaria
  // como "mensagem posterior" e TODO aceite genérico morreria em silêncio (review).
  const { data: presMsg } = await db.from('messages')
    .select('created_at')
    .eq('conversation_id', userConversationId)
    .eq('direction', 'out')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  await db.from('orders').update({
    presented_at: (presMsg?.created_at as string | undefined) ?? new Date().toISOString(),
  }).eq('id', orderId);

  await writeLog('info', 'order', `Consolidated ${sorted.length} quotes for order`, {
    traceId, orderId, quotes: sorted.length,
  });
}

/**
 * Relatório honesto quando 0 farmácias cotaram (incidente São Benedito 07/07): conta o
 * que CADA farmácia disse, em vez do "não consegui" chapado. As que responderam com nota
 * útil (tem o item / ressalva / ofereceu alternativa) são surfaceadas; se houver resposta
 * CONDICIONAL, a Xarlote oferece re-engajar aquela farmácia (via message_supplier) OU
 * ampliar o raio. Tom humano (1-3 frases), sem vazar nota interna (sanitizeSupplierNote).
 */
function buildFailureReport(quotes: QuoteRow[], nameOf: Map<string, string>): string {
  const total = quotes.length;
  const responders: { name: string; note: string; conditional: boolean }[] = [];
  let noReturn = 0;
  for (const q of quotes) {
    const name = nameOf.get(q.supplier_id) ?? 'uma farmácia';
    // Só nota de 'unavailable' vira relato (timeout/pending não têm o que dizer). Sanitiza
    // pra não vazar marcador interno; se sobrar vazio, conta como "sem retorno".
    const note = q.status === 'unavailable' ? sanitizeSupplierNote(q.notes) : '';
    if (note) responders.push({ name, note, conditional: noteSignalsConditionalOffer(q.notes) });
    else noReturn++;
  }

  if (responders.length === 0) {
    const head = total > 0
      ? `Falei com ${total} farmácia${total > 1 ? 's' : ''}, mas nenhuma respondeu ainda 😔`
      : 'Ainda não consegui resposta de nenhuma farmácia 😔';
    return `${head} Quer que eu procure num raio maior? É só me dizer que eu amplio a busca na hora 🔎`;
  }

  const parts = responders.map((r) => `na *${r.name}*: ${r.note}`);
  const respStr = parts.length === 1
    ? (parts[0] as string)
    : `${parts.slice(0, -1).join('; ')}; e ${parts[parts.length - 1] as string}`;
  const outras = noReturn > 0 ? ` As outras ${noReturn} não deram retorno.` : '';

  const conditionals = responders.filter((r) => r.conditional);
  let offer: string;
  if (conditionals.length === 1) {
    offer = `Quer que eu volte na *${(conditionals[0] as { name: string }).name}* pra tentar acertar isso, ou prefere que eu procure num raio maior?`;
  } else if (conditionals.length > 1) {
    offer = 'Quer que eu volte em alguma delas pra tentar acertar, ou prefere que eu procure num raio maior?';
  } else {
    offer = 'Nenhuma fechou dessa vez 😔 Quer que eu procure num raio maior?';
  }
  return `Falei com ${total} farmácia${total > 1 ? 's' : ''} — ${respStr}.${outras}\n\n${offer}`;
}
