/**
 * Cotação nas plataformas das grandes redes (VTEX) → pool apresentado ao usuário, com
 * link de carrinho pré-montado (handoff: a pessoa só finaliza o pagamento no site da rede).
 *
 * Canal PARALELO e ADITIVO ao WhatsApp das farmácias de bairro: não toca na máquina de
 * quotes/negociação existente. Resolve o buraco "só tem rede grande perto → nenhuma
 * cotação" (as grandes quase nunca têm WhatsApp, mas a vitrine online é pública).
 * Ver docs/PHARMACY_PLATFORMS.md.
 */
import { writeLog } from '@iasaude/db';
import { itemDisplayName, extractCep, type OrderItem } from '@iasaude/shared';
import { quotePlatforms, type PlatformQuote } from '@iasaude/integrations';
import { sendOutbound } from './outbound.js';

export { extractCep };

const MAX_OPTIONS_PER_ITEM = 3;
const NUM_EMOJI = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣'];

function formatBRL(n: number): string {
  return `R$ ${n.toFixed(2).replace('.', ',')}`;
}

/** Linha de logística legível: "entrega em 60 min grátis · ou retira na hora". */
function fulfillmentLine(q: PlatformQuote): string {
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

/** Monta o bloco de um item (nome + até N opções ordenadas por preço). */
function renderItemBlock(label: string, quotes: PlatformQuote[]): string {
  const lines: string[] = [`💊 *${label}* nas grandes redes aqui pertinho:`];
  quotes.slice(0, MAX_OPTIONS_PER_ITEM).forEach((q, i) => {
    const logi = fulfillmentLine(q);
    lines.push(
      `\n${NUM_EMOJI[i] ?? '•'} *${q.networkLabel}* — ${formatBRL(q.price)}` +
      `\n    ${q.productName}` + // produto REAL cotado — o usuário confere dosagem/embalagem antes de pagar
      (logi ? `\n    ${logi}` : '') +
      `\n    🛒 ${q.checkoutUrl}`,
    );
  });
  return lines.join('');
}

export interface PresentPlatformQuotesResult {
  /** nº de itens que tiveram ao menos uma cotação */
  itemsWithQuotes: number;
  /** total de cotações apresentadas */
  totalQuotes: number;
}

/**
 * Cota cada item nas plataformas e, se houver resultado, manda UMA mensagem com o pool.
 * `soleChannel` = true quando não há farmácia de bairro (ajusta o texto pra não soar redundante).
 * Retorna o que foi apresentado (0 itens = nada enviado).
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

  const blocks: string[] = [];
  let itemsWithQuotes = 0;
  let totalQuotes = 0;

  // Cota os itens EM PARALELO (cada remédio é independente) — no caso "só grandes redes"
  // isso é awaited, então serializar seria N×9s. A ordem dos blocos segue a ordem dos itens.
  const perItem = await Promise.all(
    items.map(async (item): Promise<{ label: string; query: string; quotes: PlatformQuote[] } | null> => {
      const label = itemDisplayName(item.name, item.dosage);
      const query = [item.name, item.dosage, item.quantity].filter(Boolean).join(' ').trim();
      if (!query) return null;
      try {
        const quotes = await quotePlatforms(query, cep, { timeoutMs: 9000, traceId });
        return { label, query, quotes };
      } catch (err) {
        await writeLog('warn', 'platform', `Cotação de plataformas falhou p/ "${query}": ${String(err).slice(0, 140)}`, { traceId, orderId });
        return null;
      }
    }),
  );

  for (const r of perItem) {
    if (!r || !r.quotes.length) continue;
    itemsWithQuotes++;
    totalQuotes += Math.min(r.quotes.length, MAX_OPTIONS_PER_ITEM);
    blocks.push(renderItemBlock(r.label, r.quotes));
    await writeLog('info', 'platform', `Cotação de plataformas: "${r.query}" → ${r.quotes.length} rede(s)`, {
      traceId, orderId,
      opções: r.quotes.slice(0, MAX_OPTIONS_PER_ITEM).map((q) => `${q.networkLabel} ${formatBRL(q.price)} (score ${q.matchScore.toFixed(2)})`),
    });
  }

  if (!itemsWithQuotes) return { itemsWithQuotes: 0, totalQuotes: 0 };

  const intro = soleChannel
    ? 'Não achei farmácia de bairro com WhatsApp aqui na sua região agora 😕 mas não te deixo na mão — já cotei nas grandes redes pertinho de você, dá pra pedir agora mesmo (é só tocar e finalizar o pagamento no site):\n\n'
    : 'Também já achei nas grandes redes aqui perto — dá pra pedir agora, é só tocar e finalizar o pagamento no site 👇\n\n';
  const outro = soleChannel
    ? '\n\nQualquer dúvida na hora de finalizar, é só me chamar 💙'
    : '\n\nEnquanto isso sigo cotando nas farmácias do bairro — se aparecer melhor, te aviso! 😊';

  await sendOutbound(conversationId, phoneE164, intro + blocks.join('\n\n') + outro, traceId);
  return { itemsWithQuotes, totalQuotes };
}
