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
import { activeNetworks, type PlatformNetwork } from './registry.js';
import { rankProductMatches } from './matching.js';
import { searchVtexProducts, simulateVtexByCep, buildVtexCartLink, buildVtexCartLinkMulti, simulateVtexBasket, onlyDigits, type BasketItem } from './vtex.js';
import { quoteRDProduct, zenrowsConfigured } from './rd-adapter.js';
import { quoteNisseiProduct } from './nissei-adapter.js';
import { quoteUltrafarmaProduct } from './ultrafarma-adapter.js';
import type { PlatformQuote, PlatformProduct, PlatformBasketQuote, PlatformBasketLine } from './types.js';

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
  const products = await searchVtexProducts(net, term, { limit: 12, timeoutMs: opts.timeoutMs, retries: 1 });
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
      pickup = sim.pickup;
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

  return quotes.sort((a, b) => a.price - b.price);
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

  // 1) casa cada item na rede; item sem match vai pra `missing`.
  const found: { req: BasketRequestItem; product: PlatformProduct; score: number }[] = [];
  const missing: string[] = [];
  for (const req of items) {
    let products: PlatformProduct[] = [];
    try {
      products = await searchVtexProducts(net, req.query, { limit: 12, timeoutMs: opts.timeoutMs, retries: 1 });
    } catch { products = []; }
    const best = rankProductMatches(req.query, products, { minScore: opts.minScore })[0];
    if (best) found.push({ req, product: best.product, score: best.score });
    else missing.push(req.label);
  }
  if (!found.length) return null; // rede não tem NENHUM item → fora do pool

  // 2) simula a cesta no CEP → preço por sku + total + entrega.
  const basketItems: BasketItem[] = found.map((f) => ({ sku: f.product.sku, seller: f.product.sellerId, qty: Math.max(1, f.req.qty ?? 1) }));
  let sim: Awaited<ReturnType<typeof simulateVtexBasket>> = null;
  try { sim = await simulateVtexBasket(net, basketItems, cep8, { timeoutMs: opts.timeoutMs, retries: 1 }); } catch { sim = null; }

  // item indisponível na simulação sai da cesta (não montar link com item sem estoque) e vira "falta".
  const kept: typeof found = [];
  const droppedByStock: string[] = [];
  for (const f of found) {
    if (sim && sim.perSku[f.product.sku]?.available === false) droppedByStock.push(f.req.label);
    else kept.push(f);
  }
  // Fallback pro catálogo SÓ quando a simulação NÃO rodou (sim == null). Se a sim rodou e
  // marcou TODOS os itens indisponíveis no CEP, a rede não serve aqui → fora do pool (não
  // mostrar rede que dá withoutStock, ex.: Venancio-RJ pra cliente de GO — probe ao vivo 14/07).
  const usable = kept.length ? kept : (sim ? [] : found);
  if (!usable.length) return null;

  const lines: PlatformBasketLine[] = usable.map((f) => {
    const qty = Math.max(1, f.req.qty ?? 1);
    const simPrice = sim?.perSku[f.product.sku]?.price;
    const price = simPrice != null && simPrice > 0 ? simPrice : f.product.price;
    return { requested: f.req.label, productName: f.product.productName, sku: f.product.sku, sellerId: f.product.sellerId, price, qty, matchScore: f.score };
  });
  const total = lines.reduce((s, l) => s + l.price * l.qty, 0);
  const cartItems: BasketItem[] = lines.map((l) => ({ sku: l.sku, seller: l.sellerId, qty: l.qty }));

  // droppedByStock só entra em `missing` quando REALMENTE dropamos (kept não-vazio). No
  // fallback de catálogo (kept vazio → mostramos os itens mesmo), NÃO reportar os mesmos
  // itens como "não achei" — seria contradizer a própria cotação (review MEDIUM-2).
  const finalMissing = kept.length ? [...missing, ...droppedByStock] : missing;
  return {
    network: net.id, networkLabel: net.label, group: net.group,
    lines, missing: finalMissing,
    total, available: lines.length > 0,
    delivery: sim?.delivery ?? null, pickup: sim?.pickup ?? null,
    checkoutUrl: affiliateWrap(net.id, buildVtexCartLinkMulti(net, cartItems)),
    pricedByCep: !!sim,
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
      if (!cur || q.lines.length > cur.lines.length || (q.lines.length === cur.lines.length && q.total < cur.total)) best.set(q.group, q);
    }
    quotes = [...best.values()];
  }
  return quotes.sort((a, b) => (b.lines.length - a.lines.length) || (a.total - b.total));
}

/** Limpa o cache em memória (teste/manutenção). */
export function _clearPlatformCache(): void {
  CACHE.clear();
}
