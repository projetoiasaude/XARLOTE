import { db } from '@iasaude/db';
import { AGENT_INSTANCE, sanitizeSupplierNote, noteSignalsConditionalOffer, resolveSupplierByHint, itemDisplayName } from '@iasaude/shared';
import type { OrderItem } from '@iasaude/shared';
import { providerFor } from '@iasaude/whatsapp';

/**
 * ESTADO COMPLETO de um pedido de farmácia — a visão que faltava pra Xarlote entender
 * que um pedido é um CONJUNTO de farmácias, cada uma num ponto diferente (respondeu,
 * não respondeu, tem-mas-com-ressalva), e não uma rota fixa. Alimenta:
 *   1. o bloco "ESTADO DO PEDIDO" no system prompt da Xarlote (inbound-user);
 *   2. o handler `message_supplier` (re-engajar UMA farmácia específica).
 *
 * Janela de 24h: na perna do agente em WABA/zpro, texto livre só é entregue se a
 * farmácia falou nas últimas 24h (janela de sessão do Meta). Em uazapi (não-oficial)
 * não há janela. `contactableFreeText` reflete isso por farmácia.
 */

const WINDOW_MS = 24 * 60 * 60 * 1000;
/** Pedidos recentes que ainda fazem sentido re-engajar/reportar (inclui failed <24h). */
const RELEVANT_STATUSES = ['quoting', 'quoted', 'confirming', 'failed'] as const;

export interface OrderSupplierState {
  quoteId: string;
  supplierId: string;
  supplierName: string;
  status: string; // pending|contacting|negotiating|quoted|unavailable|timeout
  /** Nota da farmácia já sanitizada pra exibir (sem marcadores internos). '' se vazia. */
  note: string;
  total: number | null;
  deliveryFee: number | null;
  etaMinutes: number | null;
  /** Deu resposta substantiva (cotou preço OU disse algo útil registrado em notes). */
  responded: boolean;
  /** Tem o item / ofereceu alternativa (entrega condicional, retirada, Uber, indicação). */
  conditional: boolean;
  conversationId: string | null;
  /** Telefone E.164 do fornecedor — NÃO exponha ao prompt (PII); uso interno. */
  phoneE164: string | null;
  lastSupplierInboundAt: string | null;
  /** Dá pra mandar texto livre agora (dentro da janela de 24h, ou provider sem janela)? */
  contactableFreeText: boolean;
}

export interface OrderState {
  orderId: string;
  status: string;
  items: OrderItem[];
  createdAt: string;
  selectedQuoteId: string | null;
  suppliers: OrderSupplierState[];
}

interface QuoteJoinRow {
  id: string;
  status: string;
  notes: string | null;
  total: number | null;
  delivery_fee: number | null;
  eta_minutes: number | null;
  supplier_id: string;
  conversation_id: string | null;
  suppliers: { name?: string | null; whatsapp_e164?: string | null; phone_e164?: string | null } | null;
}

/**
 * Carrega o pedido de farmácia MAIS RECENTE do usuário (dentro de 24h) com o estado de
 * TODAS as suas cotações. Devolve null se não houver pedido recente relevante.
 */
export async function loadLatestOrderState(userId: string): Promise<OrderState | null> {
  const sinceIso = new Date(Date.now() - WINDOW_MS).toISOString();
  const { data: order } = await db
    .from('orders')
    .select('id, status, items, created_at, selected_quote_id')
    .eq('user_id', userId)
    .in('status', RELEVANT_STATUSES as unknown as string[])
    .gte('created_at', sinceIso)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!order?.id) return null;

  const { data: quotesRaw } = await db
    .from('quotes')
    .select('id, status, notes, total, delivery_fee, eta_minutes, supplier_id, conversation_id, suppliers(name, whatsapp_e164, phone_e164)')
    .eq('order_id', order.id)
    .order('created_at', { ascending: true });
  const quotes = (quotesRaw ?? []) as unknown as QuoteJoinRow[];

  // Última mensagem RECEBIDA de cada farmácia (pra janela de 24h). Uma query só.
  const convIds = [...new Set(quotes.map((q) => q.conversation_id).filter((c): c is string => !!c))];
  const lastInboundByConv = new Map<string, string>();
  if (convIds.length) {
    const { data: inbound } = await db
      .from('messages')
      .select('conversation_id, created_at')
      .in('conversation_id', convIds)
      .eq('direction', 'in')
      .eq('sender_role', 'supplier')
      .order('created_at', { ascending: false });
    for (const m of inbound ?? []) {
      const cid = m.conversation_id as string;
      if (!lastInboundByConv.has(cid)) lastInboundByConv.set(cid, m.created_at as string);
    }
  }

  const providerHasWindow = providerFor(AGENT_INSTANCE) === 'zpro';
  const now = Date.now();

  const suppliers: OrderSupplierState[] = quotes.map((q) => {
    const note = sanitizeSupplierNote(q.notes);
    const responded = q.status === 'quoted' || q.status === 'negotiating' || (q.status === 'unavailable' && !!note);
    const conditional = noteSignalsConditionalOffer(q.notes);
    const lastIn = q.conversation_id ? lastInboundByConv.get(q.conversation_id) ?? null : null;
    const withinWindow = lastIn ? now - new Date(lastIn).getTime() < WINDOW_MS : false;
    return {
      quoteId: q.id,
      supplierId: q.supplier_id,
      supplierName: q.suppliers?.name ?? 'Farmácia',
      status: q.status,
      note,
      total: q.total,
      deliveryFee: q.delivery_fee,
      etaMinutes: q.eta_minutes,
      responded,
      conditional,
      conversationId: q.conversation_id,
      phoneE164: q.suppliers?.whatsapp_e164 || q.suppliers?.phone_e164 || null,
      lastSupplierInboundAt: lastIn,
      // uazapi (sem janela) → sempre; zpro/WABA → só se falou nas últimas 24h.
      contactableFreeText: !providerHasWindow || withinWindow,
    };
  });

  return {
    orderId: order.id,
    status: order.status,
    items: (order.items ?? []) as OrderItem[],
    createdAt: order.created_at,
    selectedQuoteId: (order.selected_quote_id as string | null) ?? null,
    suppliers,
  };
}

/** Rótulo humano do estado de UMA farmácia, pra Xarlote entender (sem jargão de status). */
function supplierStateLabel(s: OrderSupplierState): string {
  switch (s.status) {
    case 'quoted': {
      const preco = s.total != null ? `cotou R$${Number(s.total).toFixed(2)}` : 'respondeu (sem preço claro)';
      return preco;
    }
    case 'negotiating':
    case 'contacting':
      return 'conversando agora';
    case 'pending':
      return 'ainda não respondeu';
    case 'timeout':
      return 'não respondeu a tempo';
    case 'unavailable':
      return s.note ? `respondeu: "${s.note}"` : 'não tinha / não entrega aqui';
    default:
      return s.status;
  }
}

/** Rótulo humano do estado do PEDIDO como um todo. */
function orderStatusLabel(state: OrderState): string {
  switch (state.status) {
    case 'quoting': return 'buscando/negociando com as farmácias';
    case 'quoted': return 'com cotações prontas (veja PEDIDO ATIVO pra fechar)';
    case 'confirming':
    case 'handed_off': return 'FECHADO com a farmácia escolhida';
    case 'failed': return 'NÃO fechou — nenhuma opção viável ainda';
    default: return state.status;
  }
}

/**
 * Renderiza o bloco "ESTADO DO PEDIDO" pro system prompt da Xarlote: lista TODAS as
 * farmácias e o que cada uma disse, quais dá pra re-contatar, e como agir. É o que
 * dá a ela a compreensão de estado (não só a rota feliz).
 */
export function buildOrderStateBlock(state: OrderState): string {
  const itemNames = state.items.map((i) => itemDisplayName(i.name, i.dosage)).join(', ') || 'o pedido';
  const lines: string[] = [
    `## ESTADO DO PEDIDO (visão completa — todas as farmácias deste pedido)`,
    `Pedido de **${itemNames}** — situação: ${orderStatusLabel(state)}.`,
  ];

  if (state.suppliers.length) {
    lines.push('Farmácias contatadas:');
    for (const s of state.suppliers) {
      const isChosen = state.selectedQuoteId && s.quoteId === state.selectedQuoteId ? ' ⭐(escolhida)' : '';
      const reengage = s.responded && s.status !== 'quoted' && !s.contactableFreeText
        ? ' — (faz +24h que não fala; não dá pra reabrir direto)'
        : '';
      lines.push(`• ${s.supplierName}${isChosen} — ${supplierStateLabel(s)}${reengage}`);
    }
  }

  const conditionals = state.suppliers.filter((s) => s.conditional && s.status !== 'quoted' && s.contactableFreeText);
  const anyContactable = state.suppliers.some((s) => s.contactableFreeText && s.status !== 'timeout');

  lines.push('');
  lines.push('### COMO AGIR NESTE PEDIDO');
  lines.push(
    `- Você pode **falar de novo com UMA farmácia específica** deste pedido com a tool **message_supplier** (passe \`supplier_hint\` = o nome/dica dela e \`message\` = o que dizer, em 1ª pessoa, tom humano). Use quando o usuário pedir algo dirigido: "fala pra São Benedito que topo o Uber", "pergunta pra Drogalobo se tem o genérico", "vê com a que respondeu se entrega hoje".`,
  );
  if (conditionals.length) {
    const names = conditionals.map((s) => s.supplierName).join(', ');
    lines.push(
      `- ⚠️ ${names} respondeu de forma ÚTIL mas com uma ressalva (tem o item / ofereceu alternativa). Se o usuário quiser destravar isso, use **message_supplier** pra acertar com ela — não precisa começar um pedido novo.`,
    );
  }
  if (state.status === 'failed' || state.status === 'quoting') {
    lines.push(`- Se quiser procurar MAIS farmácias num raio maior, use **expand_pharmacy_search**.`);
  }
  if (!anyContactable && state.suppliers.length) {
    lines.push(`- Nenhuma farmácia deste pedido está na janela de conversa agora; pra retomar, o caminho é começar um pedido novo (start_pharmacy_order) ou ampliar a busca.`);
  }
  lines.push(
    `- 🔒 HONESTIDADE DE ESTADO: só diga que o pedido foi "confirmado/fechado" se a situação acima disser FECHADO. Se está buscando, diga que está buscando; se NÃO fechou, seja honesta — nunca invente uma confirmação.`,
  );

  return lines.join('\n');
}

/** Resolve a farmácia-alvo dentro do estado do pedido, a partir da dica do usuário. */
export function resolveTargetSupplier(state: OrderState, hint: string | null | undefined): OrderSupplierState | null {
  const quoteId = resolveSupplierByHint(
    state.suppliers.map((s) => ({ quote_id: s.quoteId, supplier_name: s.supplierName, status: s.status, responded: s.responded })),
    hint,
  );
  if (!quoteId) return null;
  return state.suppliers.find((s) => s.quoteId === quoteId) ?? null;
}
