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
import { searchVtexProducts, simulateVtexByCep, buildVtexCartLink, onlyDigits } from './vtex.js';
import type { PlatformQuote } from './types.js';

export * from './types.js';
export * from './registry.js';
export {
  searchVtexProducts,
  simulateVtexByCep,
  buildVtexCartLink,
  parseVtexSimulation,
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

/** Limpa o cache em memória (teste/manutenção). */
export function _clearPlatformCache(): void {
  CACHE.clear();
}
