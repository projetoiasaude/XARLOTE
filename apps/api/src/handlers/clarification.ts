import { db, writeLog } from '@iasaude/db';
import { formatSupplierRelayToUser } from '@iasaude/shared';
import { sendOutbound } from './outbound.js';
import { sendOutboundToSupplier, sendOutboundToClinic } from './outbound-agent.js';

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
 *
 * Dois estabelecimentos, mesma mecânica:
 *   - FARMÁCIA: `quotes` (FK order_id → orders → conversation do cliente) → devolve
 *     a resposta via `sendOutboundToSupplier`.
 *   - CLÍNICA:  `consultation_quotes` (FK consultation_id → consultations → conversation
 *     do cliente) → devolve via `sendOutboundToClinic`.
 * As funções abaixo são espelhos explícitos (mesmo padrão do resto do código:
 * inbound-supplier ↔ agent-clinic, quote-consolidation ↔ consultation-consolidation).
 */

// Janela em que a consolidação espera o cliente. Depois disso o gate libera e o
// rescue (>10min) assume — garante que um cliente que some não trava o pedido.
const CLARIFICATION_WAIT_MIN = 8;

export type EstablishmentKind = 'pharmacy' | 'clinic';

export interface PendingClarification {
  kind: EstablishmentKind;
  /** id da cotação (quotes.id ou consultation_quotes.id, conforme `kind`) */
  quoteId: string;
  /** id do pedido-pai: orders.id (farmácia) ou consultations.id (clínica) */
  orderId: string;
  question: string;
  supplierConversationId: string;
  supplierPhone: string;
  supplierName: string;
}

// ─── FARMÁCIA ────────────────────────────────────────────────────────────────

/** A farmácia pediu um dado do paciente → marca a cotação e leva a pergunta ao cliente. */
export async function relaySupplierQuestionToUser(
  quote: { id: string; order_id: string; conversation_id: string | null; suppliers?: { name?: string } | null },
  question: string,
  traceId: string,
): Promise<void> {
  // Fix #2 (freeze): pedido já DECIDIDO (usuário escolheu / confirmou) → NÃO reabre a
  // decisão levando pergunta de uma farmácia retardatária ao usuário. Espelha o guard
  // de record_referral (só age em 'quoting'/'quoted'). Também barra clarificação de
  // uma quote que NÃO é a escolhida quando já há selected_quote_id.
  const { data: ordStatus } = await db.from('orders').select('conversation_id, status, selected_quote_id').eq('id', quote.order_id).single();
  if (!ordStatus?.conversation_id) {
    await writeLog('warn', 'clarification', 'Pedido sem conversa do cliente — não dá pra levar a pergunta', { traceId, quoteId: quote.id });
    return;
  }
  if (['confirming', 'handed_off', 'cancelled', 'failed'].includes(ordStatus.status) ||
      (ordStatus.selected_quote_id && ordStatus.selected_quote_id !== quote.id)) {
    await writeLog('info', 'clarification', `Pergunta da farmácia IGNORADA — pedido já decidido (status=${ordStatus.status})`, { traceId, quoteId: quote.id, orderId: quote.order_id });
    return;
  }

  await db.from('quotes').update({
    clarification_status: 'awaiting_user',
    clarification_question: question,
    clarification_asked_at: new Date().toISOString(),
  }).eq('id', quote.id);

  // Conversa + telefone do CLIENTE (via order.conversation_id)
  const order = ordStatus;
  if (!order?.conversation_id) {
    await writeLog('warn', 'clarification', 'Pedido sem conversa do cliente — não dá pra levar a pergunta', { traceId, quoteId: quote.id });
    return;
  }
  const { data: userConv } = await db.from('conversations').select('whatsapp_jid').eq('id', order.conversation_id).single();
  const digits = userConv?.whatsapp_jid?.replace('@s.whatsapp.net', '');
  if (!digits) {
    await writeLog('warn', 'clarification', 'Sem telefone do cliente — pergunta da farmácia NÃO foi levada (cotação já marcada awaiting_user)', { traceId, quoteId: quote.id });
    return;
  }

  const supplierName = quote.suppliers?.name ?? 'a farmácia';
  const msg = formatSupplierRelayToUser(supplierName, question);
  // dedup 90s: a mesma pergunta da mesma farmácia não deve chegar duplicada ao cliente
  // (incidente: "só tem genérico, serve?" saiu 2× em 16s).
  await sendOutbound(order.conversation_id, `+${digits}`, msg, traceId, {}, { dedup: true, dedupWindowMs: 90_000 });
  await writeLog('info', 'clarification', `❓ Pergunta da farmácia levada ao cliente: "${question.slice(0, 80)}"`, { traceId, quoteId: quote.id });
}

// ─── CLÍNICA ─────────────────────────────────────────────────────────────────

/** A clínica pediu um dado do paciente → marca a cotação de consulta e leva a pergunta ao cliente. */
export async function relayClinicQuestionToUser(
  quote: { id: string; consultation_id: string; conversation_id: string | null; clinics?: { name?: string } | null },
  question: string,
  traceId: string,
): Promise<void> {
  await db.from('consultation_quotes').update({
    clarification_status: 'awaiting_user',
    clarification_question: question,
    clarification_asked_at: new Date().toISOString(),
  }).eq('id', quote.id);

  // Conversa + telefone do CLIENTE (via consultation.conversation_id)
  const { data: consultation } = await db.from('consultations').select('conversation_id').eq('id', quote.consultation_id).single();
  if (!consultation?.conversation_id) {
    await writeLog('warn', 'clarification', 'Consulta sem conversa do cliente — não dá pra levar a pergunta', { traceId, quoteId: quote.id });
    return;
  }
  const { data: userConv } = await db.from('conversations').select('whatsapp_jid').eq('id', consultation.conversation_id).single();
  const digits = userConv?.whatsapp_jid?.replace('@s.whatsapp.net', '');
  if (!digits) {
    await writeLog('warn', 'clarification', 'Sem telefone do cliente — pergunta da clínica NÃO foi levada (cotação já marcada awaiting_user)', { traceId, quoteId: quote.id });
    return;
  }

  const clinicName = quote.clinics?.name ?? 'a clínica';
  const msg = formatSupplierRelayToUser(clinicName, question);
  await sendOutbound(consultation.conversation_id, `+${digits}`, msg, traceId, {}, { dedup: true, dedupWindowMs: 90_000 });
  await writeLog('info', 'clarification', `❓ Pergunta da clínica levada ao cliente: "${question.slice(0, 80)}"`, { traceId, quoteId: quote.id });
}

// ─── Gates de consolidação (por estabelecimento) ─────────────────────────────

/** Há clarificação pendente (e dentro da janela) pra esse PEDIDO de farmácia? Gate da consolidação. */
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

/** Há clarificação pendente (e dentro da janela) pra essa CONSULTA? Gate da consolidação da clínica. */
export async function hasPendingClinicClarification(consultationId: string): Promise<boolean> {
  const cutoff = new Date(Date.now() - CLARIFICATION_WAIT_MIN * 60_000).toISOString();
  const { data } = await db
    .from('consultation_quotes')
    .select('id')
    .eq('consultation_id', consultationId)
    .eq('clarification_status', 'awaiting_user')
    .gt('clarification_asked_at', cutoff)
    .limit(1);
  return (data?.length ?? 0) > 0;
}

// ─── Lookup unificado (pro inbound do user) ──────────────────────────────────

/** Telefone do estabelecimento: conversa (whatsapp_jid) ou cadastro. */
async function resolveEstablishmentPhone(
  conversationId: string | null,
  fallback: { whatsapp_e164?: string; phone_e164?: string } | null,
): Promise<string> {
  if (conversationId) {
    const { data: conv } = await db.from('conversations').select('whatsapp_jid').eq('id', conversationId).single();
    const digits = conv?.whatsapp_jid?.replace('@s.whatsapp.net', '');
    if (digits) return `+${digits}`;
  }
  return fallback?.whatsapp_e164 ?? fallback?.phone_e164 ?? '';
}

/** Pendência + quando foi perguntada — `_askedAt` é interno, só pro desempate temporal. */
type PendingWithTime = PendingClarification & { _askedAt: string };

/** Clarificação pendente de FARMÁCIA pro pedido ativo deste cliente. */
async function findPendingPharmacyClarification(userConversationId: string): Promise<PendingWithTime | null> {
  // Fix #2 (freeze): NÃO inclui 'confirming'/'handed_off' — pedido já decidido não
  // deve reinjetar "PERGUNTA PENDENTE" e pedir relay (a escolha já foi feita).
  const { data: orders } = await db
    .from('orders')
    .select('id')
    .eq('conversation_id', userConversationId)
    .in('status', ['quoting', 'quoted']);
  const orderIds = (orders ?? []).map((o) => o.id);
  if (!orderIds.length) return null;

  const { data: quotes } = await db
    .from('quotes')
    .select('id, order_id, conversation_id, clarification_question, clarification_asked_at, suppliers(name, whatsapp_e164, phone_e164)')
    .in('order_id', orderIds)
    .eq('clarification_status', 'awaiting_user')
    .order('clarification_asked_at', { ascending: false })
    .limit(1);
  const q = quotes?.[0];
  if (!q) return null;

  const sup = q.suppliers as { name?: string; whatsapp_e164?: string; phone_e164?: string } | null;
  return {
    kind: 'pharmacy',
    quoteId: q.id,
    orderId: q.order_id,
    question: q.clarification_question ?? '',
    supplierConversationId: q.conversation_id ?? '',
    supplierPhone: await resolveEstablishmentPhone(q.conversation_id, sup),
    supplierName: sup?.name ?? 'a farmácia',
    _askedAt: q.clarification_asked_at ?? '',
  };
}

/** Clarificação pendente de CLÍNICA pra consulta ativa deste cliente. */
async function findPendingClinicClarification(userConversationId: string): Promise<PendingWithTime | null> {
  const { data: consultations } = await db
    .from('consultations')
    .select('id')
    .eq('conversation_id', userConversationId)
    .in('status', ['searching', 'quoting', 'quoted', 'confirming']);
  const consultationIds = (consultations ?? []).map((c) => c.id);
  if (!consultationIds.length) return null;

  const { data: quotes } = await db
    .from('consultation_quotes')
    .select('id, consultation_id, conversation_id, clarification_question, clarification_asked_at, clinics(name, whatsapp_e164, phone_e164)')
    .in('consultation_id', consultationIds)
    .eq('clarification_status', 'awaiting_user')
    .order('clarification_asked_at', { ascending: false })
    .limit(1);
  const q = quotes?.[0];
  if (!q) return null;

  const clinic = q.clinics as { name?: string; whatsapp_e164?: string; phone_e164?: string } | null;
  return {
    kind: 'clinic',
    quoteId: q.id,
    orderId: q.consultation_id,
    question: q.clarification_question ?? '',
    supplierConversationId: q.conversation_id ?? '',
    supplierPhone: await resolveEstablishmentPhone(q.conversation_id, clinic),
    supplierName: clinic?.name ?? 'a clínica',
    _askedAt: q.clarification_asked_at ?? '',
  };
}

/**
 * Acha a clarificação pendente (farmácia OU clínica) do cliente. Quando há as duas,
 * devolve a mais recente (a Xarlote levou a última pergunta ao cliente por último).
 */
export async function findPendingClarificationForUser(userConversationId: string): Promise<PendingClarification | null> {
  const [pharmacy, clinic] = await Promise.all([
    findPendingPharmacyClarification(userConversationId),
    findPendingClinicClarification(userConversationId),
  ]);
  if (pharmacy && clinic) {
    return clinic._askedAt > pharmacy._askedAt ? clinic : pharmacy;
  }
  return pharmacy ?? clinic;
}

// ─── Devolução da resposta ao estabelecimento ────────────────────────────────

/**
 * O cliente respondeu → marca a cotação como `answered` e devolve a resposta ao
 * estabelecimento certo (farmácia via sendOutboundToSupplier, clínica via
 * sendOutboundToClinic), conforme o `kind` da clarificação pendente.
 */
export async function relayUserAnswerToEstablishment(
  userConversationId: string,
  answer: string,
  traceId: string,
): Promise<{ relayed: boolean; kind?: EstablishmentKind; supplierName?: string }> {
  const pending = await findPendingClarificationForUser(userConversationId);
  if (!pending) return { relayed: false };

  const answeredPatch = {
    clarification_status: 'answered',
    clarification_answer: answer,
    clarification_answered_at: new Date().toISOString(),
  };
  if (pending.kind === 'clinic') {
    await db.from('consultation_quotes').update(answeredPatch).eq('id', pending.quoteId);
  } else {
    await db.from('quotes').update(answeredPatch).eq('id', pending.quoteId);
  }

  // REUSO DO CPF (política do fundador): se o cliente respondeu um CPF a uma pergunta de
  // CPF, salva no perfil pra a Xarlote responder as OUTRAS farmácias sozinha (sem re-perguntar
  // nem deixar a farmácia no vácuo). NUNCA loga o CPF (PII — CLAUDE.md #3).
  const cpfDigits = (answer ?? '').replace(/\D/g, '');
  if (cpfDigits.length === 11 && /\bcpf\b/i.test(pending.question ?? '')) {
    const { data: convRow } = await db.from('conversations').select('user_id').eq('id', userConversationId).maybeSingle();
    const uid = convRow?.user_id as string | null;
    if (uid) {
      await db.from('users').update({ document_cpf: cpfDigits }).eq('id', uid);
      await writeLog('info', 'clarification', 'CPF do cliente salvo no perfil (reuso automático nas próximas farmácias)', { traceId });
    }
  }

  if (pending.supplierConversationId && pending.supplierPhone) {
    // Manda a resposta DIRETA, sem prefixo — "Sobre o que você perguntou:" é cara de
    // robô/call-center (a farmácia perguntou, isto é a resposta; humano não prefixa).
    // O texto já vem no tom certo (o agente/relay formula em 1ª pessoa, sem "o cliente").
    // Se por acaso a resposta vier vazia, NÃO deixa o estabelecimento no vácuo (ele
    // acabou de perguntar) — manda um ack curto pra segurar a conversa (review LOW).
    const text = (answer ?? '').trim() || 'Deixa eu confirmar aqui rapidinho e já te falo, tá? 🙂';
    if (pending.kind === 'clinic') {
      await sendOutboundToClinic(pending.supplierConversationId, pending.supplierPhone, text, traceId);
    } else {
      await sendOutboundToSupplier(pending.supplierConversationId, pending.supplierPhone, text, traceId);
    }
  }
  await writeLog('info', 'clarification', `✅ Resposta do cliente devolvida à ${pending.kind === 'clinic' ? 'clínica' : 'farmácia'}: "${answer.slice(0, 80)}"`, { traceId, quoteId: pending.quoteId, kind: pending.kind });
  return { relayed: true, kind: pending.kind, supplierName: pending.supplierName };
}
