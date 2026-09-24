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
import { itemDisplayName, extractCep, faixaDePrazo, temOpcaoImediata, ehNaHora, selecionarParaEntregaNaHora, seloDePrazo, linhaDeLogistica, instrucaoDoCheckout, podeDizerPertinho, custoDaManchete, type OrderItem } from '@iasaude/shared';
import { quotePlatformBasket, medNameForSearch, type PlatformBasketQuote, type BasketRequestItem } from '@iasaude/integrations';
import { sendOutbound } from './outbound.js';

export { extractCep };

const MAX_NETWORKS = 3;
const NUM_EMOJI = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣'];

function formatBRL(n: number): string {
  return `R$ ${n.toFixed(2).replace('.', ',')}`;
}

// A manchete de prazo e a linha de logística moram em `packages/shared/src/entrega-na-hora.ts`
// (puras e testadas): a faixa "retirar-agora" e o endereço da loja nasceram lá em 24/09.

/** Bloco de UMA rede: total + cada item (pedido → produto real) + o que falta + link(s). */
function renderNetworkBlock(idx: number, q: PlatformBasketQuote): string {
  const count = q.lines.length > 1 ? ` (${q.lines.length} itens)` : '';
  // A MANCHETE é o que sai do bolso NA OPÇÃO PROMETIDA: entregue (remédio + frete) quando a
  // promessa é entrega; só o remédio quando a promessa é retirar na loja — o frete de uma
  // entrega que a pessoa não vai usar não entra (ver `custoDaManchete`). A quebra do frete
  // só aparece quando a manchete é entrega, pra ninguém achar que escondemos o frete.
  const f = faixaDePrazo(q);
  const mancheteEhRetirada = f === 'retirar-agora' || f === 'so-retirada';
  const head = `${NUM_EMOJI[idx] ?? '•'} *${q.networkLabel}* — ${formatBRL(custoDaManchete(q))}${count} · ${seloDePrazo(q)}`;
  const quebra = !mancheteEhRetirada && q.delivery && q.delivery.feeReais > 0
    ? `   ${formatBRL(q.total)} + ${formatBRL(q.delivery.feeReais)} de entrega`
    : null;
  const logi = linhaDeLogistica(q);
  // Rede que NÃO monta carrinho único (RD) traz link por linha → 1 link por remédio (senão o
  // 2º item sumiria atrás do link do 1º). VTEX = 1 carrinho com tudo (q.checkoutUrl).
  const perItemLinks = q.lines.length > 1 && q.lines.every((l) => l.productUrl);
  const itemLines = q.lines.map((l) => {
    const qtyStr = l.qty > 1 ? ` ×${l.qty}` : '';
    const base = `   • ${l.productName.slice(0, 46)} — ${formatBRL(l.price)}${qtyStr}`;
    return perItemLinks ? `${base}\n     🛒 ${l.productUrl}` : base;
  });
  const miss = q.missing.length ? `\n   ⚠️ não achei aqui: ${q.missing.join(', ')}` : '';
  const comoEscolher = instrucaoDoCheckout(q);
  const foot = perItemLinks ? '\n   (cada remédio no seu link acima)' : `\n   🛒 ${q.checkoutUrl}`;
  return `${head}${quebra ? `\n${quebra}` : ''}${logi ? `\n   ${logi}` : ''}\n${itemLines.join('\n')}${miss}${foot}${comoEscolher ? `\n   ${comoEscolher}` : ''}`;
}

/**
 * Monta a mensagem da cotação — PURA (sem envio, sem banco), pra poder ser testada e
 * conferida com dados reais antes de chegar a um paciente.
 *
 * MODO ENTREGA NA HORA: havendo opção que põe o remédio na mão da pessoa em até 4h
 * (entrega OU retirada), só essas aparecem — "chega em 4 dias úteis" logo abaixo era o
 * ruído que fazia a cotação parecer marketplace. A exceção (quem cobre MAIS itens da
 * receita continua) e o porquê estão em `selecionarParaEntregaNaHora`.
 */
export function montarMensagemDeCotacao(
  quotes: PlatformBasketQuote[],
  opts: { soleChannel?: boolean; introText?: string; outroText?: string; totalDeItens?: number } = {},
): { texto: string; top: PlatformBasketQuote[]; soNaHora: boolean; descartadas: number } {
  const { soleChannel, introText, outroText } = opts;
  const { cotacoes: selecionadas, soNaHora } = selecionarParaEntregaNaHora(quotes);
  const top = selecionadas.slice(0, MAX_NETWORKS);
  const blocks = top.map((q, i) => renderNetworkBlock(i, q));

  // Quando existe opção que resolve HOJE, isso é a notícia — e vem antes de qualquer
  // outra coisa. Foi a promessa que a via de WhatsApp não conseguiu cumprir em 82% das
  // vezes; aqui ela é verificável antes de sair da boca.
  // "Hoje mesmo" só quando a 1ª opção da lista resolve hoje E tem a receita INTEIRA. Com a
  // exceção de cobertura, a 1ª pode ser a completa-lenta ("4 dias úteis") com uma rápida
  // parcial abaixo — dizer "hoje mesmo" ali prometia a receita toda pra hoje (revisão 24/09).
  const totalDeItens = opts.totalDeItens ?? Math.max(0, ...quotes.map((q) => q.lines.length + q.missing.length));
  const primeira = top[0];
  const receitaTodaHoje = !!primeira && ehNaHora(primeira) && primeira.lines.length >= totalDeItens;
  const parteHoje = !receitaTodaHoje && temOpcaoImediata(top);
  // "Pertinho" só com prova (entrega em até 4h ou loja a até 5 km). Antes a palavra saía
  // até quando a opção mais rápida vinha de outro estado em 11 dias úteis.
  const perto = podeDizerPertinho(top);
  const PARTE = 'Uma parte você consegue *hoje mesmo*; a receita completa tem prazo maior — o prazo de cada farmácia tá do lado 👇 é só tocar e finalizar o pagamento no site.\n\n';
  const intro = introText ?? (soleChannel
    ? (receitaTodaHoje
        ? `Achei${perto ? ' aqui pertinho' : ''} e você consegue *hoje mesmo* 👇 é só tocar e finalizar o pagamento no site da farmácia.\n\n`
        : parteHoje
          ? PARTE
          : 'Não achei farmácia de bairro com WhatsApp aqui na sua região agora 😕 mas dá pra pedir nas grandes redes — o prazo de cada uma pro seu CEP tá do lado 👇 é só tocar e finalizar o pagamento no site.\n\n')
    : (receitaTodaHoje
        ? 'Já tenho uma opção que resolve *hoje* 👇 é só tocar e finalizar o pagamento no site da farmácia.\n\n'
        : parteHoje
          ? PARTE
          : 'Também achei nas grandes redes — o prazo de cada uma pro seu CEP tá do lado 👇 é só tocar e finalizar o pagamento no site.\n\n'));
  const outro = outroText ?? (soleChannel
    ? '\n\nQualquer dúvida na hora de finalizar, é só me chamar 💙'
    : '\n\nEnquanto isso sigo cotando nas farmácias do bairro — se aparecer melhor, te aviso! 😊');

  return { texto: intro + blocks.join('\n\n') + outro, top, soNaHora, descartadas: quotes.length - selecionadas.length };
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
  /** Limita a cotação a redes específicas (ex.: usuário pediu SÓ a Drogasil pelo nome). */
  networkIds?: string[];
  /** Sobrescreve o texto de abertura (ex.: "Cotei na Drogasil pra você 👇"). */
  introText?: string;
  /** Sobrescreve o texto de fecho (o default fala em "sigo cotando no bairro", falso na cotação por nome). */
  outroText?: string;
}): Promise<PresentPlatformQuotesResult> {
  const { orderId, items, cep, conversationId, phoneE164, traceId, soleChannel, networkIds, introText, outroText } = params;

  const basket: BasketRequestItem[] = items
    .map((it) => ({
      query: [it.name, it.dosage, it.quantity].filter(Boolean).join(' ').trim(),
      label: itemDisplayName(it.name, it.dosage),
      qty: 1,
    }))
    .filter((b) => b.query);
  if (!basket.length) {
    await writeLog('warn', 'platform', `Cotação de plataformas: cesta vazia (nenhum item com termo de busca)`, { traceId, orderId });
    return { networksPresented: 0, itemsCovered: 0 };
  }

  let quotes: PlatformBasketQuote[] = [];
  try {
    quotes = await quotePlatformBasket(basket, cep, { timeoutMs: 9000, traceId, ...(networkIds?.length ? { networkIds } : {}) });
  } catch (err) {
    await writeLog('warn', 'platform', `Cotação de plataformas (cesta) falhou: ${String(err).slice(0, 140)}`, { traceId, orderId });
    return { networksPresented: 0, itemsCovered: 0 };
  }
  // Pool vazio NUNCA em silêncio (incidente Arthur 16/07: 0 redes, sem log — impossível saber
  // que ele foi afetado sem investigação manual). Registra o termo de busca REAL de cada item
  // (pós-medNameForSearch) pra a causa aparecer no log: "Neblock 0.5mg → neblock" = achou nome
  // mas nenhuma dose casou; "xyz → xyz" = nem catálogo tem. Nome de remédio é operacional (não PII).
  if (!quotes.length) {
    await writeLog('info', 'platform', `Cotação de plataformas (cesta): 0 redes — nenhum item casou nas grandes redes`, {
      traceId, orderId,
      buscas: basket.map((b) => `${b.label} → "${medNameForSearch(b.query)}"`),
    });
    return { networksPresented: 0, itemsCovered: 0 };
  }

  const { texto, top, soNaHora, descartadas } = montarMensagemDeCotacao(quotes, { soleChannel, introText, outroText, totalDeItens: basket.length });
  await sendOutbound(conversationId, phoneE164, texto, traceId);

  const itemsCovered = new Set(top.flatMap((q) => q.lines.map((l) => l.requested))).size;
  await writeLog('info', 'platform', `Cotação de plataformas (cesta): ${top.length} rede(s), ${itemsCovered}/${basket.length} item(ns) coberto(s)${soNaHora ? ` — só as que resolvem na hora (${descartadas} lenta(s) fora)` : ' — nenhuma resolve na hora'}`, {
    traceId, orderId,
    redes: top.map((q) => `${q.networkLabel} ${formatBRL(custoDaManchete(q))}/${faixaDePrazo(q)} (${q.lines.length}/${basket.length}${q.missing.length ? `, falta ${q.missing.join('+')}` : ''})`),
  });
  return { networksPresented: top.length, itemsCovered };
}
