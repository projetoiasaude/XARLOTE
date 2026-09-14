import { randomUUID } from 'crypto';
import { db, findOrCreateConversation, getConversationMessages, writeLog, writeAudit } from '@iasaude/db';
import {
  chat,
  buildAgentPharmacySystemPrompt,
  agentPharmacyTools,
  messagesToHistory,
  userContentWithImage,
  dataUrl,
} from '@iasaude/llm';
import { fetchInboundMedia } from '@iasaude/whatsapp';
import { transcribeAudio } from '@iasaude/integrations';
import {
  AGENT_INSTANCE, whatsappJidVariants, isPlaceholderPhone, toE164BR, brPhoneVariants, extractPriceBRL, parseUnitCount,
  shortSupplierAddress, mentionsFreeShipping, itemDisplayName, noteSignalsConditionalOffer, sanitizeSupplierNote,
  ARRIVAL_RE, WHO_ASK_RE, decidirRotaDaMensagem, type CotacaoCandidata,
  montarProdutoCotado, detectarSubstitutoOferecido, consertarAceiteDeSubstituto, type ProdutoCotado,
  sugestaoDeNomeDaFarmacia, perguntaSobreSugestaoDeNome,
  interpretarMensagemPosCotacao, CORTESIA_NOME_ANTES_DE_FECHAR, ofertaMudou, mensagemDeAtualizacaoDaOferta, normalizarPrecoDaCotacao,
  extractDeliverySector,
  pareceNarracaoInterna, CORTESIA_NEUTRA,
} from '@iasaude/shared';
import type { NormalizedInbound, OrderItem, Message } from '@iasaude/shared';
import { loadPrompts } from '../config/prompts.js';
import { sendOutboundToSupplier, sendTemplateOpeningToSupplier } from './outbound-agent.js';
import { sendOutbound } from './outbound.js';
import { consolidateQuotes, notifyUserQuoteArrived, notifyBetterQuoteIfPresented, atualizarOfertaAoPaciente } from './quote-consolidation.js';
import { relaySupplierQuestionToUser } from './clarification.js';
import { templatesEnabled, pharmacyColdOpen } from '../config/template-registry.js';
import { markSupplierVerifiedById } from './supplier-directory.js';

/**
 * Extrai "Rua/Avenida X, Setor Y" do endereço completo (Nominatim/ViaCEP / Google reverse).
 * Mantém a rua + setor (sem número, sem CEP, sem cidade/UF) pra usar na cotação.
 * Retorna null se for string sintética só com lat/lng — caller usa fallback.
 */
const extractDeliverySectorLocal = extractDeliverySector;

export interface SupplierInboundCtx {
  conversationId: string;
  supplierPhone: string;
  text: string;
  traceId: string;
  /** true quando a mensagem já foi persistida pelo debounce (enqueueSupplierTurn). */
  skipPersist?: boolean;
}

/**
 * Relay farmácia→CLIENTE pós-fechamento (incidente Vadivino): manda uma mensagem no WhatsApp
 * do CLIENTE (a conversa dele = orders.conversation_id, NUNCA a da farmácia). Dedup 90s pra
 * não repetir o mesmo aviso na rajada. Devolve true se enviou.
 */
// Sinais de logística pós-venda (compartilhados pelo roteador de lane e pelo backstop 10b).
// CHEGADA: exige contexto de ENTREGADOR/entrega (não o `cheg\w*` solto, que casava
// "assim que chegar no estoque"/"não chegou o pagamento" — review 09/07).
// ARRIVAL_RE / WHO_ASK_RE vivem em @iasaude/shared (rota-farmacia.ts) — uma fonte só pro roteador e pro backstop.

// 🔁 DEDUP POR SIMILARIDADE DO RELAY (incidente Glauber 12/07: a farmácia repetiu "quadra e
// lote" e o cliente levou 4 pings quase idênticos em 4min). O dedup do sendOutbound é por
// TEXTO exato — o LLM varia o fraseado ("tá pedindo" vs "precisa") e escapa. Aqui comparamos
// por SIMILARIDADE (Jaccard de tokens): só engolimos repetições QUASE-IDÊNTICAS, deixando
// passar uma pergunta DIFERENTE ("e o complemento?" depois de "quadra e lote" — review #12).
// CHEGADA nunca é deduplicada (uma 2ª tentativa real de entrega não pode sumir — review #11).
// Estado local do processo (single-instance, como o debounce) — reset no deploy é aceitável.
const recentRelays = new Map<string, Array<{ tokens: Set<string>; ts: number }>>(); // orderId → relays recentes
const RELAY_DEDUP_MS = 8 * 60_000;
// 0.5: o LLM reescreve a MESMA pergunta com drift (as 4 do Glauber ficam 0.55–0.75 entre
// si), mas uma pergunta DIFERENTE ("e o complemento?", "nome de quem recebe") fica ~0.07 —
// gap enorme, então 0.5 engole só as repetições e nunca uma pergunta nova.
const RELAY_SIMILAR_THRESHOLD = 0.5;
const RELAY_STOPWORDS = new Set(['para', 'pelo', 'pela', 'dele', 'dela', 'esse', 'essa', 'isso', 'aqui', 'consegue', 'pode', 'poderia', 'favor', 'obrigada', 'seu', 'sua', 'você', 'voce', 'que', 'com', 'pra', 'sobre']);

function relayTokenSet(text: string): Set<string> {
  const folded = text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ');
  return new Set(folded.split(/\s+/).filter((w) => w.length >= 4 && !RELAY_STOPWORDS.has(w)));
}
function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}
// Reusa ARRIVAL_RE (módulo-level) pra NÃO divergir do que o backstop 10b considera chegada
// (review r2 d): uma msg de chegada nunca pode ser silenciada pelo dedup de similaridade.
function isArrivalRelay(text: string): boolean {
  return ARRIVAL_RE.test(text);
}

/** Relay pós-venda ao CLIENTE. 'sent' = enviou · 'deduped' = repetição quase-idêntica recente
 * (já avisado) · 'failed' = sem canal. Callers só marcam customer_relayed_at/log em 'sent'. */
async function relayToCustomer(orderId: string, text: string, traceId: string): Promise<'sent' | 'deduped' | 'failed'> {
  const now = Date.now();
  // Prune entradas velhas (evita leak — review #13).
  for (const [k, arr] of recentRelays) {
    const kept = arr.filter((r) => now - r.ts < RELAY_DEDUP_MS);
    if (kept.length) recentRelays.set(k, kept); else recentRelays.delete(k);
  }
  const tokens = relayTokenSet(text);
  const dedupable = !isArrivalRelay(text) && tokens.size > 0;
  // Registra o token-set em TODA tentativa dedupável (enviada OU deduplicada) — assim o
  // drift do LLM encadeia: g2≈g1 dedupa, e g3/g4 comparam contra g1+g2+g3, não só g1.
  const record = () => { if (dedupable) { const arr = recentRelays.get(orderId) ?? []; arr.push({ tokens, ts: now }); recentRelays.set(orderId, arr); } };
  if (dedupable) {
    const recent = recentRelays.get(orderId) ?? [];
    if (recent.some((r) => jaccard(tokens, r.tokens) >= RELAY_SIMILAR_THRESHOLD)) {
      record();
      await writeLog('info', 'supplier', `Relay pós-venda deduplicado (repetição quase-idêntica há <8min) — não reenvia ao cliente`, { traceId, orderId });
      return 'deduped';
    }
  }
  const { data: ord } = await db.from('orders').select('conversation_id').eq('id', orderId).maybeSingle();
  if (!ord?.conversation_id) return 'failed';
  const { data: uc } = await db.from('conversations').select('whatsapp_jid').eq('id', ord.conversation_id).maybeSingle();
  const digits = (uc?.whatsapp_jid as string | null)?.replace('@s.whatsapp.net', '');
  if (!digits) return 'failed';
  await sendOutbound(ord.conversation_id as string, `+${digits}`, text, traceId, {}, { dedup: true, dedupWindowMs: 90_000 });
  record();
  return 'sent';
}

export async function processInboundSupplier(ctx: SupplierInboundCtx): Promise<void> {
  const { conversationId, supplierPhone, text, traceId } = ctx;

  // 1. Persist inbound message from supplier (pulado quando o debounce já persistiu)
  if (!ctx.skipPersist) {
    await persistSupplierInbound(conversationId, text, traceId);
  }

  // 2. Load conversation to get supplier_id (may be null in simulator mode)
  const { data: conv } = await db.from('conversations').select('*').eq('id', conversationId).single();
  if (!conv) {
    await writeLog('warn', 'supplier', 'Conversa não encontrada', { traceId, conversationId });
    return;
  }

  // 📬 Verificação POSITIVA do diretório: a farmácia RESPONDEU → esse número tem
  // WhatsApp de verdade (sinal mais forte que o ack de entrega). Fire-and-forget.
  if (conv.supplier_id) {
    void markSupplierVerifiedById(conv.supplier_id as string).catch(() => { /* bônus */ });
  }

  // 3. A QUAL PEDIDO ESTA MENSAGEM PERTENCE? — decisão PURA em `decidirRotaDaMensagem`
  // (@iasaude/shared, rota-farmacia.ts), com precedência explícita e testada:
  //   negociação aberta → pós-venda com janela ABERTA → pós-cotação (pedido vivo, sem
  //   escolhida) → resposta tardia → nenhuma.
  //
  // Caso Ludmila (10/09): o pós-venda era procurado ANTES do pós-cotação e SEM limite de
  // tempo — a resposta da Coimbra ("69.90", "qual nome de quem recebe?", "5 reais de frete")
  // caía num pedido de JULHO de OUTRO paciente e era descartada como "fora da janela de
  // 72h". O frete nunca chegou à paciente. Agora o handler só monta as candidatas e obedece.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let quote: any = null;
  let isOrderConfirmation = false;
  // Pós-cotação: a farmácia fala DEPOIS de ter cotado, ANTES de o paciente decidir (frete,
  // "nome de quem recebe", prazo). A conversa continua — com o agente em modo próprio.
  let isPostQuote = false;

  {
    const { data: rows } = await db
      .from('quotes')
      .select('*, orders(*), suppliers(*)')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: false })
      .limit(40);
    const candidatas: CotacaoCandidata[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const porId = new Map<string, any>();
    for (const r of (rows ?? []) as Array<Record<string, unknown>>) {
      const o = r['orders'] as { status?: string; selected_quote_id?: string | null; closed_at?: string | null; created_at?: string } | null;
      if (!o) continue;
      porId.set(r['id'] as string, r);
      candidatas.push({
        id: r['id'] as string,
        orderId: r['order_id'] as string,
        status: String(r['status'] ?? ''),
        createdAt: String(r['created_at'] ?? ''),
        completedAt: (r['completed_at'] as string | null) ?? null,
        order: {
          status: String(o.status ?? ''),
          selectedQuoteId: o.selected_quote_id ?? null,
          closedAt: o.closed_at ?? null,
          createdAt: String(o.created_at ?? ''),
        },
      });
    }
    const decisao = decidirRotaDaMensagem(candidatas, text, Date.now());
    if (decisao.ambiguidade) {
      await writeLog(
        decisao.ambiguidade === 'pedidos_distintos' ? 'error' : 'warn',
        'supplier',
        decisao.ambiguidade === 'pedidos_distintos'
          ? `🚨 cotações de PEDIDOS DIFERENTES concorrendo na mesma conversa (rota ${decisao.rota}) — resposta atribuída à mais recente; risco de misturar clientes`
          : `⚠️ cotações do MESMO pedido na mesma conversa (rota ${decisao.rota}) — resposta atribuída à mais recente`,
        { traceId, conversationId, quoteId: decisao.cotacao?.id },
      );
    }
    await writeLog('info', 'supplier', `Rota da mensagem da farmácia: ${decisao.rota} — ${decisao.motivo}`, {
      traceId, conversationId, quoteId: decisao.cotacao?.id ?? null, orderId: decisao.cotacao?.orderId ?? null, candidatas: candidatas.length,
    });

    switch (decisao.rota) {
      case 'negociacao':
        quote = porId.get(decisao.cotacao!.id) ?? null;
        break;
      case 'pos_venda':
        quote = porId.get(decisao.cotacao!.id) ?? null;
        isOrderConfirmation = true;
        break;
      case 'pos_cotacao':
        quote = porId.get(decisao.cotacao!.id) ?? null;
        isPostQuote = true;
        break;
      case 'tardia': {
        // 🔁 REVIVE DE RESPOSTA TARDIA: a farmácia respondeu DEPOIS do timeout e o pedido ainda
        // faz sentido → reabre a negociação. Pedido 'failed' (usuário já ouviu "ninguém
        // respondeu") volta pra 'quoting' com created_at=now (reinicia o relógio do rescue).
        const late = porId.get(decisao.cotacao!.id);
        const lateOrder = late?.orders as { status?: string } | null;
        await db.from('quotes').update({ status: 'negotiating', completed_at: null }).eq('id', late.id);
        if (lateOrder?.status === 'failed') {
          await db.from('orders').update({ status: 'quoting', created_at: new Date().toISOString() }).eq('id', late.order_id).eq('status', 'failed');
        }
        quote = { ...late, status: 'negotiating' };
        await writeLog('info', 'supplier', `🔁 Resposta TARDIA da farmácia — cotação revivida (pedido estava '${lateOrder?.status}')`, {
          traceId, conversationId, quoteId: late.id, orderId: late.order_id,
        });
        break;
      }
      case 'nenhuma':
      default:
        break;
    }
  }

  // Fallback histórico: cotação em negociação deste FORNECEDOR fora desta conversa (conversa
  // recriada/renumerada). Só quando o resolvedor não achou nada.
  if (!quote && conv.supplier_id) {
    const { data } = await db
      .from('quotes')
      .select('*, orders(*), suppliers(*)')
      .eq('supplier_id', conv.supplier_id)
      .in('status', ['pending', 'contacting', 'negotiating'])
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    quote = data;
  }

  if (!quote) {
    await writeLog('warn', 'supplier', 'Nenhuma cotação ativa encontrada para este fornecedor', { traceId, conversationId });
    return;
  }

  // 3b. FREEZE (Fix #2): pedido já DECIDIDO e esta NÃO é a cotação escolhida →
  // retardatária de pedido fechado. Não negocia (não grava preço, não relaya
  // pergunta ao usuário); só encerra a cotação. A ESCOLHIDA segue normalmente pelo
  // ramo isOrderConfirmation (logística pós-venda).
  {
    const ordSt = quote.orders as { status?: string; selected_quote_id?: string | null } | null;
    if (
      ordSt &&
      ['confirming', 'handed_off', 'cancelled'].includes(ordSt.status ?? '') &&
      ordSt.selected_quote_id !== quote.id
    ) {
      await writeLog('info', 'supplier', `Farmácia retardatária de pedido já '${ordSt.status}' — ignorada (não é a escolhida)`, { traceId, conversationId, quoteId: quote.id });
      await db.from('quotes')
        .update({ status: 'timeout', completed_at: new Date().toISOString() })
        .eq('id', quote.id)
        .in('status', ['pending', 'contacting', 'negotiating']);
      return;
    }
  }

  // 4. Guard: turn limit (12 turns = 24 messages) — SÓ NEGOCIAÇÃO. Pós-venda e pós-cotação
  // não têm limite de turnos (a janela de 72h do pós-venda e a de 24h do pedido vivo já são
  // a proteção anti-conversa-morta — e estão dentro do resolvedor).
  if (!isOrderConfirmation && !isPostQuote) {
    const { count: msgCount } = await db
      .from('messages')
      .select('*', { count: 'exact', head: true })
      .eq('conversation_id', conversationId)
      .gte('created_at', quote.created_at);

    if ((msgCount ?? 0) > 24) {
      await finalizeQuote(quote.id, quote.order_id, 'timeout', traceId);
      return;
    }
  }

  // 5. Mark as negotiating
  await db.from('quotes')
    .update({ status: 'negotiating' })
    .eq('id', quote.id)
    .in('status', ['pending', 'contacting']);

  // 6. Build context
  const history = await getConversationMessages(conversationId, 24);
  const order = quote.orders as {
    user_id?: string;
    items: OrderItem[];
    delivery_address?: string | null;
    delivery_lat?: number;
    delivery_lng?: number;
    payment_method?: string | null;
  } | null;

  // CPF do cliente (política do fundador: responder o CPF na hora e continuar). Fica no
  // contexto do agente pra ele responder direto quando a farmácia pedir — sem re-perguntar.
  let clientCpf: string | null = null;
  let recipientName: string | null = null;
  if (order?.user_id) {
    const { data: uRow } = await db.from('users').select('document_cpf, preferred_name, full_name').eq('id', order.user_id).maybeSingle();
    clientCpf = (uRow?.document_cpf as string | null) ?? null;
    // Nome de quem recebe (pós-fechamento: "procura quem?") — perfil, primeiro do preferred.
    recipientName = ((uRow?.preferred_name as string | null)?.trim()) || ((uRow?.full_name as string | null)?.trim()) || null;
  }

  // O que o cliente JÁ respondeu a OUTRAS farmácias deste pedido (reuso — o agente
  // responde perguntas iguais sozinho, sem re-perguntar; incidente Cefaliv: "não quero genérico" ×N).
  let clientAnswers: string[] = [];
  if (quote.order_id) {
    const { data: answered } = await db.from('quotes')
      .select('clarification_question, clarification_answer, clarification_answered_at')
      .eq('order_id', quote.order_id)
      .not('clarification_answer', 'is', null)
      .order('clarification_answered_at', { ascending: true })
      .limit(10);
    const seen = new Set<string>();
    for (const r of answered ?? []) {
      const a = (r.clarification_answer as string | null)?.trim();
      if (!a) continue;
      const line = r.clarification_question
        ? `Perguntaram "${(r.clarification_question as string).slice(0, 90)}" → cliente: "${a.slice(0, 90)}"`
        : `Cliente disse: "${a.slice(0, 90)}"`;
      if (!seen.has(line)) { seen.add(line); clientAnswers.push(line); }
    }
  }

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
        deliveryAddress: order?.delivery_address ?? null, // endereço real p/ a farmácia (Caso D/frete)
        paymentMethod: order?.payment_method ?? null,
        cpf: clientCpf, // responde direto se a farmácia pedir CPF (Caso F)
        clientAnswers, // reusa respostas do cliente (não re-pergunta o que ele já disse)
        isOrderConfirmation,
        isPostQuote,
        quotedSoFar: isPostQuote ? { total: quote.total != null ? Number(quote.total) : null, deliveryFee: quote.delivery_fee != null ? Number(quote.delivery_fee) : null } : null,
        recipientName, // pós-fechamento: responde "procura quem?" com o nome de quem recebe
        // Link do Maps SÓ pra quando a farmácia pedir a localização (pedido fechado) —
        // mandado casual em 1 linha, nunca no fechamento (humano não manda link com rótulo).
        mapsUrl: order?.delivery_lat != null && order?.delivery_lng != null
          ? `https://www.google.com/maps?q=${Number(order.delivery_lat).toFixed(6)},${Number(order.delivery_lng).toFixed(6)}`
          : null,
      });

  // 7. Call LLM (Agent persona)
  let llmResponse;
  try {
    llmResponse = await chat(text, {
      model: cfg.llm_model || process.env['OPENROUTER_MODEL'] || 'openai/gpt-4.1-mini',
      apiKey: cfg.llm_api_key || process.env['OPENROUTER_API_KEY'],
      systemInstruction: systemPrompt,
      history: messagesToHistory(history.slice(0, -1) as Message[]),
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
  let quoteRecorded = false;   // pra fallback determinístico quando o LLM não gera texto
  let recordedFrete = 0;
  // Frete CONHECIDO (valor OU grátis) vs DESCONHECIDO — pra não re-perguntar o frete
  // quando a farmácia já disse que é grátis (incidente Droga Mauge 07/07). A farmácia
  // costuma dizer "entrega grátis" na ABERTURA e o preço só depois → varre TAMBÉM as
  // mensagens ANTERIORES dela (direction 'in'), não só o texto atual (review F4).
  let freteKnown = mentionsFreeShipping(text)
    || (history ?? []).some((m) => m.direction === 'in' && mentionsFreeShipping(m.content ?? ''));
  let referralRecorded = false; // indicação seguida → agradece mesmo com outcome unavailable
  // Resposta CONDICIONAL (tem o item mas com ressalva / ofereceu Uber, retirada, etc. —
  // CASO C3): a farmácia engajou, então NÃO fica no vácuo (silêncio) como um unavailable
  // seco — manda um ack humano segurando a conversa (incidente São Benedito 07/07).
  let conditionalOfferRecorded = false;
  let customerNotified = false; // o agente já repassou algo ao CLIENTE neste turno (notify_customer)
  let clarificationRequested = false; // request_clarification já levou pergunta ao paciente neste turno

  for (const tc of llmResponse.toolCalls) {
    switch (tc.name) {
      case 'record_quote_price': {
        const a = tc.args as {
          total: number; subtotal?: number; delivery_fee?: number;
          eta_minutes?: number; payment_methods?: string[];
          pix_key?: string; payment_link?: string; notes?: string;
          product_as_quoted?: string; is_substitute?: boolean; presentation?: string;
        };
        quoteRecorded = true;
        recordedFrete = a.delivery_fee ?? 0;
        // frete conhecido se a farmácia deu um valor (inclui 0 = grátis explícito) OU disse grátis no texto
        if (a.delivery_fee !== undefined) freteKnown = true;
        // 🧾 O QUE FOI COTADO, como dado (caso Ludmila): o agente diz o produto como a farmácia
        // falou; se não disse, o texto cru da farmácia ainda pode denunciar substituição ("só
        // tenho o Venaflon"). Sem nome e sem sinal → cotado=null (nunca "é o pedido" por omissão).
        const pedidoNome = (order?.items ?? []).map((i) => itemDisplayName(i.name, i.dosage)).join(' + ') || 'o pedido';
        const detect = detectarSubstitutoOferecido(text, (order?.items ?? [])[0]?.name ?? pedidoNome);
        const produtoCotado = montarProdutoCotado({
          pedido: pedidoNome,
          cotado: a.product_as_quoted ?? detect.nome ?? null,
          substituto: a.is_substitute ?? (detect.substituto ? true : null),
          apresentacao: a.presentation ?? null,
          fonte: 'agente',
        });
        // `total` guardado = remédios SEM frete (a apresentação soma o frete por cima); o modelo às
        // vezes manda o total já com frete — normaliza (pos-cotacao.ts).
        const preco = normalizarPrecoDaCotacao({ total: a.total, subtotal: a.subtotal, deliveryFee: a.delivery_fee, totalJaRegistrado: isPostQuote && quote.total != null ? Number(quote.total) : null });
        const { error: qErr } = await db.from('quotes').update({
          status: 'quoted',
          subtotal: a.subtotal ?? null,
          delivery_fee: preco.frete ?? (isPostQuote && quote.delivery_fee != null ? quote.delivery_fee : null),
          total: preco.remedios,
          eta_minutes: a.eta_minutes ?? null,
          // Forma de pagamento: SÓ o que a farmácia disse. Vazio = "a combinar" (nunca "pix" por default).
          payment_methods: a.payment_methods ?? [],
          pix_key: a.pix_key ?? null,
          payment_link: a.payment_link ?? null,
          notes: a.notes ?? null,
          items_available: [produtoCotado] as never,
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
          // Se as opções JÁ foram apresentadas e esta é mais barata, avisa (incidente Glauber).
          await notifyBetterQuoteIfPresented(quote.order_id, quote.id, traceId).catch(() => { /* aviso é cortesia */ });
        }
        shouldFinalize = true;
        outcome = 'quoted';
        break;
      }
      case 'record_supplier_unavailable': {
        const a = tc.args as { reason?: string };
        // 🔴 BUG IRMÃO (09/07, pedido Pietra ED 7a3d5a94): no modo confirmação a cotação
        // é a ESCOLHIDA de um pedido JÁ FECHADO — rebaixá-la pra 'unavailable' quebra o
        // lookup do pós-venda (que busca 'quoted') e mata o relay pra sempre. Pós-fechamento,
        // "indisponível" é NOTÍCIA GRAVE pro cliente (a farmácia não vai entregar!): preserva
        // a cotação (registro histórico do pedido) e leva a notícia ao cliente na hora.
        if (isOrderConfirmation) {
          await writeLog('warn', 'supplier', `Farmácia sinalizou problema PÓS-fechamento ("${(a.reason ?? 'sem motivo').slice(0, 80)}") — cotação escolhida preservada; avisando o cliente`, { traceId, quoteId: quote.id, orderId: quote.order_id });
          if (quote.order_id) {
            const supName = (quote.suppliers as { name?: string } | null)?.name ?? 'A farmácia';
            // sanitizeSupplierNote: o reason é texto do LLM alimentado pela FARMÁCIA — vai
            // pro WhatsApp do paciente, então mascara telefone/CPF e remove URLs (padrão
            // defense-in-depth da casa; review 10/07 #8).
            const reason = sanitizeSupplierNote(a.reason);
            const userMsg = reason
              ? `Oi! A ${supName} avisou que teve um problema com o seu pedido: "${reason}". Quer que eu procure outra farmácia pra você?`
              : `Oi! A ${supName} avisou que não vai conseguir atender o seu pedido 😔 Quer que eu procure outra farmácia pra você?`;
            const relayed = await relayToCustomer(quote.order_id, userMsg, traceId);
            if (relayed !== 'failed') customerNotified = true; // avisado (ou já avisado há pouco)
            if (relayed === 'sent') {
              await db.from('orders').update({ customer_relayed_at: new Date().toISOString() }).eq('id', quote.order_id);
            }
          }
          break;
        }
        await db.from('quotes').update({ status: 'unavailable', completed_at: new Date().toISOString(), notes: a.reason ?? null }).eq('id', quote.id);
        // CASO C3: tem o item mas com ressalva / ofereceu alternativa (Uber, retirada…) →
        // a farmácia engajou, não deixa no vácuo (o ack humano do LLM vai sair na etapa 10).
        if (noteSignalsConditionalOffer(a.reason)) conditionalOfferRecorded = true;
        await writeLog('info', 'quote', `❌ Farmácia indisponível: ${a.reason ?? 'sem motivo'}${conditionalOfferRecorded ? ' (condicional/ofereceu alternativa)' : ''}`, { traceId, quoteId: quote.id });
        shouldFinalize = true;
        outcome = 'unavailable';
        break;
      }
      case 'record_referral': {
        // 🔗 INDICAÇÃO AUTÔNOMA (pedido do fundador, 1º dia real): a farmácia passou
        // OUTRO número ("fala com a Tamandaré, o Whats é X") → a Xarlote contata o
        // indicado sozinha e cota lá. Guardas: telefone real (nunca placeholder),
        // dedup contra fornecedores já cotados neste pedido, cap de 3 indicações por
        // pedido (anti-loop de farmácias se indicando em círculo), pedido ainda vivo.
        const a = tc.args as { referred_phone?: string; referred_name?: string; note?: string };
        const refPhone = toE164BR(a.referred_phone);
        if (!refPhone || isPlaceholderPhone(refPhone)) {
          await writeLog('warn', 'referral', `Indicação com telefone inválido ("${a.referred_phone}") — ignorada`, { traceId, quoteId: quote.id });
          break;
        }
        referralRecorded = true; // agradece a indicação mesmo com outcome unavailable
        try {
          const orderId = quote.order_id as string;
          // Pedido ainda faz sentido? (revive já flipou failed→quoting se foi resposta tardia)
          const { data: ordNow } = await db.from('orders').select('status, conversation_id, payment_method').eq('id', orderId).single();
          if (!ordNow || ordNow.status !== 'quoting') {
            await writeLog('info', 'referral', `Indicação recebida mas pedido está '${ordNow?.status}' — não vou contatar (registrado no log)`, { traceId, orderId });
            break;
          }
          // Cap anti-loop: no máx 3 cotações por indicação neste pedido
          const { count: refCount } = await db.from('quotes')
            .select('id', { count: 'exact', head: true })
            .eq('order_id', orderId).ilike('notes', 'indicação%');
          if ((refCount ?? 0) >= 3) {
            await writeLog('warn', 'referral', 'Cap de 3 indicações por pedido atingido — não vou contatar mais', { traceId, orderId });
            break;
          }
          // Dedup: o indicado já está neste pedido? (casa variantes do 9º dígito)
          const phoneVariants = brPhoneVariants(refPhone);
          const { data: existingSup } = await db.from('suppliers')
            .select('id, name').or(phoneVariants.map((p) => `whatsapp_e164.eq.${p}`).join(','))
            .limit(1).maybeSingle();
          let refSupplierId = existingSup?.id as string | undefined;
          if (refSupplierId) {
            const { data: dupQuote } = await db.from('quotes').select('id')
              .eq('order_id', orderId).eq('supplier_id', refSupplierId).limit(1).maybeSingle();
            if (dupQuote) {
              await writeLog('info', 'referral', 'Indicado já está sendo cotado neste pedido — dedup', { traceId, orderId });
              break;
            }
          } else {
            const { data: newSup } = await db.from('suppliers').insert({
              type: 'pharmacy',
              name: (a.referred_name ?? '').trim() || 'Farmácia indicada',
              whatsapp_e164: refPhone,
              phone_e164: refPhone,
              status: 'active',
            }).select('id').single();
            refSupplierId = newSup?.id;
          }
          if (!refSupplierId) break;
          const supplierName = (quote.suppliers as { name?: string } | null)?.name ?? 'outra farmácia';
          const { data: refQuote } = await db.from('quotes').insert({
            order_id: orderId,
            supplier_id: refSupplierId,
            status: 'pending',
            notes: `indicação de ${supplierName}${a.note ? ` — ${a.note}` : ''}`,
          }).select('id').single();
          if (!refQuote?.id) break;

          // Contexto do usuário pra abertura (mesma assinatura do fluxo normal)
          const { data: uconv } = await db.from('conversations').select('id, whatsapp_jid').eq('id', ordNow.conversation_id ?? '').maybeSingle();
          const userPhone = uconv?.whatsapp_jid ? `+${uconv.whatsapp_jid.replace('@s.whatsapp.net', '')}` : '';
          const itemsForRef = (order?.items ?? []) as OrderItem[];
          const refQuoteId = refQuote.id as string;
          setImmediate(() => {
            initiatePharmacyNegotiation(
              refQuoteId, orderId, itemsForRef, userNeighborhood,
              (ordNow.payment_method as string | null) ?? null,
              uconv?.id ?? '', userPhone, traceId,
            ).catch((err) => writeLog('error', 'referral', `Negociação com indicado falhou: ${String(err).slice(0, 160)}`, { traceId, orderId }));
          });
          await writeAudit({
            actorType: 'agent_pharmacy',
            actorId: 'agent-pharmacy',
            action: 'quote.referral_followed',
            targetTable: 'quotes',
            targetId: refQuoteId,
            traceId,
            metadata: { order_id: orderId, referred_by: supplierName, referred_phone: refPhone.slice(0, 6) + '***' },
          });
          await writeLog('info', 'referral', `🔗 Indicação seguida AUTONOMAMENTE: contatando ${a.referred_name ?? refPhone.slice(0, 6) + '***'} (indicado por ${supplierName})`, { traceId, orderId, refQuoteId });
          // Avisa o USUÁRIO que a Xarlote está seguindo a pista sozinha (transparência
          // do trabalho autônomo — ele vê que ela correu atrás em vez de desistir).
          if (uconv?.id && userPhone) {
            const refLabel = (a.referred_name ?? '').trim() || 'outra farmácia';
            await sendOutbound(uconv.id, userPhone,
              `A ${supplierName} não tinha, mas me indicou ${refLabel} — já estou falando com eles pra cotar pra você 🔎`,
              traceId).catch(() => { /* aviso é cortesia, não bloqueia */ });
          }
        } catch (err) {
          await writeLog('error', 'referral', `Falha ao seguir indicação: ${String(err).slice(0, 200)}`, { traceId, quoteId: quote.id });
        }
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
      case 'request_clarification': {
        // Agente precisa de um dado do paciente → leva a pergunta ao CLIENTE
        // (sara) e marca a cotação como aguardando resposta (pausa a consolidação).
        // O `llmResponse.text` segue como mensagem de espera pra farmácia (etapa 10).
        const a = tc.args as { question?: string };
        const question = (a.question ?? '').trim();
        if (question) {
          clarificationRequested = true;
          // try/catch pra uma falha no relay não abortar o handler (a farmácia ainda
          // recebe a resposta de espera do LLM na etapa 10).
          try {
            await relaySupplierQuestionToUser(quote, question, traceId);
          } catch (err) {
            await writeLog('error', 'agent', `Falha ao levar pergunta da farmácia ao cliente: ${String(err)}`, { traceId, conversationId });
          }
        }
        break;
      }
      case 'record_order_confirmation': {
        // Pharmacy confirmed the order is being prepared
        const a = tc.args as { estimated_delivery_minutes?: number; notes?: string };
        await db.from('quotes').update({
          eta_minutes: a.estimated_delivery_minutes ?? quote.eta_minutes,
          notes: a.notes ?? quote.notes,
        }).eq('id', quote.id);
        // Sinal REAL de confirmação (≠ "a farmácia mandou qualquer coisa"): o order-followup
        // usa supplier_confirmed_at pra suprimir o alerta de prazo ao cliente. Antes ele
        // suprimia com QUALQUER inbound da farmácia após o fechamento → um "blz" jogado
        // desarmava o aviso e mascarava o incidente Santa Lúcia (review 08/07).
        if (quote.order_id) {
          await db.from('orders').update({ supplier_confirmed_at: new Date().toISOString() }).eq('id', quote.order_id);
        }
        await writeLog('info', 'order', `✅ Farmácia confirmou preparo do pedido${a.estimated_delivery_minutes ? ` — ETA: ${a.estimated_delivery_minutes}min` : ''}`, { traceId, quoteId: quote.id });
        break;
      }
      case 'notify_customer': {
        // Relay farmácia→CLIENTE (incidente Vadivino): no modo confirmação (pós-fechamento) e no
        // pós-cotação (a farmácia avisou algo depois de cotar). Na negociação, quem fala com o
        // cliente é o inbound-user, não o agente da farmácia.
        if (!isOrderConfirmation && !isPostQuote) {
          await writeLog('warn', 'agent', 'notify_customer fora do modo confirmação — ignorada', { traceId, conversationId });
          break;
        }
        const a = tc.args as { message?: string };
        // sanitizeSupplierNote: msg redigida pelo agente A PARTIR do texto da farmácia —
        // defense-in-depth contra telefone/pix/URL injetados chegando ao paciente (review #8).
        const m = sanitizeSupplierNote(a.message);
        if (m && quote.order_id) {
          const relayed = await relayToCustomer(quote.order_id, m, traceId);
          if (relayed !== 'failed') customerNotified = true;
          if (relayed === 'sent') {
            await db.from('orders').update({ customer_relayed_at: new Date().toISOString() }).eq('id', quote.order_id);
            await writeLog('info', 'supplier', `📣 Relay farmácia→cliente: "${m.slice(0, 80)}"`, { traceId, orderId: quote.order_id, quoteId: quote.id });
          }
        }
        break;
      }
      default:
        await writeLog('warn', 'agent', `Tool desconhecida chamada: ${tc.name}`, { traceId });
    }
  }

  // 10. Envia o texto pra farmácia. Manda SEMPRE que houver texto, EXCETO nos
  // outcomes silenciosos (unavailable/timeout — Caso C). Antes suprimia em QUALQUER
  // finalize, então a farmácia dava o preço e ouvia SILÊNCIO (a despedida "anotado,
  // vou confirmar com o cliente" do Caso A1 nunca saía).
  // Indicação seguida NÃO é silêncio: a farmácia ajudou — agradece (mesmo unavailable).
  // Resposta CONDICIONAL (CASO C3) também NÃO é silêncio: a farmácia ofereceu algo (Uber,
  // retirada) e ficaria no vácuo — manda um ack humano segurando a conversa.
  const silentOutcome = (outcome === 'unavailable' || outcome === 'timeout') && !referralRecorded && !conditionalOfferRecorded;

  // 🛡️ DUAS GUARDAS SOBRE O QUE O AGENTE VAI DIZER À FARMÁCIA (caso Ludmila, 10/09):
  //
  // (1) ACEITE DE SUBSTITUTO SEM CONSENTIMENTO. "Venaflon serve sim" saiu porque o pedido
  //     nasceu com substitutes_ok=true preenchido pelo modelo — a paciente nunca foi perguntada.
  //     Se nenhum item tem substitutes_ok=true, a frase de aceite vira "vou confirmar".
  // (2) NOME SUGERIDO PELA FARMÁCIA. A farmacêutica perguntou "Seria Daflon?" e o agente
  //     respondeu "Não, é Aflor 1000 Flex mesmo" — defendendo uma leitura de foto que ninguém
  //     checou. Quando o nome do item não está verificado e a farmácia sugere outro, a
  //     sugestão vai ao paciente e a farmácia ouve cortesia, nunca insistência.
  let textoParaFarmacia = llmResponse.text.trim();
  {
    const itens = (order?.items ?? []) as OrderItem[];
    const guarda = consertarAceiteDeSubstituto(textoParaFarmacia, itens);
    if (guarda.corrigiu) {
      textoParaFarmacia = guarda.texto;
      await writeLog('warn', 'agent', `🛡️ Aceite de substituto SEM consentimento do paciente barrado — texto trocado por "vou confirmar" (era: "${llmResponse.text.trim().slice(0, 60)}")`, { traceId, conversationId, quoteId: quote.id });
    }
    const primeiro = itens[0];
    const sugestao = primeiro && primeiro.name_verified !== true && !isOrderConfirmation
      ? sugestaoDeNomeDaFarmacia(text, primeiro.name)
      : null;
    if (sugestao && primeiro && !clarificationRequested) {
      const supName = (quote.suppliers as { name?: string } | null)?.name ?? 'a farmácia';
      try {
        await relaySupplierQuestionToUser(quote, perguntaSobreSugestaoDeNome(supName, sugestao, itemDisplayName(primeiro.name, primeiro.dosage)), traceId);
        clarificationRequested = true;
        textoParaFarmacia = 'Deixa eu confirmar o nome certinho e já te falo, tá?';
        // A cotação fica aguardando o paciente; não finaliza como unavailable por causa disso.
        if (outcome === 'unavailable') { shouldFinalize = false; outcome = ''; }
        await writeLog('warn', 'agent', `🛡️ Farmácia sugeriu outro nome ("${sugestao}") e o item não está verificado — levado ao paciente, sem insistir`, { traceId, conversationId, quoteId: quote.id });
      } catch (err) {
        await writeLog('error', 'agent', `Falha ao levar sugestão de nome ao paciente: ${String(err).slice(0, 120)}`, { traceId, quoteId: quote.id });
      }
    }
  }

  if (textoParaFarmacia && pareceNarracaoInterna(textoParaFarmacia)) {
    // Narração interna ("o cliente quer…", "vou perguntar ao paciente") nunca vai pra farmácia.
    await writeLog('warn', 'agent', `🛡️ Narração interna barrada antes de ir à farmácia: "${textoParaFarmacia.slice(0, 80)}"`, { traceId, conversationId });
    textoParaFarmacia = CORTESIA_NEUTRA;
  }
  if (textoParaFarmacia && !silentOutcome) {
    await sendOutboundToSupplier(conversationId, supplierPhone, textoParaFarmacia, traceId);
  } else if (!llmResponse.text.trim() && referralRecorded) {
    // Fallback determinístico do agradecimento da indicação (turno só-tool).
    await sendOutboundToSupplier(conversationId, supplierPhone, 'Ah, perfeito! Muito obrigada pela indicação, vou falar com eles. 🙏', traceId);
  } else if (!llmResponse.text.trim() && conditionalOfferRecorded) {
    // Fallback determinístico do ack condicional (CASO C3, turno só-tool): não deixa a
    // farmácia que ofereceu alternativa no vácuo (era o buraco do incidente São Benedito).
    await sendOutboundToSupplier(conversationId, supplierPhone, 'Entendi! Deixa eu confirmar aqui com quem vai receber e já te falo, tá? 🙂', traceId);
  } else if (!llmResponse.text.trim() && quoteRecorded && !silentOutcome) {
    // FALLBACK DETERMINÍSTICO: o gpt-4.1-mini às vezes registra a cotação via tool
    // SEM gerar texto → a farmácia ficava no vácuo. Aqui garantimos uma resposta:
    // se o frete ainda não veio, passamos o ENDEREÇO REAL e pedimos o frete; se já
    // veio, despedida. (Não depende do LLM produzir texto.)
    const addr = shortSupplierAddress(order?.delivery_address) || userNeighborhood;
    // Tom humano + frete-aware: se o frete JÁ é conhecido (valor ou grátis), NÃO
    // re-pergunta — só confirma que vai fechar com o cliente. Sem "o cliente"/"volto".
    const fallbackMsg = freteKnown
      ? 'Perfeito, anotei aqui! Já confirmo e volto pra fechar com você, tá? 🙂'
      : `Anotado! A entrega é aqui em ${addr} — quanto fica o frete pra esse endereço?`;
    await sendOutboundToSupplier(conversationId, supplierPhone, fallbackMsg, traceId);
    await writeLog('info', 'agent', 'Resposta determinística à farmácia (LLM não gerou texto)', { traceId, conversationId, freteConhecido: freteKnown });
  } else if (!llmResponse.text.trim() && !shouldFinalize && llmResponse.toolCalls.length === 0) {
    // FALLBACK DETERMINÍSTICO DE PREÇO (Fix #3 — lost-offer). O agente devolveu turno
    // VAZIO (sem tool, sem texto) — mas a farmácia pode ter mandado um preço real (caso
    // SeteFarma: "só tenho 20 comp, 65,00"). Antes virava timeout e a oferta VÁLIDA (a
    // mais barata!) era perdida em silêncio. Agora extraímos o preço do texto cru e
    // registramos a cotação. Conservador: se não houver preço confiável, extractPriceBRL
    // devolve null e caímos no log de "resposta vazia" de sempre.
    const price = extractPriceBRL(text);
    // 🛡️ SANIDADE DE PREÇO (incidente Vadivino 13–17/07): a auto-captura é TERMINAL — grava
    // `status='quoted'` e a cotação some do lookup de negociação, então um valor errado
    // CONGELA e nunca mais é corrigido (a farmácia disse "74,94" e o pedido fechou com
    // R$4,95). O número pode vir de outra mensagem da rajada, de foto de etiqueta ou de
    // preço unitário. Antes de congelar, compara com as IRMÃS do mesmo pedido: divergência
    // absurda pra baixo (>4×) não vira cotação — segue como conversa pro agente/farmácia
    // esclarecerem. Sem irmãs com preço, não há base de comparação → deixa passar (como antes).
    let priceLooksSane = true;
    if (price != null && quote.status !== 'quoted') {
      const { data: siblings } = await db.from('quotes')
        .select('total').eq('order_id', quote.order_id).not('total', 'is', null).neq('id', quote.id);
      const totals = (siblings ?? []).map((s) => Number(s.total)).filter((n) => Number.isFinite(n) && n > 0);
      if (totals.length) {
        const cheapest = Math.min(...totals);
        if (price * 4 < cheapest) {
          priceLooksSane = false;
          await writeLog('warn', 'quote', `Auto-captura de preço RECUSADA por sanidade: R$${price} destoa das outras cotações (mais barata R$${cheapest}) — perguntando à farmácia em vez de congelar`, {
            traceId, quoteId: quote.id, orderId: quote.order_id,
          });
          // NÃO descarta em silêncio: um preço destoante pode ser (a) unitário em vez do
          // total, (b) de outro item da rajada — ou (c) uma oferta LEGÍTIMA bem mais barata
          // (genérico). Descartar calado perderia a (c) e deixaria a farmácia no vácuo até
          // dar timeout. Pergunta e deixa ELA esclarecer — vira conversa, não aposta (review).
          try {
            await sendOutboundToSupplier(
              conversationId,
              supplierPhone,
              `Só pra eu não errar: o R$ ${price.toFixed(2).replace('.', ',')} é o valor TOTAL do pedido ou o preço de uma unidade? 🙏`,
              traceId,
            );
          } catch (e) {
            await writeLog('warn', 'quote', `Falha ao pedir confirmação de preço à farmácia: ${String(e).slice(0, 120)}`, { traceId, quoteId: quote.id });
          }
        }
      }
    }
    if (price != null && priceLooksSane && quote.status !== 'quoted') {
      const offered = parseUnitCount(text);
      const requested = parseUnitCount(
        (order?.items ?? []).map((i) => `${i.dosage ?? ''} ${i.quantity ?? ''}`).join(' '),
      );
      // Substituição de apresentação (ex.: pediu 30 comp, farmácia só tem 20): registra
      // mesmo assim (não perde a oferta) MAS anota a diferença — a consolidação mostra a
      // nota pro usuário decidir informado (ele ainda confirma antes de comprar).
      // Marcador CANÔNICO "subst:só tem N comp" (a consolidação só exibe esse formato —
      // nunca texto livre do LLM, pra não vazar nota interna ao usuário).
      const substNote = offered && requested && offered !== requested ? ` | subst:só tem ${offered} comp` : '';
      // 🧾 Identidade do produto na auto-captura (caso Ludmila): "só estou tendo o Venaflon,
      // concorrente do Daflon" + "a cx com 30 cpr 64.90" gravava R$64,90 e NADA sobre o produto.
      // O texto cru da farmácia (rajada inteira) decide o que dá pra afirmar; o resto fica null.
      const pedidoNome = (order?.items ?? []).map((i) => itemDisplayName(i.name, i.dosage)).join(' + ') || 'o pedido';
      const rajada = (history ?? []).filter((m) => m.direction === 'in').slice(-3).map((m) => m.content ?? '').join('\n') + '\n' + text;
      const detect = detectarSubstitutoOferecido(rajada, (order?.items ?? [])[0]?.name ?? pedidoNome);
      const produtoAuto = montarProdutoCotado({
        pedido: pedidoNome,
        cotado: detect.nome,
        substituto: detect.substituto ? true : null,
        apresentacao: offered ? `${offered} comprimidos` : null,
        fonte: 'auto_captura',
      });
      const { error: qErr } = await db.from('quotes').update({
        status: 'quoted',
        total: price,
        // frete A CONFIRMAR (null, NÃO 0): 0 vira "frete grátis" na consolidação — mentira
        // sobre o custo. A resposta tardia do frete agora chega pela rota pós-cotação.
        delivery_fee: null,
        // Forma de pagamento DESCONHECIDA fica vazia — antes gravava ['pix'] e a paciente lia "pix"
        // numa cotação em que a farmácia nunca falou de pagamento.
        payment_methods: [],
        notes: `auto-capturado${substNote}`,
        items_available: [produtoAuto] as never,
        completed_at: new Date().toISOString(),
      }).eq('id', quote.id).in('status', ['pending', 'contacting', 'negotiating']);
      if (qErr) {
        await writeLog('error', 'quote', `Fix#3: erro ao gravar cotação capturada: ${qErr.message}`, { traceId, quoteId: quote.id });
      } else {
        quoteRecorded = true;
        shouldFinalize = true;
        outcome = 'quoted';
        await writeLog('info', 'quote', `💰 Fix#3: preço R$${price} capturado do texto (agente ficou mudo)${substNote}`, { traceId, quoteId: quote.id, price });
        const supplierName = (quote.suppliers as { name?: string } | null)?.name ?? 'farmácia';
        await notifyUserQuoteArrived(quote.order_id, supplierName, traceId).catch(() => { /* aviso é cortesia */ });
        await notifyBetterQuoteIfPresented(quote.order_id, quote.id, traceId).catch(() => { /* cortesia */ });
        const addr = shortSupplierAddress(order?.delivery_address) || userNeighborhood;
        // Se a farmácia já disse grátis na mesma mensagem do preço, não re-pergunta o frete.
        const followUp = freteKnown
          ? 'Perfeito, anotei! Já confirmo aqui e volto pra fechar, tá? 🙂'
          : `Anotado! A entrega é aqui em ${addr} — quanto fica o frete pra esse endereço?`;
        await sendOutboundToSupplier(conversationId, supplierPhone, followUp, traceId);
      }
    } else {
      // Turno genuinamente vazio (sem preço) — log de sempre.
      await writeLog('warn', 'agent', 'Agente retornou resposta vazia sem tools — nenhuma ação tomada', { traceId, conversationId });
    }
  }

  // 10c. PÓS-COTAÇÃO — o que a farmácia disse DEPOIS de cotar vira dado e chega ao paciente
  // (caso Ludmila, 10/09: "69.90", "qual nome de quem recebe?", "5 reais de frete" — nada
  // chegou; a Xarlote ainda perguntou o frete mais 3 vezes). Determinístico, independe do
  // agente ter chamado tool: captura frete/total, marca substituto denunciado no texto,
  // responde cortesia à pergunta de nome (uma vez) e, se a OFERTA mudou, manda UM update ao
  // paciente re-ancorando a apresentação (o "sim" dele fecha pelo backstop 11b).
  if (isPostQuote && quote.order_id) {
    const num = (v: unknown): number | null => (v == null || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);
    const produtoAntes = ((quote.items_available as ProdutoCotado[] | null) ?? [])[0] ?? null;
    const antes = { total: num(quote.total), deliveryFee: num(quote.delivery_fee), substituto: produtoAntes?.substituto ?? null };
    const { data: qNow } = await db.from('quotes').select('total, delivery_fee, eta_minutes, items_available').eq('id', quote.id).maybeSingle();
    let total = num(qNow?.total);
    let fee = num(qNow?.delivery_fee);
    let produto = ((qNow?.items_available as ProdutoCotado[] | null) ?? [])[0] ?? produtoAntes;
    const interp = interpretarMensagemPosCotacao(text, { total, deliveryFee: fee });
    const updates: Record<string, unknown> = {};
    if (fee == null && interp.frete != null) { fee = interp.frete; updates['delivery_fee'] = fee; }
    // "69.90" solto com total 64.90: o total-base fica, o frete é a diferença (já em interp.frete).
    if (total == null && interp.novoTotal != null) { total = interp.novoTotal; updates['total'] = total; }
    const pedidoNome = (order?.items ?? []).map((i) => itemDisplayName(i.name, i.dosage)).join(' + ') || 'o pedido';
    const detect = detectarSubstitutoOferecido(text, (order?.items ?? [])[0]?.name ?? pedidoNome);
    if (detect.substituto && produto?.substituto !== true) {
      produto = montarProdutoCotado({ pedido: produto?.pedido ?? pedidoNome, cotado: detect.nome ?? produto?.cotado ?? null, substituto: true, apresentacao: produto?.apresentacao ?? null, fonte: 'texto_da_farmacia' });
      updates['items_available'] = [produto];
    }
    if (Object.keys(updates).length) {
      await db.from('quotes').update(updates as never).eq('id', quote.id);
      await writeLog('info', 'quote', `Pós-cotação: cotação atualizada pelo texto da farmácia (${Object.keys(updates).join(', ')})`, { traceId, quoteId: quote.id, frete: fee, total });
    }
    // Pergunta de nome ANTES de fechar: a farmácia não fica no vácuo, mas o nome só vai quando
    // o paciente fechar (o handleConfirmOrder passa). Uma cortesia por cotação.
    if (interp.perguntaNome && !textoParaFarmacia && !customerNotified) {
      const { data: ultimas } = await db.from('messages').select('content').eq('conversation_id', conversationId).eq('direction', 'out')
        .gte('created_at', new Date(Date.now() - 6 * 60 * 60_000).toISOString()).order('created_at', { ascending: false }).limit(6);
      const jaDisse = (ultimas ?? []).some((m) => (m.content as string | null) === CORTESIA_NOME_ANTES_DE_FECHAR);
      if (!jaDisse) await sendOutboundToSupplier(conversationId, supplierPhone, CORTESIA_NOME_ANTES_DE_FECHAR, traceId);
    }
    const depois = { total, deliveryFee: fee, substituto: produto?.substituto ?? null };
    if (ofertaMudou(antes, depois)) {
      const supName = (quote.suppliers as { name?: string } | null)?.name ?? 'a farmácia';
      const msg = mensagemDeAtualizacaoDaOferta({ supplierName: supName, produto, total, deliveryFee: fee, textoPrazo: interp.textoPrazo });
      await atualizarOfertaAoPaciente(quote.order_id as string, quote.id as string, msg, { produto, total, deliveryFee: fee }, traceId);
    }
  }

  // 10b. BACKSTOP DE RELAY PÓS-FECHAMENTO (incidente Vadivino): se a farmácia deu sinal de
  // CHEGADA ("motoboy na porta", "ninguém achou quem pediu") ou perguntou o NOME de quem
  // recebe, e o agente NÃO chamou notify_customer, forçamos o aviso ao cliente (rede de
  // segurança determinística — o remédio não pode falhar porque o modelo esqueceu de avisar).
  if (isOrderConfirmation && !customerNotified && quote.order_id) {
    // Regexes de chegada/nome agora são módulo-level (ARRIVAL_RE/WHO_ASK_RE) — compartilhados
    // com o roteador de lane pós-venda (review 10/07 #9).
    const isArrival = ARRIVAL_RE.test(text);
    const isWho = WHO_ASK_RE.test(text);
    // Precisa avisar o CLIENTE? Chegada sempre; pergunta-de-nome SÓ se não sabemos o nome
    // (se já sabemos, respondemos a farmácia direto e NÃO incomodamos o cliente — review #1).
    const relayCustomer = isArrival || (isWho && !recipientName);
    if (isArrival || isWho) {
      const { data: o } = await db.from('orders').select('customer_relayed_at').eq('id', quote.order_id).maybeSingle();
      const lastRelay = o?.customer_relayed_at ? new Date(o.customer_relayed_at as string).getTime() : 0;
      const supName = (quote.suppliers as { name?: string } | null)?.name ?? 'a farmácia';
      // Se a farmácia pede o nome e nós TEMOS, respondemos a farmácia direto (destrava o motoboy).
      if (isWho && recipientName) {
        await sendOutboundToSupplier(conversationId, supplierPhone, `é pra ${recipientName.split(' ')[0]}`, traceId);
      }
      // Aviso ao cliente respeita cooldown de 4min (chegada) / sempre (pergunta sem nome).
      const cooldownOk = (isWho && !recipientName) || Date.now() - lastRelay > 4 * 60_000;
      if (relayCustomer && cooldownOk) {
        const userMsg = isArrival
          ? `Oi! A ${supName} falou que o entregador já tá chegando aí 🛵 consegue receber? Qualquer coisa me chama.`
          : `Oi! A ${supName} tá perguntando o nome de quem vai receber a entrega — me confirma pra eu passar certinho?`;
        if (await relayToCustomer(quote.order_id, userMsg, traceId) === 'sent') {
          await db.from('orders').update({ customer_relayed_at: new Date().toISOString() }).eq('id', quote.order_id);
          await writeLog('warn', 'supplier', `🛟 Backstop de relay pós-fechamento (agente não avisou o cliente) — sinal=${isArrival ? 'chegada' : 'pergunta-nome'}`, { traceId, orderId: quote.order_id, quoteId: quote.id });
        }
      }
    }
  }

  // 11. If negotiation ended, finalize and maybe consolidate (skip in confirmation/post-quote mode)
  if (shouldFinalize && !isOrderConfirmation && !isPostQuote) {
    await finalizeQuote(quote.id, quote.order_id, outcome, traceId);
  }
}

// ─── Debounce de rajada + persistência imediata ──────────────────────────────
// Incidente Santa Lúcia 07/07: a farmácia mandou "Olá" e "Boa noite" em 1s e a Xarlote
// respondeu DUAS mensagens quase iguais em 3s (cada webhook virava um turno) — cara de
// robô na hora. Agora: cada mensagem é PERSISTIDA na hora (fidelidade do transcript),
// mas o TURNO espera alguns segundos; o que chegar na janela entra no MESMO turno e o
// LLM responde UMA vez, vendo a rajada inteira.
// NOTA (single-instance): supplierTurnBuffer é estado LOCAL do processo. Hoje o service
// `api` roda como instância ÚNICA no Railway; se algum dia escalar horizontalmente
// (roadmap F2.F1), o debounce precisa migrar pra coordenação via Redis (como os crons já
// fazem com withCronLock) — senão réplicas coalescem a mesma rajada isoladamente e o
// double-send volta. Review 08/07.
interface SupplierTurn {
  texts: string[];
  supplierPhone: string;
  traceId: string;
  timer: ReturnType<typeof setTimeout> | null;
  pendingMedia: number;   // mensagens ainda transcrevendo (áudio/imagem) → seguram a janela
  mediaDeadline: number;  // teto absoluto pra fechar mesmo com mídia pendente (anti-travamento)
}
const supplierTurnBuffer = new Map<string, SupplierTurn>();
const SUPPLIER_DEBOUNCE_MS = Number(process.env['SUPPLIER_DEBOUNCE_MS'] ?? 8000);
// Teto de espera pela mídia antes de fechar a rajada sem ela. Precisa cobrir o pior caso
// REALISTA de download + transcrição (áudio timeout=30s + folga pro download): abaixo disso,
// um áudio lento-mas-bem-sucedido chegaria depois do turno já ter fechado e viraria um 2º
// turno = double-send (review 08/07). Mídia que FALHA vira '' → silêncio, sem 2º turno.
const SUPPLIER_MEDIA_HOLD_MS = Number(process.env['SUPPLIER_MEDIA_HOLD_MS'] ?? 45_000);

async function persistSupplierInbound(conversationId: string, text: string, traceId: string): Promise<void> {
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
}

/** (Re)arma o timer da janela de debounce da conversa. */
function armSupplierTimer(conversationId: string): void {
  const entry = supplierTurnBuffer.get(conversationId);
  if (!entry) return;
  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = setTimeout(() => fireSupplierTurn(conversationId), SUPPLIER_DEBOUNCE_MS);
}

/** Fecha a rajada: processa o turno único (ou silencia se vazio) e limpa o buffer. */
function fireSupplierTurn(conversationId: string): void {
  const entry = supplierTurnBuffer.get(conversationId);
  if (!entry) return;
  // Ainda esperando transcrição de mídia e dentro do teto → NÃO fecha a rajada sem ela
  // (senão o áudio vira um 2º turno = double-send, o exato tell de robô); re-checa em 1s.
  if (entry.pendingMedia > 0 && Date.now() < entry.mediaDeadline) {
    entry.timer = setTimeout(() => fireSupplierTurn(conversationId), 1000);
    return;
  }
  supplierTurnBuffer.delete(conversationId);
  if (entry.timer) clearTimeout(entry.timer);
  const combined = entry.texts.map((t) => t.trim()).filter(Boolean).join('\n');
  if (!combined) {
    // Rajada só de mensagens vazias (mídia ilegível) → SEM turno (nada de "Fico no
    // aguardo! 🙂" repetido a cada figurinha — silêncio é humano aqui).
    void writeLog('info', 'supplier', 'Rajada sem texto útil (mídia ilegível) — sem resposta', { traceId: entry.traceId, conversationId });
    return;
  }
  void processInboundSupplier({ conversationId, supplierPhone: entry.supplierPhone, text: combined, traceId: entry.traceId, skipPersist: true })
    .catch((err) => writeLog('error', 'supplier', `Turno debounced falhou: ${String(err).slice(0, 160)}`, { traceId: entry.traceId, conversationId }));
}

/**
 * RESERVA um slot na rajada ANTES de processar mídia lenta. Transcrição de áudio/imagem
 * pode levar mais que a janela de 8s — sem a reserva, o áudio entraria DEPOIS do turno já
 * ter disparado e viraria um 2º turno/2ª resposta (double-send). Síncrono: incrementa
 * pendingMedia (segura a janela) e arma/estende o timer. Review 08/07.
 */
export function reserveSupplierMedia(conversationId: string, supplierPhone: string, traceId: string): void {
  const existing = supplierTurnBuffer.get(conversationId);
  if (existing) {
    existing.pendingMedia += 1;
    existing.mediaDeadline = Date.now() + SUPPLIER_MEDIA_HOLD_MS;
    existing.supplierPhone = supplierPhone;
  } else {
    supplierTurnBuffer.set(conversationId, {
      texts: [], supplierPhone, traceId, timer: null,
      pendingMedia: 1, mediaDeadline: Date.now() + SUPPLIER_MEDIA_HOLD_MS,
    });
  }
  armSupplierTimer(conversationId);
}

/**
 * Enfileira uma mensagem do fornecedor: turno debounced (rajada = 1 turno). Persiste a msg
 * (fidelidade do transcript) — mas o PUSH no buffer é síncrono ANTES do await do insert, pra
 * a ordem seguir a CHEGADA e não a ordem em que os inserts do Supabase resolvem (jitter de
 * rede podia inverter uma rajada e o LLM ler "não tem mais\ntem sim" invertido). Review 08/07.
 * `fromReservation` = esta msg tinha um slot de mídia reservado (decrementa pendingMedia).
 */
export async function enqueueSupplierTurn(conversationId: string, supplierPhone: string, text: string, traceId: string, fromReservation = false): Promise<void> {
  const existing = supplierTurnBuffer.get(conversationId);
  const entry: SupplierTurn = existing ?? {
    texts: [], supplierPhone, traceId, timer: null, pendingMedia: 0, mediaDeadline: 0,
  };
  entry.texts.push(text);
  entry.traceId = traceId; // trace da última msg da rajada
  entry.supplierPhone = supplierPhone;
  if (fromReservation && entry.pendingMedia > 0) entry.pendingMedia -= 1;
  if (!existing) supplierTurnBuffer.set(conversationId, entry);
  armSupplierTimer(conversationId);
  // Persiste DEPOIS (a ordem no buffer já está travada). Não persiste vazio — msg de mídia
  // ilegível não deve virar um row vazio (que ainda enganaria o ackAt do order-followup).
  if (text.trim()) await persistSupplierInbound(conversationId, text, traceId);
}

/**
 * Flush do buffer no shutdown. Railway manda SIGTERM em TODO redeploy: sem isto, uma rajada
 * na janela de 8s some com o processo — a msg foi persistida mas o turno NUNCA roda (farmácia
 * sem resposta) e o order-followup era enganado (row existe → parecia "acked"). Processa o
 * que já tem agora (não espera transcrição pendente — mídia é best-effort). Review 08/07.
 */
export async function flushSupplierTurnBuffer(): Promise<void> {
  const pending = [...supplierTurnBuffer.entries()];
  supplierTurnBuffer.clear();
  await Promise.allSettled(pending.map(async ([conversationId, entry]) => {
    if (entry.timer) clearTimeout(entry.timer);
    const combined = entry.texts.map((t) => t.trim()).filter(Boolean).join('\n');
    if (!combined) return;
    await processInboundSupplier({ conversationId, supplierPhone: entry.supplierPhone, text: combined, traceId: entry.traceId, skipPersist: true })
      .catch((err) => writeLog('error', 'supplier', `Flush de rajada no shutdown falhou: ${String(err).slice(0, 160)}`, { traceId: entry.traceId, conversationId }));
  }));
}

/**
 * Mídia do FORNECEDOR → texto (best-effort). A farmácia manda foto do produto com o
 * preço na etiqueta, ou áudio — antes isso chegava como mensagem VAZIA e a Xarlote
 * respondia filler repetido (10:53/10:54 de 07/07). Reusa a infra da perna do usuário:
 * áudio → transcrição; imagem → visão (1 frase objetiva). Falha → null (silêncio).
 */
async function supplierMediaToText(inbound: NormalizedInbound, traceId: string): Promise<string | null> {
  try {
    if (inbound.contentType !== 'audio' && inbound.contentType !== 'image') return null;
    const media = await fetchInboundMedia(inbound, AGENT_INSTANCE);
    if (!media) return null;
    const cfg = loadPrompts();
    if (inbound.contentType === 'audio') {
      const r = await transcribeAudio(media.buffer, media.mime, {
        model: cfg.audio_model || 'elevenlabs/scribe_v1',
        openRouterKey: cfg.llm_api_key || process.env['OPENROUTER_API_KEY'],
        geminiKey: process.env['GOOGLE_GENAI_API_KEY'],
        elevenLabsKey: cfg.tts_api_key || process.env['ELEVENLABS_API_KEY'],
        timeoutMs: 30_000,
      });
      const t = r.text?.trim();
      return t ? `[áudio da farmácia]: ${t}` : null;
    }
    // imagem → visão: 1 frase objetiva (produto/preço/texto legível)
    const du = dataUrl(media.buffer.toString('base64'), media.mime || 'image/jpeg');
    const res = await chat(
      userContentWithImage(
        'Foto enviada por uma farmácia numa cotação de medicamento pelo WhatsApp. Descreva em UMA frase objetiva o que ela mostra — produto, preço/etiqueta e qualquer texto legível. Sem interpretação clínica.',
        [du],
      ),
      {
        model: cfg.vision_model || cfg.llm_model || 'openai/gpt-4.1-mini',
        apiKey: cfg.llm_api_key || process.env['OPENROUTER_API_KEY'],
        systemInstruction: 'Você descreve fotos objetivamente em PT-BR, em 1 frase curta.',
        history: [],
        tools: [],
        temperature: 0.1,
        maxOutputTokens: 120,
        timeoutMs: 25_000,
      },
    );
    const desc = res.text?.trim();
    return desc ? `[foto da farmácia: ${desc}]` : null;
  } catch (err) {
    await writeLog('warn', 'supplier', `Mídia do fornecedor ilegível: ${String(err).slice(0, 140)}`, { traceId });
    return null;
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
  // Casa por TODAS as variantes do 9º dígito BR (o WhatsApp entrega c/ ou sem o 9)
  // — senão a resposta da farmácia/clínica vinda com o número no formato "oposto"
  // ao que salvamos não acha a conversa e a negociação trava.
  const jids = [...new Set([inbound.from.jid, ...whatsappJidVariants(inbound.from.phoneE164)])];
  const { data: rows } = await db
    .from('conversations')
    .select('id, party_type')
    .eq('whatsapp_instance', AGENT_INSTANCE)
    .in('whatsapp_jid', jids)
    .limit(1);

  const conv = rows?.[0];
  if (!conv) return;

  const isMedia = inbound.contentType === 'audio' || inbound.contentType === 'image';

  // Roteamento por party_type — clinic vai pro agent-clinic (fluxo próprio, SEM debounce).
  if ((conv as { party_type?: string }).party_type === 'clinic') {
    let text = inbound.text ?? '';
    if (isMedia) {
      const mediaText = await supplierMediaToText(inbound, traceId);
      if (mediaText) text = text ? `${text}\n${mediaText}` : mediaText;
    }
    // Lazy import pra evitar ciclo
    const { processInboundClinic } = await import('./agent-clinic.js');
    await processInboundClinic({
      conversationId: conv.id,
      clinicPhone: inbound.from.phoneE164,
      text,
      traceId,
    });
    return;
  }

  // Supplier: debounce de rajada. Mídia → texto (foto do produto com preço, áudio): antes
  // chegava VAZIO e virava filler repetido. Best-effort; falha vira '' e o debounce silencia.
  let text = inbound.text ?? '';
  if (isMedia) {
    // RESERVA o slot ANTES da transcrição lenta (pode passar da janela de 8s): sem isto o
    // áudio entraria depois do turno já ter disparado e viraria um 2º turno = double-send.
    reserveSupplierMedia(conv.id, inbound.from.phoneE164, traceId);
    const mediaText = await supplierMediaToText(inbound, traceId);
    if (mediaText) text = text ? `${text}\n${mediaText}` : mediaText;
    await enqueueSupplierTurn(conv.id, inbound.from.phoneE164, text, traceId, true);
  } else {
    await enqueueSupplierTurn(conv.id, inbound.from.phoneE164, text, traceId);
  }
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
  // Kill-switch de disparo pra farmácia (hot-reload via /prompts) — freio de
  // emergência pra parar de contatar estabelecimentos sem desligar a Xarlote.
  if (!loadPrompts().pharmacy_outbound_enabled) {
    await writeLog('warn', 'supplier', 'Disparo pra farmácia DESLIGADO (pharmacy_outbound_enabled=false) — negociação não iniciada', { traceId, quoteId });
    return;
  }
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

  // 🛑 SÓ contata fornecedor com telefone REAL. Antes caía num número sintético
  // (+555500000<id>) quando não havia telefone — e em produção isso DISPAROU pra
  // números fake (incidente 2026-07-01). Sem WhatsApp/telefone real → pula + loga
  // (nada de fabricar número). Marca a cotação como indisponível pra não travar o pedido.
  const supplierPhone = supplier.whatsapp_e164 || supplier.phone_e164 || null;
  if (!supplierPhone || isPlaceholderPhone(supplierPhone)) {
    await writeLog('error', 'pharmacy', `Fornecedor ${supplier.name} SEM telefone real (whatsapp/phone nulos) — negociação PULADA (não fabrica número fake).`, {
      traceId, quoteId, supplierId: supplier.id,
    });
    await db.from('quotes').update({ status: 'unavailable', notes: 'fornecedor sem telefone real', completed_at: new Date().toISOString() }).eq('id', quoteId);
    return;
  }
  const supplierJid = `${supplierPhone.replace(/\D/g, '')}@s.whatsapp.net`;

  // Create (or find) supplier conversation
  const conv = await findOrCreateConversation(AGENT_INSTANCE, supplierJid, 'supplier', null, supplier.id);

  // 🔒 ISOLAMENTO DE CLIENTE (incidente 08/07 — a conversa da farmácia é UMA por telefone):
  // a farmácia `2fd35e36` acumulou cotações de 3 clientes diferentes; um pedido de Pietra
  // (Setor Sul) entrou no thread de um Multigrip (Jardim América) de OUTRO cliente. Duas
  // consequências: (1) a farmácia vê 2 pedidos misturados no mesmo thread; (2) quando ela
  // responde, o roteamento pega a cotação MAIS RECENTE (openQuotes[0]) → resposta podia ir
  // pro cliente ERRADO. Regra: uma farmácia só negocia UM pedido por vez nesta conversa.
  const otherCutoffIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data: otherQuotesRaw } = await db.from('quotes')
    .select('id, order_id, status, created_at, orders(status)')
    .eq('conversation_id', conv.id)
    .neq('order_id', orderId);
  const otherQuotes = (otherQuotesRaw ?? []) as Array<{ order_id: string; status: string; created_at: string; orders?: { status?: string } | null }>;
  // "Ocupada" = a cotação DESTA farmácia pra outro pedido ainda está VIVA (pending/contacting/
  // negotiating/quoted) E o outro pedido AINDA não fechou. Pedido fechado/cancelado/falho =
  // farmácia livre (não sobre-bloqueia por causa de um pedido antigo que já foi entregue).
  const otherActive = otherQuotes.filter((q) =>
    ['pending', 'contacting', 'negotiating', 'quoted'].includes(q.status)
    && !['handed_off', 'cancelled', 'failed'].includes(q.orders?.status ?? ''));
  if (otherActive.length) {
    // Farmácia OCUPADA com pedido ATIVO de outro cliente → NÃO contata (este pedido usa as
    // outras farmácias do Top-N). Evita mistura de clientes e cross-routing da resposta.
    await writeLog('warn', 'pharmacy', `Farmácia ${supplier.name} já negocia pedido ATIVO de outro cliente nesta conversa — PULADA pra este pedido (isolamento de cliente)`, {
      traceId, quoteId, conversationId: conv.id, otherOrderIds: [...new Set(otherActive.map((q) => q.order_id))],
    });
    await db.from('quotes').update({ notes: 'farmácia ocupada com pedido de outro cliente (isolamento)' }).eq('id', quoteId);
    // finalizeQuote (não update+return seco): conta como terminal e roda a consolidação —
    // se TODAS as Top-N forem puladas, o pedido falha rápido com relatório honesto, em vez
    // de o cliente ouvir "as farmácias ainda não responderam" (mentira) e esperar 45min.
    await finalizeQuote(quoteId, orderId, 'unavailable', traceId);
    return;
  }
  // Thread teve OUTRO cliente nas últimas 24h (mesmo já finalizado) → abertura FRESCA, não
  // "eu de novo por aqui" (que herdaria o contexto do outro cliente e misturaria os pedidos).
  const threadHadOtherClientRecently = otherQuotes.some((q) => q.created_at > otherCutoffIso);

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

  // CONVERSA QUENTE (incidente Santa Lúcia 07/07, 20:34): a farmácia tinha acabado de
  // fechar um pedido e recebeu "Oi, tudo bem? Aqui é a Xarlote, assistente de saúde…"
  // como se nunca tivessem falado — tell de robô na cara. Dentro da janela de 24h o
  // Meta ACEITA texto livre: a abertura vira uma CONTINUAÇÃO natural da conversa (sem
  // re-apresentação, ciente do que está pendente). Template só em conversa FRIA.
  // Calculado ANTES do systemPrompt pra a regra #7 do prompt já nascer ciente (senão o
  // prompt-base mandava sempre "diga seu nome" e contradizia a nota de continuação —
  // review 08/07: o modelo pode seguir a regra numerada e re-apresentar).
  const { data: lastIn } = await db.from('messages')
    .select('created_at')
    .eq('conversation_id', conv.id)
    .eq('direction', 'in')
    .eq('sender_role', 'supplier')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  // Continuação quente SÓ quando o thread recente é do MESMO cliente — se teve outro
  // cliente nas últimas 24h, abre FRESCO (senão "eu de novo" cai no pedido do outro).
  const isWarm = !!lastIn?.created_at
    && Date.now() - new Date(lastIn.created_at).getTime() < 24 * 60 * 60 * 1000
    && !threadHadOtherClientRecently;

  // Build opening message via Agent LLM. Repassamos o setor REAL do usuário (não a cidade da farmácia).
  const { data: ordAddr } = await db.from('orders').select('delivery_address').eq('id', orderId).single();
  const cfg = loadPrompts();
  const systemPrompt = cfg.agent_override.trim()
    ? cfg.agent_override.trim()
    : buildAgentPharmacySystemPrompt({
        items,
        neighborhoodCity: userNeighborhood,
        deliveryAddress: ordAddr?.delivery_address ?? null,
        paymentMethod: paymentMethod ?? null,
        isWarm,
      });

  // Default defensivo: lista vazia/nomes em branco não pode gerar template com
  // variável vazia (a Meta rejeita) — cai pra um texto genérico válido.
  const itemsText = items.map((i) => `${itemDisplayName(i.name, i.dosage)}${i.quantity ? ` (${i.quantity})` : ''}`).join(', ').trim() || 'os itens do pedido';
  const paymentClause = paymentMethod ? ` O pagamento vai ser via ${paymentMethod}.` : '';

  const fallbackOpening = isWarm
    ? `oi, eu de novo por aqui 🙂 vocês teriam ${itemsText}? é pra entregar no ${userNeighborhood} — me passa o valor e o prazo?`
    : `Oi, tudo bem? Você tem ${itemsText} disponível? É para entregar no ${userNeighborhood}. Consegue me passar o preço e o prazo de entrega, por favor?`;

  let opening: string;
  try {
    const warmHistory = isWarm ? messagesToHistory(await getConversationMessages(conv.id, 12) as Message[]) : [];
    const openingInstr = isWarm
      ? '\n\nCONTINUAÇÃO DE CONVERSA: você JÁ conversou com esta farmácia (histórico acima) — ela te conhece. Escreva UMA mensagem curta e natural pedindo a cotação NOVA dos itens: SEM se re-apresentar (nada de "aqui é a Xarlote"/"assistente"), cumprimento leve no máximo; se houver assunto pendente com ela (ex.: entrega de um pedido anterior ainda não confirmada), reconheça em meia frase antes ("antes de mais nada, saiu aquela entrega?"). Tom de WhatsApp de gente: curto, sem formalidade, no máximo 1 emoji. Não use tools.'
      : '\n\nEsta é a primeira mensagem. Escreva a abertura para a farmácia perguntando de forma curta e natural se ela TEM os itens, o preço e o prazo de entrega — SEM se apresentar (nada de "aqui é a Xarlote"/"assistente"/"sou a Xarlote"), sem mencionar IA/agente/sistema, sem emojis. Direto ao ponto, como uma pessoa perguntaria. Não use tools ainda.';
    const res = await chat('INICIAR_COTACAO', {
      model: cfg.llm_model || process.env['OPENROUTER_MODEL'] || 'openai/gpt-4.1-mini',
      apiKey: cfg.llm_api_key || process.env['OPENROUTER_API_KEY'],
      systemInstruction: systemPrompt + openingInstr,
      history: warmHistory,
      tools: [],
      temperature: 0.4,
      maxOutputTokens: 200,
      timeoutMs: 20_000,
    });
    opening = res.text.trim() || fallbackOpening;
  } catch {
    opening = fallbackOpening;
  }

  await writeLog('info', 'pharmacy', `Initiating negotiation with ${supplier.name}${isWarm ? ' (conversa quente — texto livre)' : ''}`, {
    traceId, quoteId, supplierId: supplier.id, isWarm,
  });

  // Fase 6: no número OFICIAL a abertura FRIA precisa ser template (Meta). Conversa
  // QUENTE (<24h) vai de texto livre humano — sem template, sem re-apresentação.
  if (templatesEnabled() && !isWarm) {
    const t = pharmacyColdOpen(itemsText, userNeighborhood);
    await sendTemplateOpeningToSupplier(conv.id, supplierPhone, t.key, t.variables, traceId);
  } else {
    // Assunto obrigatório (mesma razão da clínica): abertura fria está sempre fora da
    // janela, então sem assunto o kill-switch de template calaria o contato inicial.
    await sendOutboundToSupplier(conv.id, supplierPhone, opening, traceId,
      'a cotação de um medicamento pra um paciente que estou ajudando');
  }
}

// ─── Internal helpers ────────────────────────────────────────────────────────

async function finalizeQuote(quoteId: string, orderId: string, outcome: string, traceId: string) {
  const finalStatus = outcome === 'quoted' ? 'quoted' : outcome === 'unavailable' ? 'unavailable' : 'timeout';

  // Only update if not already in a terminal state
  const { data: updatedRows } = await db.from('quotes')
    .update({ status: finalStatus, completed_at: new Date().toISOString() })
    .eq('id', quoteId)
    .in('status', ['pending', 'contacting', 'negotiating'])
    .select('id');

  // Observabilidade HONESTA (09/07): o log dizia "Quote finalized: timeout" mesmo quando o
  // update era no-op (cotação já terminal) — foi isso que mascarou o loop do incidente
  // Vadivino-2 (4 finalizações "fantasma" na auditoria). ⚠️ O no-op NÃO pula a consolidação
  // (review 10/07 #6): record_quote_price/record_supplier_unavailable/auto-captura gravam o
  // status terminal DIRETO antes de chamar finalizeQuote — o update aqui é SEMPRE no-op
  // nesses caminhos e este é o ÚNICO ponto que consolida o caso all-unavailable ("as 3
  // farmácias disseram não temos" tem que virar relatório honesto na hora, não em 45min).
  // consolidateQuotes é idempotente (guard de status + transição atômica), re-checar é seguro.
  if (!updatedRows?.length) {
    await writeLog('info', 'quote', `finalizeQuote(${finalStatus}) no-op (cotação já terminal) — seguindo pro check de consolidação`, { traceId, quoteId });
  } else {
    await writeLog('info', 'quote', `Quote finalized: ${finalStatus}`, { traceId, quoteId });
  }

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
