import { db, writeLog } from '@iasaude/db';
import { sendOutbound } from './outbound.js';
import { sendOutboundToSupplier } from './outbound-agent.js';

/**
 * Loop agêntico resolutivo (Fase 4).
 *
 * Quando a farmácia/clínica precisa de um dado do paciente pra continuar
 * (ex.: "é plano ou particular?"), o agente chama `request_clarification`.
 * Em vez de descartar (era no-op), a Xarlote:
 *   1. marca a cotação como `awaiting_user` e leva a pergunta ao CLIENTE (sara);
 *   2. pausa a consolidação enquanto aguarda (gate por tempo — nunca trava pra
 *      sempre: o rescue de pedidos órfãos assume após a janela);
 *   3. quando o cliente responde, devolve a resposta ao estabelecimento e a
 *      negociação continua de onde parou.
 */

// Janela em que a consolidação espera o cliente. Depois disso o gate libera e o
// rescue (>10min) assume — garante que um cliente que some não trava o pedido.
const CLARIFICATION_WAIT_MIN = 8;

export interface PendingClarification {
  quoteId: string;
  orderId: string;
  question: string;
  supplierConversationId: string;
  supplierPhone: string;
  supplierName: string;
}

/** O estabelecimento pediu um dado do paciente → marca a cotação e leva a pergunta ao cliente. */
export async function relaySupplierQuestionToUser(
  quote: { id: string; order_id: string; conversation_id: string | null; suppliers?: { name?: string } | null },
  question: string,
  traceId: string,
): Promise<void> {
  await db.from('quotes').update({
    clarification_status: 'awaiting_user',
    clarification_question: question,
    clarification_asked_at: new Date().toISOString(),
  }).eq('id', quote.id);

  // Conversa + telefone do CLIENTE (via order.conversation_id)
  const { data: order } = await db.from('orders').select('conversation_id').eq('id', quote.order_id).single();
  if (!order?.conversation_id) {
    await writeLog('warn', 'clarification', 'Pedido sem conversa do cliente — não dá pra levar a pergunta', { traceId, quoteId: quote.id });
    return;
  }
  const { data: userConv } = await db.from('conversations').select('whatsapp_jid').eq('id', order.conversation_id).single();
  const digits = userConv?.whatsapp_jid?.replace('@s.whatsapp.net', '');
  if (!digits) return;

  const supplierName = quote.suppliers?.name ?? 'a farmácia';
  const msg = `Oi! Pra fechar seu pedido com ${supplierName}, preciso confirmar uma coisinha: ${question}`;
  await sendOutbound(order.conversation_id, `+${digits}`, msg, traceId);
  await writeLog('info', 'clarification', `❓ Pergunta da farmácia levada ao cliente: "${question.slice(0, 80)}"`, { traceId, quoteId: quote.id });
}

/** Há clarificação pendente (e ainda dentro da janela de espera) pra esse pedido? Gate da consolidação. */
export async function hasPendingClarification(orderId: string): Promise<boolean> {
  const cutoff = new Date(Date.now() - CLARIFICATION_WAIT_MIN * 60_000).toISOString();
  const { data } = await db
    .from('quotes')
    .select('id')
    .eq('order_id', orderId)
    .eq('clarification_status', 'awaiting_user')
    .gt('clarification_asked_at', cutoff)
    .limit(1);
  return (data?.length ?? 0) > 0;
}

/** Acha a clarificação pendente do pedido ativo deste cliente (pro inbound do user). */
export async function findPendingClarificationForUser(userConversationId: string): Promise<PendingClarification | null> {
  const { data: orders } = await db
    .from('orders')
    .select('id')
    .eq('conversation_id', userConversationId)
    .in('status', ['quoting', 'quoted', 'confirming']);
  const orderIds = (orders ?? []).map((o) => o.id);
  if (!orderIds.length) return null;

  const { data: quotes } = await db
    .from('quotes')
    .select('id, order_id, conversation_id, clarification_question, suppliers(name, whatsapp_e164, phone_e164)')
    .in('order_id', orderIds)
    .eq('clarification_status', 'awaiting_user')
    .order('clarification_asked_at', { ascending: false })
    .limit(1);
  const q = quotes?.[0];
  if (!q) return null;

  // Telefone da farmácia: conversa do fornecedor (whatsapp_jid) ou cadastro.
  let supplierPhone = '';
  if (q.conversation_id) {
    const { data: supConv } = await db.from('conversations').select('whatsapp_jid').eq('id', q.conversation_id).single();
    const digits = supConv?.whatsapp_jid?.replace('@s.whatsapp.net', '');
    if (digits) supplierPhone = `+${digits}`;
  }
  const sup = q.suppliers as { name?: string; whatsapp_e164?: string; phone_e164?: string } | null;
  if (!supplierPhone) supplierPhone = sup?.whatsapp_e164 ?? sup?.phone_e164 ?? '';

  return {
    quoteId: q.id,
    orderId: q.order_id,
    question: q.clarification_question ?? '',
    supplierConversationId: q.conversation_id ?? '',
    supplierPhone,
    supplierName: sup?.name ?? 'a farmácia',
  };
}

/** O cliente respondeu → marca a cotação como `answered` e devolve a resposta ao estabelecimento. */
export async function relayUserAnswerToSupplier(
  userConversationId: string,
  answer: string,
  traceId: string,
): Promise<{ relayed: boolean; supplierName?: string }> {
  const pending = await findPendingClarificationForUser(userConversationId);
  if (!pending) return { relayed: false };

  await db.from('quotes').update({
    clarification_status: 'answered',
    clarification_answer: answer,
    clarification_answered_at: new Date().toISOString(),
  }).eq('id', pending.quoteId);

  if (pending.supplierConversationId && pending.supplierPhone) {
    await sendOutboundToSupplier(
      pending.supplierConversationId,
      pending.supplierPhone,
      `Sobre o que você perguntou: ${answer}`,
      traceId,
    );
  }
  await writeLog('info', 'clarification', `✅ Resposta do cliente devolvida à farmácia: "${answer.slice(0, 80)}"`, { traceId, quoteId: pending.quoteId });
  return { relayed: true, supplierName: pending.supplierName };
}
