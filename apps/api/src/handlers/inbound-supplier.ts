import { randomUUID } from 'crypto';
import { db, findOrCreateConversation, getConversationMessages, writeLog } from '@iasaude/db';
import {
  chat,
  buildAgentPharmacySystemPrompt,
  agentPharmacyTools,
  messagesToHistory,
  trimHistory,
} from '@iasaude/llm';
import { AGENT_INSTANCE } from '@iasaude/shared';
import type { NormalizedInbound, OrderItem, Message } from '@iasaude/shared';
import { loadPrompts } from '../config/prompts.js';
import { sendOutboundToSupplier } from './outbound-agent.js';
import { consolidateQuotes, notifyUserQuoteArrived } from './quote-consolidation.js';

/**
 * Extrai "Rua/Avenida X, Setor Y" do endereço completo (Nominatim/ViaCEP / Google reverse).
 * Mantém a rua + setor (sem número, sem CEP, sem cidade/UF) pra usar na cotação.
 * Retorna null se for string sintética só com lat/lng — caller usa fallback.
 */
function extractDeliverySectorLocal(fullAddress: string | null): string | null {
  if (!fullAddress) return null;
  if (/Localização compartilhada|^lat\s|coordenadas?\b/i.test(fullAddress)) return null;

  const parts = fullAddress.split(',').map((s) => s.trim()).filter(Boolean);
  const ignoreLow = /^(região|brasil|brazil|região centro-oeste|mesorregião|microrregião)/i;
  const isStreet = /^(rua|r\.?|avenida|av\.?|alameda|al\.?|travessa|tv\.?|rodovia|rod\.?|praça|pç\.?|estrada|via|quadra|qd\.?)\b/i;
  const isOnlyNumber = /^\d+[a-zA-Z]?$/;
  const isCep = /^\d{5}-?\d{3}$/;
  const isUf = /^([A-Z]{2}|Goiás|Goias|São Paulo|Rio de Janeiro|Minas Gerais|Bahia|Paraná|Pernambuco|Ceará|Pará|Distrito Federal|Mato Grosso|Mato Grosso do Sul|Espírito Santo|Santa Catarina|Rio Grande do Sul|Rio Grande do Norte|Alagoas|Sergipe|Paraíba|Piauí|Maranhão|Tocantins|Acre|Amapá|Amazonas|Rondônia|Roraima)$/i;

  let street: string | null = null;
  let sector: string | null = null;

  for (const p of parts) {
    if (ignoreLow.test(p) || isCep.test(p) || isOnlyNumber.test(p) || isUf.test(p)) continue;
    if (isStreet.test(p)) {
      if (!street) street = p;
      continue;
    }
    if (!sector) {
      sector = p;
      if (street) break;
    }
  }

  const result = [street, sector].filter(Boolean).join(', ');
  return result || null;
}

export interface SupplierInboundCtx {
  conversationId: string;
  supplierPhone: string;
  text: string;
  traceId: string;
}

export async function processInboundSupplier(ctx: SupplierInboundCtx): Promise<void> {
  const { conversationId, supplierPhone, text, traceId } = ctx;

  // 1. Persist inbound message from supplier
  await db.from('messages').insert({
    conversation_id: conversationId,
    direction: 'in',
    sender_role: 'supplier',
    content_type: 'text',
    content: text,
    trace_id: traceId,
  });
  await db.from('conversations')
    .update({ last_message_at: new Date().toISOString() })
    .eq('id', conversationId);

  // 2. Load conversation to get supplier_id (may be null in simulator mode)
  const { data: conv } = await db.from('conversations').select('*').eq('id', conversationId).single();
  if (!conv) {
    await writeLog('warn', 'supplier', 'Conversa não encontrada', { traceId, conversationId });
    return;
  }

  // 3. Find the active quote — prefer lookup by conversation_id (most precise).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let quote: any = null;
  let isOrderConfirmation = false;

  {
    // Busca TODAS as cotações abertas nesta conversa (não só a mais recente).
    // A conversa de fornecedor é compartilhada por telefone, então pode haver
    // mais de um pedido concorrente pra mesma farmácia. Sem código de referência
    // não dá pra saber 100% a qual pedido a resposta se refere — atribuímos à
    // mais recente, mas LOGAMOS a ambiguidade pra aparecer na auditoria.
    const { data: openQuotes } = await db
      .from('quotes')
      .select('*, orders(*), suppliers(*)')
      .eq('conversation_id', conversationId)
      .in('status', ['pending', 'contacting', 'negotiating'])
      .order('created_at', { ascending: false });
    if (openQuotes && openQuotes.length > 1) {
      await writeLog(
        'warn',
        'supplier',
        `⚠️ ${openQuotes.length} cotações abertas na mesma conversa de farmácia — resposta atribuída à mais recente (possível mistura; resolve 100% com código de referência)`,
        { traceId, conversationId, openQuoteIds: (openQuotes as Array<{ id: string }>).map((q) => q.id) },
      );
    }
    quote = openQuotes?.[0] ?? null;
  }

  if (!quote && conv.supplier_id) {
    const { data } = await db
      .from('quotes')
      .select('*, orders(*), suppliers(*)')
      .eq('supplier_id', conv.supplier_id)
      .in('status', ['pending', 'contacting', 'negotiating'])
      .order('created_at', { ascending: false })
      .limit(1)
      .single();
    quote = data;
  }

  // Check if this is a post-confirmation reply (order in 'confirming' or 'handed_off' state)
  if (!quote) {
    const { data } = await db
      .from('quotes')
      .select('*, orders(*), suppliers(*)')
      .eq('conversation_id', conversationId)
      .eq('status', 'quoted')
      .order('created_at', { ascending: false })
      .limit(1)
      .single();
    if (data && ['confirming', 'handed_off'].includes((data.orders as any)?.status)) {
      quote = data;
      isOrderConfirmation = true;
    }
  }

  if (!quote) {
    await writeLog('warn', 'supplier', 'Nenhuma cotação ativa encontrada para este fornecedor', { traceId, conversationId });
    return;
  }

  // 4. Guard: turn limit (12 turns = 24 messages)
  const { count: msgCount } = await db
    .from('messages')
    .select('*', { count: 'exact', head: true })
    .eq('conversation_id', conversationId);

  if ((msgCount ?? 0) > 24) {
    await finalizeQuote(quote.id, quote.order_id, 'timeout', traceId);
    return;
  }

  // 5. Mark as negotiating
  await db.from('quotes')
    .update({ status: 'negotiating' })
    .eq('id', quote.id)
    .in('status', ['pending', 'contacting']);

  // 6. Build context
  const history = await getConversationMessages(conversationId, 24);
  const order = quote.orders as {
    items: OrderItem[];
    delivery_address?: string | null;
    delivery_lat?: number;
    delivery_lng?: number;
    payment_method?: string | null;
  } | null;

  // Setor/bairro do usuário (vindo de delivery_address). Cai pra cidade da farmácia se não tiver.
  const supplier = quote.suppliers as { city?: string; state?: string } | null;
  const userNeighborhood =
    extractDeliverySectorLocal(order?.delivery_address ?? null) ||
    [supplier?.city, supplier?.state].filter(Boolean).join(', ') ||
    'região';

  const cfg = loadPrompts();
  const systemPrompt = cfg.agent_override.trim()
    ? cfg.agent_override.trim()
    : buildAgentPharmacySystemPrompt({
        items: order?.items ?? [],
        neighborhoodCity: userNeighborhood,
        paymentMethod: order?.payment_method ?? null,
        isOrderConfirmation,
      });

  // 7. Call LLM (Agent persona)
  let llmResponse;
  try {
    llmResponse = await chat(text, {
      model: cfg.llm_model || process.env['OPENROUTER_MODEL'] || 'openai/gpt-4.1-mini',
      apiKey: cfg.llm_api_key || process.env['OPENROUTER_API_KEY'],
      systemInstruction: systemPrompt,
      history: trimHistory(messagesToHistory(history.slice(0, -1) as Message[]), 12),
      tools: agentPharmacyTools,
      temperature: 0.3,
      maxOutputTokens: 400,
      timeoutMs: 30_000,
    });
  } catch (err) {
    await writeLog('error', 'llm', `Agent LLM error: ${String(err)}`, { traceId });
    return;
  }

  // 8. Log LLM response for observability
  await writeLog('info', 'agent', `Agente processou resposta da farmácia — tools: [${llmResponse.toolCalls.map((t) => t.name).join(', ') || 'nenhuma'}] texto: ${llmResponse.text.trim() ? `"${llmResponse.text.trim().slice(0, 60)}"` : '(vazio)'}`, {
    traceId, conversationId, toolCalls: llmResponse.toolCalls.map((t) => ({ name: t.name, args: t.args })),
  });

  // 9. Execute tool calls
  let shouldFinalize = false;
  let outcome = '';

  for (const tc of llmResponse.toolCalls) {
    switch (tc.name) {
      case 'record_quote_price': {
        const a = tc.args as {
          total: number; subtotal?: number; delivery_fee?: number;
          eta_minutes?: number; payment_methods?: string[];
          pix_key?: string; payment_link?: string; notes?: string;
        };
        const { error: qErr } = await db.from('quotes').update({
          status: 'quoted',
          subtotal: a.subtotal ?? null,
          delivery_fee: a.delivery_fee ?? null,
          total: a.total,
          eta_minutes: a.eta_minutes ?? null,
          payment_methods: a.payment_methods ?? [],
          pix_key: a.pix_key ?? null,
          payment_link: a.payment_link ?? null,
          notes: a.notes ?? null,
          completed_at: new Date().toISOString(),
        }).eq('id', quote.id);
        if (qErr) {
          await writeLog('error', 'quote', `Erro ao atualizar cotação: ${qErr.message}`, { traceId, quoteId: quote.id });
        } else {
          await writeLog('info', 'quote', `✅ Cotação registrada: R$${a.total}`, { traceId, quoteId: quote.id, total: a.total, delivery_fee: a.delivery_fee });
          // Avisa o usuário que mais uma cotação chegou (só enquanto order ainda em quoting)
          const supplierName = (quote.suppliers as { name?: string } | null)?.name ?? 'farmácia';
          await notifyUserQuoteArrived(quote.order_id, supplierName, traceId).catch((e) =>
            writeLog('warn', 'order', `Falha ao notificar cliente da cotação: ${String(e)}`, { traceId }),
          );
        }
        shouldFinalize = true;
        outcome = 'quoted';
        break;
      }
      case 'record_supplier_unavailable': {
        const a = tc.args as { reason?: string };
        await db.from('quotes').update({ status: 'unavailable', completed_at: new Date().toISOString(), notes: a.reason ?? null }).eq('id', quote.id);
        await writeLog('info', 'quote', `❌ Farmácia indisponível: ${a.reason ?? 'sem motivo'}`, { traceId, quoteId: quote.id });
        shouldFinalize = true;
        outcome = 'unavailable';
        break;
      }
      case 'finalize_supplier_contact': {
        const a = tc.args as { outcome: string };
        outcome = a.outcome;
        shouldFinalize = true;
        await writeLog('info', 'quote', `Negociação finalizada: ${a.outcome}`, { traceId, quoteId: quote.id });
        break;
      }
      case 'record_supplier_ack':
        // Pharmacy confirmed they have the item — agent will ask for price next turn
        await writeLog('info', 'agent', 'Farmácia confirmou disponibilidade — aguardando preço', { traceId });
        break;
      case 'request_clarification':
        // Agent needs more info — it will ask via text response
        break;
      case 'record_order_confirmation': {
        // Pharmacy confirmed the order is being prepared
        const a = tc.args as { estimated_delivery_minutes?: number; notes?: string };
        await db.from('quotes').update({
          eta_minutes: a.estimated_delivery_minutes ?? quote.eta_minutes,
          notes: a.notes ?? quote.notes,
        }).eq('id', quote.id);
        await writeLog('info', 'order', `✅ Farmácia confirmou preparo do pedido${a.estimated_delivery_minutes ? ` — ETA: ${a.estimated_delivery_minutes}min` : ''}`, { traceId, quoteId: quote.id });
        break;
      }
      default:
        await writeLog('warn', 'agent', `Tool desconhecida chamada: ${tc.name}`, { traceId });
    }
  }

  // 10. Send reply text to pharmacy (if not finalized)
  if (llmResponse.text.trim() && !shouldFinalize) {
    await sendOutboundToSupplier(conversationId, supplierPhone, llmResponse.text.trim(), traceId);
  } else if (!llmResponse.text.trim() && !shouldFinalize && llmResponse.toolCalls.length === 0) {
    // LLM returned nothing — log it
    await writeLog('warn', 'agent', 'Agente retornou resposta vazia sem tools — nenhuma ação tomada', { traceId, conversationId });
  }

  // 11. If negotiation ended, finalize and maybe consolidate (skip in confirmation mode)
  if (shouldFinalize && !isOrderConfirmation) {
    await finalizeQuote(quote.id, quote.order_id, outcome, traceId);
  }
}

// Called from webhook for real uazapi messages on the agent instance.
// AGENT_INSTANCE serve tanto pra farmácia quanto pra clínica — diferenciamos
// pelo `party_type` da conversa salva no DB.
export async function processInboundSupplierFromWebhook(inbound: NormalizedInbound, traceId: string = randomUUID()): Promise<void> {
  // O jid salvo na negociação é sempre `<digitos>@s.whatsapp.net` (derivado do
  // whatsapp_e164 do fornecedor). Dependendo do provider, o sender do inbound
  // pode vir com outro sufixo (@c.us, @lid) — então casamos pelo jid cru E pelo
  // jid canônico reconstruído do telefone (robusto pra uazapi e zpro).
  const canonicalJid = `${inbound.from.phoneE164.replace(/\D/g, '')}@s.whatsapp.net`;
  const jids = [...new Set([inbound.from.jid, canonicalJid])];
  const { data: rows } = await db
    .from('conversations')
    .select('id, party_type')
    .eq('whatsapp_instance', AGENT_INSTANCE)
    .in('whatsapp_jid', jids)
    .limit(1);

  const conv = rows?.[0];
  if (!conv) return;

  // Roteamento por party_type — clinic vai pro agent-clinic, supplier fica aqui
  if ((conv as { party_type?: string }).party_type === 'clinic') {
    // Lazy import pra evitar ciclo
    const { processInboundClinic } = await import('./agent-clinic.js');
    await processInboundClinic({
      conversationId: conv.id,
      clinicPhone: inbound.from.phoneE164,
      text: inbound.text ?? '',
      traceId,
    });
    return;
  }

  await processInboundSupplier({
    conversationId: conv.id,
    supplierPhone: inbound.from.phoneE164,
    text: inbound.text ?? '',
    traceId,
  });
}

// ─── Initiate a new negotiation (called after pharmacy discovery) ────────────

export async function initiatePharmacyNegotiation(
  quoteId: string,
  orderId: string,
  items: OrderItem[],
  userNeighborhood: string,
  paymentMethod: string | null,
  userConversationId: string,
  userPhoneE164: string,
  traceId: string,
): Promise<void> {
  // Load quote + supplier
  const { data: quote } = await db
    .from('quotes')
    .select('*, suppliers(*)')
    .eq('id', quoteId)
    .single();

  if (!quote) return;

  const supplier = quote.suppliers as {
    id: string; name: string; whatsapp_e164?: string; city?: string; state?: string; phone_e164?: string;
  } | null;

  if (!supplier) return;

  // In simulator, use a fake phone derived from supplier ID
  const supplierPhone = supplier.whatsapp_e164 || supplier.phone_e164 || `+555500000${supplier.id.slice(0, 4)}`;
  const supplierJid = `${supplierPhone.replace(/\D/g, '')}@s.whatsapp.net`;

  // Create (or find) supplier conversation
  const conv = await findOrCreateConversation(AGENT_INSTANCE, supplierJid, 'supplier', null, supplier.id);

  // Link quote to this conversation
  await db.from('quotes')
    .update({ conversation_id: conv.id, status: 'contacting', started_at: new Date().toISOString() })
    .eq('id', quoteId);

  // "Book" da conversa: registra o contexto DESTE pedido acumulando por order_id
  // (NÃO sobrescreve). Assim cotações concorrentes pra mesma farmácia coexistem
  // sem uma apagar a outra. A notificação canônica deriva do pedido
  // (orders.conversation_id), mas manter o registro por pedido aqui evita perda
  // de contexto e prepara o roteamento por código de referência.
  {
    const { data: convRow } = await db.from('conversations').select('memory_cards').eq('id', conv.id).single();
    const prior = Array.isArray(convRow?.memory_cards) ? (convRow!.memory_cards as Array<Record<string, unknown>>) : [];
    const book = prior.filter((e) => e?.['order_id'] !== orderId);
    book.push({ user_conversation_id: userConversationId, user_phone: userPhoneE164, order_id: orderId });
    await db.from('conversations').update({ memory_cards: book }).eq('id', conv.id);
  }

  // Build opening message via Agent LLM. Repassamos o setor REAL do usuário (não a cidade da farmácia).
  const cfg = loadPrompts();
  const systemPrompt = cfg.agent_override.trim()
    ? cfg.agent_override.trim()
    : buildAgentPharmacySystemPrompt({
        items,
        neighborhoodCity: userNeighborhood,
        paymentMethod: paymentMethod ?? null,
      });

  const itemsText = items.map((i) => `${i.name}${i.dosage ? ` ${i.dosage}` : ''}${i.quantity ? ` (${i.quantity})` : ''}`).join(', ');
  const paymentClause = paymentMethod ? ` O pagamento vai ser via ${paymentMethod}.` : '';
  const fallbackOpening = `Oi, tudo bem? Aqui é a Xarlote, você teria ${itemsText}? Para entregar no ${userNeighborhood}, queria saber o preço e prazo de entrega, por favor.${paymentClause}`;

  let opening: string;
  try {
    const res = await chat('INICIAR_COTACAO', {
      model: cfg.llm_model || process.env['OPENROUTER_MODEL'] || 'openai/gpt-4.1-mini',
      apiKey: cfg.llm_api_key || process.env['OPENROUTER_API_KEY'],
      systemInstruction:
        systemPrompt +
        '\n\nEsta é a primeira mensagem. Escreva apenas a mensagem de abertura para a farmácia — apresentando-se como Xarlote e perguntando sobre os itens. Sem emojis. Sem mencionar IA/agente/sistema. Não use tools ainda.',
      history: [],
      tools: [],
      temperature: 0.4,
      maxOutputTokens: 200,
      timeoutMs: 20_000,
    });
    opening = res.text.trim() || fallbackOpening;
  } catch {
    opening = fallbackOpening;
  }

  await writeLog('info', 'pharmacy', `Initiating negotiation with ${supplier.name}`, {
    traceId, quoteId, supplierId: supplier.id,
  });

  await sendOutboundToSupplier(conv.id, supplierPhone, opening, traceId);
}

// ─── Internal helpers ────────────────────────────────────────────────────────

async function finalizeQuote(quoteId: string, orderId: string, outcome: string, traceId: string) {
  const finalStatus = outcome === 'quoted' ? 'quoted' : outcome === 'unavailable' ? 'unavailable' : 'timeout';

  // Only update if not already in a terminal state
  await db.from('quotes')
    .update({ status: finalStatus, completed_at: new Date().toISOString() })
    .eq('id', quoteId)
    .in('status', ['pending', 'contacting', 'negotiating']);

  await writeLog('info', 'quote', `Quote finalized: ${finalStatus}`, { traceId, quoteId });

  // Check whether to consolidate
  const { data: quotes } = await db.from('quotes').select('status').eq('order_id', orderId);
  if (!quotes) return;

  const successful = quotes.filter((q) => q.status === 'quoted').length;
  const terminal = quotes.filter((q) => ['quoted', 'unavailable', 'timeout'].includes(q.status)).length;
  const total = quotes.length;

  // Consolidate if: 3+ successful, OR 2+ successful and all done, OR ALL terminal (even if 0 successful)
  if (successful >= 3 || (successful >= 2 && terminal === total) || terminal === total) {
    // Find user context from any supplier conversation linked to this order
    const { data: orderRow } = await db.from('orders').select('conversation_id, user_id').eq('id', orderId).single();
    if (!orderRow?.conversation_id) return;

    const { data: userConv } = await db.from('conversations').select('whatsapp_jid').eq('id', orderRow.conversation_id).single();
    const userPhone = userConv?.whatsapp_jid?.replace('@s.whatsapp.net', '') ?? '';

    await consolidateQuotes(orderId, orderRow.conversation_id, `+${userPhone}`, traceId);
  }
}
