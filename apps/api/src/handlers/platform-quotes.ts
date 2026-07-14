/**
 * Cotação nas plataformas das grandes redes (VTEX) → pool apresentado ao usuário, com
 * link de carrinho pré-montado (handoff: a pessoa só finaliza o pagamento no site da rede).
 *
 * Pedido com N remédios → 1 CARRINHO por rede (auditoria 1º pedido: antes montava um link
 * por medicamento; agora agrupa por rede, soma o total e é transparente sobre o que falta).
 * Canal PARALELO e ADITIVO ao WhatsApp das farmácias de bairro — não toca na máquina de
 * quotes/negociação. Resolve "só tem rede grande perto → nenhuma cotação".
 * Ver docs/PHARMACY_PLATFORMS.md.
 */
import { writeLog } from '@iasaude/db';
import { itemDisplayName, extractCep, type OrderItem } from '@iasaude/shared';
import { quotePlatformBasket, type PlatformBasketQuote, type BasketRequestItem } from '@iasaude/integrations';
import { sendOutbound } from './outbound.js';

export { extractCep };

const MAX_NETWORKS = 3;
const NUM_EMOJI = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣'];

function formatBRL(n: number): string {
  return `R$ ${n.toFixed(2).replace('.', ',')}`;
}

/** Linha de logística legível: "entrega em 60 min grátis · ou retira na hora". */
function fulfillmentLine(q: PlatformBasketQuote): string {
  const parts: string[] = [];
  if (q.delivery) {
    const fee = q.delivery.feeReais > 0 ? ` (${formatBRL(q.delivery.feeReais)})` : ' grátis';
    parts.push(`entrega em ${q.delivery.etaText}${fee}`);
  }
  if (q.pickup) {
    parts.push(parts.length ? `ou retira ${q.pickup.etaText === '60 min' ? 'na hora' : `em ${q.pickup.etaText}`}`
                            : `retira ${q.pickup.etaText === '60 min' ? 'na hora' : `em ${q.pickup.etaText}`}`);
  }
  return parts.join(' · ');
}

/** Bloco de UMA rede: total + cada item (pedido → produto real) + o que falta + 1 link. */
function renderNetworkBlock(idx: number, q: PlatformBasketQuote): string {
  const count = q.lines.length > 1 ? ` (${q.lines.length} itens)` : '';
  const head = `${NUM_EMOJI[idx] ?? '•'} *${q.networkLabel}* — ${formatBRL(q.total)}${count}`;
  const logi = fulfillmentLine(q);
  // cada item: mostra o PRODUTO REAL cotado (o usuário confere dosagem/embalagem antes de pagar)
  const itemLines = q.lines.map((l) => {
    const qtyStr = l.qty > 1 ? ` ×${l.qty}` : '';
    return `   • ${l.productName.slice(0, 46)} — ${formatBRL(l.price)}${qtyStr}`;
  });
  const miss = q.missing.length ? `\n   ⚠️ não achei aqui: ${q.missing.join(', ')}` : '';
  return `${head}${logi ? `\n   ${logi}` : ''}\n${itemLines.join('\n')}${miss}\n   🛒 ${q.checkoutUrl}`;
}

export interface PresentPlatformQuotesResult {
  /** nº de redes apresentadas (0 = nada enviado) */
  networksPresented: number;
  /** nº de itens do pedido que ao menos uma rede tinha */
  itemsCovered: number;
}

/**
 * Cota a CESTA (todos os remédios) nas plataformas e, se houver resultado, manda UMA mensagem
 * com até MAX_NETWORKS redes — cada uma com 1 link de carrinho e o total. `soleChannel` = true
 * quando não há farmácia de bairro (ajusta o texto). Retorna o que foi apresentado.
 */
export async function presentPlatformQuotes(params: {
  orderId: string;
  items: OrderItem[];
  cep: string;
  conversationId: string;
  phoneE164: string;
  traceId: string;
  soleChannel?: boolean;
}): Promise<PresentPlatformQuotesResult> {
  const { orderId, items, cep, conversationId, phoneE164, traceId, soleChannel } = params;

  const basket: BasketRequestItem[] = items
    .map((it) => ({
      query: [it.name, it.dosage, it.quantity].filter(Boolean).join(' ').trim(),
      label: itemDisplayName(it.name, it.dosage),
      qty: 1,
    }))
    .filter((b) => b.query);
  if (!basket.length) return { networksPresented: 0, itemsCovered: 0 };

  let quotes: PlatformBasketQuote[] = [];
  try {
    quotes = await quotePlatformBasket(basket, cep, { timeoutMs: 9000, traceId });
  } catch (err) {
    await writeLog('warn', 'platform', `Cotação de plataformas (cesta) falhou: ${String(err).slice(0, 140)}`, { traceId, orderId });
    return { networksPresented: 0, itemsCovered: 0 };
  }
  if (!quotes.length) return { networksPresented: 0, itemsCovered: 0 };

  const top = quotes.slice(0, MAX_NETWORKS);
  const blocks = top.map((q, i) => renderNetworkBlock(i, q));

  const intro = soleChannel
    ? 'Não achei farmácia de bairro com WhatsApp aqui na sua região agora 😕 mas dá pra pedir nas grandes redes pertinho de você — tudo num link só, é só tocar e finalizar o pagamento no site 👇\n\n'
    : 'Também achei nas grandes redes aqui perto — dá pra pedir tudo de uma vez, é só tocar e finalizar o pagamento no site 👇\n\n';
  const outro = soleChannel
    ? '\n\nQualquer dúvida na hora de finalizar, é só me chamar 💙'
    : '\n\nEnquanto isso sigo cotando nas farmácias do bairro — se aparecer melhor, te aviso! 😊';

  await sendOutbound(conversationId, phoneE164, intro + blocks.join('\n\n') + outro, traceId);

  const itemsCovered = new Set(top.flatMap((q) => q.lines.map((l) => l.requested))).size;
  await writeLog('info', 'platform', `Cotação de plataformas (cesta): ${top.length} rede(s), ${itemsCovered}/${basket.length} item(ns) coberto(s)`, {
    traceId, orderId,
    redes: top.map((q) => `${q.networkLabel} ${formatBRL(q.total)} (${q.lines.length}/${basket.length}${q.missing.length ? `, falta ${q.missing.join('+')}` : ''})`),
  });
  return { networksPresented: top.length, itemsCovered };
}
