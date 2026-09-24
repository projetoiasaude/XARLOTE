/**
 * Cotação nas plataformas das grandes redes → pool pronto pro handoff.
 *
 *   quotePlatforms(termo, cep) →
 *     por rede ativa (Grupo A): busca no catálogo → ranqueia match → simula no CEP →
 *     monta PlatformQuote (com link de carrinho). Tudo em paralelo, cache-first,
 *     tolerante a falha por rede (uma cair não derruba as outras). Dedup por grupo
 *     econômico (melhor preço) pra o pool não repetir catálogo compartilhado.
 *
 * Ver docs/PHARMACY_PLATFORMS.md.
 */
import { activeNetworks, marcaIrmaNaFachada, type PlatformNetwork } from './registry.js';
import { rankProductMatches, medNameForSearch } from './matching.js';
import { searchVtexProducts, simulateVtexByCep, buildVtexCartLink, buildVtexCartLinkMulti, simulateVtexBasket, onlyDigits, type BasketItem } from './vtex.js';
import { ordenarCotacoesDeRede, compararCotacoesDeRede } from '@iasaude/shared';
import { escolherCandidatosDisponiveis, MAX_CANDIDATOS } from './candidatos.js';
import { quoteRDProduct, zenrowsConfigured } from './rd-adapter.js';
import { quoteNisseiProduct } from './nissei-adapter.js';
import { quoteUltrafarmaProduct } from './ultrafarma-adapter.js';
import type { PlatformQuote, PlatformProduct, PlatformBasketQuote, PlatformBasketLine, FulfillmentOption } from './types.js';

/**
 * Marca a loja de retirada cuja FACHADA é de uma rede irmã (mesmo grupo no registro): a
 * Extrafarma de Goiânia retira em lojas Pague Menos. Cópia nova — o objeto em cache fica intacto.
 */
function comMarcaDoGrupo(pickup: FulfillmentOption | null, net: PlatformNetwork): FulfillmentOption | null {
  if (!pickup?.store) return pickup;
  const marcaDoGrupo = marcaIrmaNaFachada(pickup.store.name, net);
  return marcaDoGrupo ? { ...pickup, store: { ...pickup.store, marcaDoGrupo } } : pickup;
}

/**
 * Adaptadores das redes de PLATAFORMA PRÓPRIA (access 'custom' — nem VTEX nem Akamai). Cada uma
 * tem site próprio: um adaptador dedicado por rede. Ligados por `id` do registry. Todos server-side
 * abertos (sem proxy). Ver nissei-adapter.ts / ultrafarma-adapter.ts.
 *   Nissei     → Django   (busca HTML + POST /pegar/preco)
 *   Ultrafarma → Angular SSR (busca renderiza os cards com preço)
 * (Panvel: API atrás do Azion + cadeia de headers; registry-ready, desligada — ver docs.)
 */
type CustomAdapter = (
  net: PlatformNetwork,
  query: string,
  opts: { timeoutMs?: number; minScore?: number },
) => Promise<PlatformProduct | null>;

const CUSTOM_ADAPTERS: Record<string, CustomAdapter> = {
  nissei: quoteNisseiProduct,
  ultrafarma: quoteUltrafarmaProduct,
};

export * from './types.js';
export * from './registry.js';
export { escolherCandidatosDisponiveis, MAX_CANDIDATOS } from './candidatos.js';
export { PLATFORM_REGISTRY } from './registry.js';
export {
  searchVtexProducts,
  simulateVtexByCep,
  buildVtexCartLink,
  buildVtexCartLinkMulti,
  simulateVtexBasket,
  parseVtexSimulation,
  parseVtexBasketSimulation,
  mapVtexProduct,
  formatShippingEstimate,
  estimateToMinutes,
} from './vtex.js';
export {
  parseMedicationQuery,
  scoreProductMatch,
  rankProductMatches,
  extractStrengths,
  medNameForSearch,
  normalize as normalizeMedName,
} from './matching.js';
export { quoteRDProduct, zenrowsConfigured, parseRDSearch, parseRDPrice, extractNextData } from './rd-adapter.js';
export { quoteNisseiProduct, parseNisseiCsrf, parseNisseiResults, parseNisseiPrices, humanizeNisseiSlug } from './nissei-adapter.js';
export { quoteUltrafarmaProduct, parseUltrafarmaProducts, parseBrl } from './ultrafarma-adapter.js';

/**
 * Envelopa o link de checkout num deeplink de AFILIADO, se configurado por env
 * `PLATFORM_AFFILIATE_<ID>` (ex.: PLATFORM_AFFILIATE_PAGUE_MENOS). O valor é um template:
 * usa `{url}` como placeholder do destino (URL-encodado) — ex.:
 *   "https://www.awin1.com/cread.php?awinmid=1234&awinaffid=999&ued={url}"
 * Sem env → retorna a URL crua (mesma fricção, sem afiliado). Assim liga/desliga
 * monetização sem deploy. NUNCA coloca PII: só a URL pública de carrinho é passada.
 */
export function affiliateWrap(networkId: string, url: string): string {
  const key = `PLATFORM_AFFILIATE_${networkId.toUpperCase().replace(/-/g, '_')}`;
  const tpl = (process.env[key] ?? '').trim();
  if (!tpl) return url;
  return tpl.includes('{url}') ? tpl.replace('{url}', encodeURIComponent(url)) : tpl + encodeURIComponent(url);
}

export interface QuotePlatformsOptions {
  /** limita quais redes cotar (ids). Default = activeNetworks() do registry. */
  networkIds?: string[];
  /** confiança mínima do match (0..1). Default 0.5. */
  minScore?: number;
  /** timeout por request HTTP. */
  timeoutMs?: number;
  /** dedup por grupo econômico (São Paulo/Pacheco = DPSP). Default true. */
  dedupeByGroup?: boolean;
  traceId?: string;
}

interface CacheEntry {
  at: number;
  quotes: PlatformQuote[];
}
const CACHE = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 30 * 60 * 1000; // preço muda devagar; 30 min

function cacheKey(networkId: string, term: string, cep8: string): string {
  // CEP completo (8 díg): o preço é estável no setor, mas frete/prazo variam por CEP —
  // usar só 5 díg serviria estimativa de entrega errada a um vizinho de setor (review L1).
  return `${networkId}::${term.trim().toLowerCase()}::${cep8}`;
}

/** Cota UMA rede: busca → melhor match → simula no CEP → PlatformQuote. Null se nada casa. */
async function quoteOneNetwork(
  net: PlatformNetwork,
  term: string,
  cep8: string,
  opts: QuotePlatformsOptions,
): Promise<PlatformQuote | null> {
  const key = cacheKey(net.id, term, cep8);
  const cached = CACHE.get(key);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.quotes[0] ?? null;
  }

  // Só sabemos falar VTEX REST por enquanto (Grupo A). Outras vias entram nas fases 2/3.
  if (net.access !== 'rest') return null;

  // retries:1 (sem retry) — latência limitada importa mais que completude aqui: se uma rede
  // falha, as outras cobrem e o WhatsApp do bairro é o backbone. Evita o pior caso de 4×timeout.
  // Busca pelo NOME (medNameForSearch), NÃO pelo termo cru: a dosagem/forma vão pro ranqueador
  // (canonStrength casa 1g=1000mg melhor que o `ft` literal). limit 16 (era 12) pra dar folga
  // ao ranqueador agora que a dose não pré-filtra a busca — o item certo pode não vir no top-12.
  const products = await searchVtexProducts(net, medNameForSearch(term), { limit: 16, timeoutMs: opts.timeoutMs, retries: 1 });
  const ranked = rankProductMatches(term, products, { minScore: opts.minScore });
  const best = ranked[0];
  if (!best) {
    CACHE.set(key, { at: Date.now(), quotes: [] });
    return null;
  }

  const p = best.product;
  let price = p.price;
  let listPrice = p.listPrice;
  let available = p.availableQuantity > 0;
  let delivery = null as PlatformQuote['delivery'];
  let pickup = null as PlatformQuote['pickup'];
  let pricedByCep = false;

  // Preço/estoque/entrega REAIS no CEP. Se a simulação falhar, cai no preço de catálogo.
  try {
    const sim = await simulateVtexByCep(net, p.sku, cep8, { timeoutMs: opts.timeoutMs, seller: p.sellerId });
    if (sim) {
      price = sim.price;
      listPrice = sim.listPrice;
      available = sim.available;
      delivery = sim.delivery;
      pickup = comMarcaDoGrupo(sim.pickup, net);
      pricedByCep = true;
    }
  } catch {
    /* mantém o preço de catálogo */
  }

  const quote: PlatformQuote = {
    network: net.id,
    networkLabel: net.label,
    group: net.group,
    productName: p.productName,
    sku: p.sku,
    price,
    listPrice,
    available,
    delivery,
    pickup,
    checkoutUrl: affiliateWrap(net.id, buildVtexCartLink(net, p.sku, 1, p.sellerId)),
    productUrl: p.productUrl,
    matchScore: best.score,
    pricedByCep,
  };
  CACHE.set(key, { at: Date.now(), quotes: [quote] });
  return quote;
}

/**
 * Cota o termo em todas as redes ativas e devolve o pool ordenado por preço (mais barato
 * primeiro). Só entram cotações DISPONÍVEIS. Dedup por grupo econômico (mantém a mais barata).
 */
export async function quotePlatforms(
  term: string,
  cep: string,
  opts: QuotePlatformsOptions = {},
): Promise<PlatformQuote[]> {
  const cep8 = onlyDigits(cep);
  if (cep8.length !== 8 || !term.trim()) return [];

  let nets = activeNetworks();
  if (opts.networkIds && opts.networkIds.length) {
    const want = new Set(opts.networkIds);
    nets = nets.filter((n) => want.has(n.id));
  }

  const settled = await Promise.allSettled(nets.map((n) => quoteOneNetwork(n, term, cep8, opts)));
  let quotes = settled
    .filter((r): r is PromiseFulfilledResult<PlatformQuote | null> => r.status === 'fulfilled')
    .map((r) => r.value)
    .filter((q): q is PlatformQuote => q != null && q.available);

  if (opts.dedupeByGroup !== false) {
    const bestByGroup = new Map<string, PlatformQuote>();
    for (const q of quotes) {
      const cur = bestByGroup.get(q.group);
      if (!cur || q.price < cur.price) bestByGroup.set(q.group, q);
    }
    quotes = [...bestByGroup.values()];
  }

  // Ordena por CHEGADA e por TOTAL ENTREGUE, não por preço de etiqueta — ver
  // `compararCotacoesDeRede`. Uma cotação de item único é uma cesta de uma linha.
  return ordenarCotacoesDeRede(
    quotes.map((q) => ({ ...q, lines: [q.sku] as readonly unknown[], total: q.price })),
  ).map(({ lines: _l, total: _t, ...q }) => q as PlatformQuote);
}

// ─── Cesta: pedido com N remédios → 1 carrinho por rede (auditoria 1º pedido) ──

export interface BasketRequestItem { query: string; label: string; qty?: number }

/** Cota TODOS os itens numa rede, monta 1 carrinho com o que ela tem e lista o que falta. */
/** Corta uma promessa lenta num teto de tempo. A RD via ZenRows pode demorar (~3-8s/request) e
 * NÃO pode segurar o pool das 10 VTEX rápidas (~1-2s) além disso (review MEDIUM). O trabalho
 * segue em background populando o cache da RD pra próxima cotação. */
async function withDeadline<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<T>((resolve) => { timer = setTimeout(() => resolve(fallback), ms); });
  try { return await Promise.race([work, guard]); } finally { if (timer) clearTimeout(timer); }
}

const RD_DEADLINE_MS = 13000;
const RD_REQUEST_TIMEOUT_MS = 8000;

// Redes próprias (Nissei/Ultrafarma) fazem múltiplos requests sequenciais por item → teto de
// wall-clock (senão uma rede lenta segura o pool das 10 VTEX rápidas) + teto por request (review H1).
const CUSTOM_DEADLINE_MS = 12000;
const CUSTOM_REQUEST_TIMEOUT_MS = 6500;

/**
 * Cesta na RD (Drogasil/Raia/Onofre) via ZenRows — a RD não tem REST/simulação por CEP: usa o
 * adaptador (busca+preço renderizados). Preço padrão da rede (não por CEP); cada remédio ganha
 * o link próprio (a RD não monta carrinho multi-sku). Itens em paralelo, com teto de tempo pra
 * não atrasar as VTEX. Sem ZenRows → null.
 */
async function quoteBasketRD(
  net: PlatformNetwork,
  items: BasketRequestItem[],
  opts: QuotePlatformsOptions,
): Promise<PlatformBasketQuote | null> {
  if (!zenrowsConfigured()) return null;
  return withDeadline(quoteBasketRDInner(net, items, opts), RD_DEADLINE_MS, null);
}

async function quoteBasketRDInner(
  net: PlatformNetwork,
  items: BasketRequestItem[],
  opts: QuotePlatformsOptions,
): Promise<PlatformBasketQuote | null> {
  const timeoutMs = Math.min(opts.timeoutMs ?? RD_REQUEST_TIMEOUT_MS, RD_REQUEST_TIMEOUT_MS);
  const settled = await Promise.all(items.map(async (req) => {
    try { return { req, product: await quoteRDProduct(net, req.query, { timeoutMs, minScore: opts.minScore }) }; }
    catch { return { req, product: null as PlatformProduct | null }; }
  }));
  const found = settled.filter((r) => r.product);
  const missing = settled.filter((r) => !r.product).map((r) => r.req.label);
  if (!found.length) return null;

  // A RD não monta carrinho multi-sku → cada remédio ganha o link PRÓPRIO (productUrl na linha).
  // Sem isso, um pedido de 2 remédios mostraria o total dos 2 mas só o link do 1º, e o 2º
  // sumiria silenciosamente (review HIGH — perigoso em saúde).
  const lines: PlatformBasketLine[] = found.map((f) => ({
    requested: f.req.label, productName: f.product!.productName, sku: f.product!.sku,
    sellerId: '1', price: f.product!.price, qty: Math.max(1, f.req.qty ?? 1), matchScore: 1,
    productUrl: affiliateWrap(net.id, f.product!.productUrl),
  }));
  const total = lines.reduce((s, l) => s + l.price * l.qty, 0);
  return {
    network: net.id, networkLabel: net.label, group: net.group,
    lines, missing, total, available: true,
    delivery: null, pickup: null, // RD: preço padrão, CEP/entrega confirmados no site (handoff)
    checkoutUrl: lines[0]!.productUrl!, // fallback (cesta de 1 item); multi-item usa o link por linha
    pricedByCep: false,
  };
}

/**
 * Cesta numa rede de plataforma PRÓPRIA (Nissei/Ultrafarma) via adaptador dedicado. Como a RD,
 * essas redes NÃO montam carrinho multi-sku → cada remédio ganha o link PRÓPRIO (productUrl na
 * linha), senão o 2º item sumiria atrás do link do 1º. Preço padrão da rede (não por CEP → handoff).
 * Itens em paralelo; adaptador ausente (ex.: rede custom sem código) → null (nunca quebra o pool).
 */
async function quoteBasketCustom(
  net: PlatformNetwork,
  items: BasketRequestItem[],
  opts: QuotePlatformsOptions,
): Promise<PlatformBasketQuote | null> {
  const adapter = CUSTOM_ADAPTERS[net.id];
  if (!adapter) return null;
  // teto de wall-clock: uma rede própria lenta NÃO pode segurar as 10 VTEX rápidas (review H1).
  return withDeadline(quoteBasketCustomInner(net, items, adapter, opts), CUSTOM_DEADLINE_MS, null);
}

async function quoteBasketCustomInner(
  net: PlatformNetwork,
  items: BasketRequestItem[],
  adapter: CustomAdapter,
  opts: QuotePlatformsOptions,
): Promise<PlatformBasketQuote | null> {
  const timeoutMs = Math.min(opts.timeoutMs ?? CUSTOM_REQUEST_TIMEOUT_MS, CUSTOM_REQUEST_TIMEOUT_MS);

  const settled = await Promise.all(items.map(async (req) => {
    try { return { req, product: await adapter(net, req.query, { timeoutMs, minScore: opts.minScore }) }; }
    catch { return { req, product: null as PlatformProduct | null }; }
  }));
  const found = settled.filter((r) => r.product);
  const missing = settled.filter((r) => !r.product).map((r) => r.req.label);
  if (!found.length) return null;

  const lines: PlatformBasketLine[] = found.map((f) => ({
    requested: f.req.label, productName: f.product!.productName, sku: f.product!.sku,
    sellerId: '1', price: f.product!.price, qty: Math.max(1, f.req.qty ?? 1), matchScore: 1,
    productUrl: affiliateWrap(net.id, f.product!.productUrl),
  }));
  const total = lines.reduce((s, l) => s + l.price * l.qty, 0);
  return {
    network: net.id, networkLabel: net.label, group: net.group,
    lines, missing, total, available: true,
    delivery: null, pickup: null, // preço padrão; CEP/entrega confirmados no site (handoff)
    checkoutUrl: lines[0]!.productUrl!, // fallback (cesta de 1 item); multi-item usa o link por linha
    pricedByCep: false,
  };
}

async function quoteBasketOneNetwork(
  net: PlatformNetwork,
  items: BasketRequestItem[],
  cep8: string,
  opts: QuotePlatformsOptions,
): Promise<PlatformBasketQuote | null> {
  if (net.access === 'akamai') return quoteBasketRD(net, items, opts);
  if (net.access === 'custom') return quoteBasketCustom(net, items, opts);
  if (net.access !== 'rest') return null;
  // Teto de wall-clock por rede VTEX (as buscas são sequenciais, mais 1–3 simulações): uma
  // rede lenta ou com 429 não pode segurar a cotação inteira — o turno do paciente tem ~75s.
  return withDeadline(quoteBasketVtex(net, items, cep8, opts), VTEX_DEADLINE_MS, null);
}

/** Uma consulta de busca por (rede, termo) vale 30 min — preço de catálogo muda devagar. */
const BUSCA_CACHE = new Map<string, { at: number; products: PlatformProduct[] }>();
/** Uma simulação por (rede, CEP, cesta) vale 5 min — estoque e prazo mudam mais rápido. */
const SIM_CACHE = new Map<string, { at: number; sim: Awaited<ReturnType<typeof simulateVtexBasket>> }>();
const BUSCA_TTL_MS = 30 * 60_000;
const SIM_TTL_MS = 5 * 60_000;
const CACHE_MAX = 2_000;
const VTEX_DEADLINE_MS = 15_000;

function podarCache<V>(m: Map<string, V>): void {
  // Map preserva ordem de inserção: o mais antigo sai primeiro. Sem teto, um processo de
  // meses guardaria toda busca já feita.
  while (m.size > CACHE_MAX) m.delete(m.keys().next().value as string);
}

async function buscarComCache(net: PlatformNetwork, termo: string, opts: QuotePlatformsOptions): Promise<PlatformProduct[]> {
  const k = `${net.id}|${termo}`;
  const hit = BUSCA_CACHE.get(k);
  if (hit && Date.now() - hit.at < BUSCA_TTL_MS) return hit.products;
  let products: PlatformProduct[] = [];
  try {
    products = await searchVtexProducts(net, termo, { limit: 16, timeoutMs: opts.timeoutMs, retries: 1 });
    BUSCA_CACHE.set(k, { at: Date.now(), products });
    podarCache(BUSCA_CACHE);
  } catch { products = []; }
  return products;
}

async function simularComCache(net: PlatformNetwork, cesta: BasketItem[], cep8: string, opts: QuotePlatformsOptions) {
  const k = `${net.id}|${cep8}|${cesta.map((c) => `${c.sku}:${c.seller}:${c.qty}`).sort().join(',')}`;
  const hit = SIM_CACHE.get(k);
  if (hit && Date.now() - hit.at < SIM_TTL_MS) return hit.sim;
  let sim: Awaited<ReturnType<typeof simulateVtexBasket>> = null;
  try { sim = await simulateVtexBasket(net, cesta, cep8, { timeoutMs: opts.timeoutMs, retries: 1 }); } catch { sim = null; }
  // Falha NÃO entra no cache: um 429 de agora não pode virar "sem logística" por 5 minutos.
  if (sim) { SIM_CACHE.set(k, { at: Date.now(), sim }); podarCache(SIM_CACHE); }
  return sim;
}

type Candidato = { sku: string; sellerId: string; product: PlatformProduct; score: number };

/** Serve neste CEP = disponível E com alguma forma de chegar (entrega ou retirada). */
function serve(sim: Awaited<ReturnType<typeof simulateVtexBasket>>, sku: string): boolean {
  const e = sim?.perSku[sku];
  return !!e && e.available && e.temLogistica !== false;
}

/**
 * A cotação de UMA rede VTEX, em três passos — e no caso comum, UMA simulação só.
 *
 *  1. Busca e ranqueia cada remédio, guardando até `MAX_CANDIDATOS` marcas aprovadas.
 *  2. Simula a cesta com a 1ª marca de cada um. Se todas servem no CEP, é essa a resposta.
 *  3. Só para quem NÃO serviu, pergunta pelas marcas alternativas (ver `candidatos.ts`) e,
 *     se a cesta final mudou, simula exatamente ela — é essa simulação que dá o prazo e o
 *     frete que a mensagem promete.
 *
 * Por que não perguntar por todas as marcas de uma vez: a revisão de 24/09 tomou 429 do
 * CloudFront da DSP e da Pague Menos depois de ~40 pedidos em 8 min de um IP só — e em
 * produção todas as cotações saem do mesmo IP. Chamada extra só quando ela resolve algo.
 */
async function quoteBasketVtex(
  net: PlatformNetwork,
  items: BasketRequestItem[],
  cep8: string,
  opts: QuotePlatformsOptions,
): Promise<PlatformBasketQuote | null> {
  // 1) busca + ranking. Busca pelo NOME (medNameForSearch), NÃO pelo `req.query` cru: era o
  //    bug do Arthur — `ft=Neblock 0.5mg`→0. O ranqueador (req.query completo) reimpõe dose/forma.
  const pedidos: { req: BasketRequestItem; candidatos: Candidato[] }[] = [];
  const missing: string[] = [];
  for (const req of items) {
    const products = await buscarComCache(net, medNameForSearch(req.query), opts);
    const ranked = rankProductMatches(req.query, products, { minScore: opts.minScore }).slice(0, MAX_CANDIDATOS);
    if (ranked.length) {
      pedidos.push({ req, candidatos: ranked.map((r) => ({ sku: r.product.sku, sellerId: r.product.sellerId, product: r.product, score: r.score })) });
    } else {
      missing.push(req.label);
    }
  }
  if (!pedidos.length) return null; // rede não tem NENHUM item → fora do pool

  const qtyDe = (req: BasketRequestItem) => Math.max(1, req.qty ?? 1);
  const cestaDe = (esc: { pedidoIdx: number; candidato: Candidato }[]): BasketItem[] =>
    esc.map((e) => ({ sku: e.candidato.sku, seller: e.candidato.sellerId, qty: qtyDe(pedidos[e.pedidoIdx]!.req) }));

  // 2) a 1ª marca de cada remédio
  let escolhidos = pedidos.map((p, pedidoIdx) => ({ pedidoIdx, candidato: p.candidatos[0]! }));
  let sim = await simularComCache(net, cestaDe(escolhidos), cep8, opts);

  if (sim) {
    // 3) só quem não serviu no CEP vai atrás de alternativa
    const falharam = escolhidos.filter((e) => !serve(sim, e.candidato.sku));
    if (falharam.length) {
      const alternativas: BasketItem[] = [];
      for (const f of falharam) {
        for (const c of pedidos[f.pedidoIdx]!.candidatos.slice(1)) {
          alternativas.push({ sku: c.sku, seller: c.sellerId, qty: qtyDe(pedidos[f.pedidoIdx]!.req) });
        }
      }
      const simAlt = alternativas.length ? await simularComCache(net, alternativas, cep8, opts) : null;
      const substitutos = escolherCandidatosDisponiveis(
        falharam.map((f) => ({ label: pedidos[f.pedidoIdx]!.req.label, candidatos: pedidos[f.pedidoIdx]!.candidatos.slice(1) })),
        simAlt ? simAlt.perSku : {},
      );
      const trocaDe = new Map<number, Candidato>();
      substitutos.escolhidos.forEach((s) => trocaDe.set(falharam[s.pedidoIdx]!.pedidoIdx, s.candidato));
      missing.push(...substitutos.faltando);
      const naoServe = new Set(falharam.map((f) => f.pedidoIdx));
      escolhidos = escolhidos
        .filter((e) => !naoServe.has(e.pedidoIdx) || trocaDe.has(e.pedidoIdx))
        .map((e) => (trocaDe.has(e.pedidoIdx) ? { pedidoIdx: e.pedidoIdx, candidato: trocaDe.get(e.pedidoIdx)! } : e));
      if (!escolhidos.length) return null; // nenhuma marca de nenhum remédio chega neste CEP
      // A cesta mudou: o prazo e o frete que a mensagem promete têm que vir da cesta REAL.
      sim = await simularComCache(net, cestaDe(escolhidos), cep8, opts);
    }
  }

  // Sem simulação (429/timeout): preço de catálogo, e o prazo fica "confira no site" — nunca
  // "sem entrega", que seria afirmar sobre o CEP algo que não conseguimos perguntar.
  const lines: PlatformBasketLine[] = escolhidos.map((e) => {
    const req = pedidos[e.pedidoIdx]!.req;
    const simPrice = sim?.perSku[e.candidato.sku]?.price;
    const price = simPrice != null && simPrice > 0 ? simPrice : e.candidato.product.price;
    return {
      requested: req.label, productName: e.candidato.product.productName, sku: e.candidato.sku,
      sellerId: e.candidato.sellerId, price, qty: qtyDe(req), matchScore: e.candidato.score,
    };
  });
  const total = lines.reduce((acc, l) => acc + l.price * l.qty, 0);
  const cartItems: BasketItem[] = lines.map((l) => ({ sku: l.sku, seller: l.sellerId, qty: l.qty }));
  const delivery = sim?.delivery ?? null;
  const pickup = comMarcaDoGrupo(sim?.pickup ?? null, net);
  return {
    network: net.id, networkLabel: net.label, group: net.group,
    lines, missing,
    total, available: lines.length > 0,
    delivery, pickup,
    checkoutUrl: affiliateWrap(net.id, buildVtexCartLinkMulti(net, cartItems)),
    pricedByCep: !!sim,
    // Simulou a cesta exata e não há NENHUMA opção comum aos itens — cada um chega de um
    // jeito. É "confira no site", não "sem entrega pro seu CEP".
    semOpcaoComum: !!sim && !delivery && !pickup,
  };
}

/**
 * Cota uma CESTA (N remédios) nas redes ativas. Cada rede vira UMA cotação com 1 carrinho
 * dos itens que ela tem + a lista do que falta. Dedup por grupo (cesta mais completa vence);
 * ordena por completude (mais itens) e depois menor total.
 */
export async function quotePlatformBasket(
  items: BasketRequestItem[],
  cep: string,
  opts: QuotePlatformsOptions = {},
): Promise<PlatformBasketQuote[]> {
  const cep8 = onlyDigits(cep);
  const valid = items.filter((i) => i.query.trim());
  if (cep8.length !== 8 || !valid.length) return [];

  let nets = activeNetworks();
  if (opts.networkIds && opts.networkIds.length) {
    const want = new Set(opts.networkIds);
    nets = nets.filter((n) => want.has(n.id));
  }

  const settled = await Promise.allSettled(nets.map((n) => quoteBasketOneNetwork(n, valid, cep8, opts)));
  let quotes = settled
    .filter((r): r is PromiseFulfilledResult<PlatformBasketQuote | null> => r.status === 'fulfilled')
    .map((r) => r.value)
    .filter((q): q is PlatformBasketQuote => q != null && q.available);

  if (opts.dedupeByGroup !== false) {
    const best = new Map<string, PlatformBasketQuote>();
    for (const q of quotes) {
      const cur = best.get(q.group);
      // O comparador OFICIAL (cobertura → quando chega → quanto custa a opção prometida). Pelo
      // preço do remédio, a Pacheco lenta podia derrubar a DSP que entrega em 2h (mesmo grupo).
      if (!cur || compararCotacoesDeRede(q, cur) < 0) best.set(q.group, q);
    }
    quotes = [...best.values()];
  }
  return ordenarCotacoesDeRede(quotes);
}

/** Limpa o cache em memória (teste/manutenção). */
export function _clearPlatformCache(): void {
  CACHE.clear();
  BUSCA_CACHE.clear();
  SIM_CACHE.clear();
}
