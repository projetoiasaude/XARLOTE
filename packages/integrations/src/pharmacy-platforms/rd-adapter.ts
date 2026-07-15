/**
 * Adaptador da RD (Drogasil / Droga Raia / Onofre) — a MAIOR rede do Brasil.
 *
 * A RD desligou o REST público do VTEX e protege TUDO com Akamai (403 até no sitemap.xml).
 * Acesso via ZenRows (proxy anti-bot, env ZENROWS_API_KEY): renderiza as páginas Next.js e
 * lê o `__NEXT_DATA__` embutido (SSR). SEM a key → adaptador DESLIGADO (retorna []), então
 * a RD simplesmente não entra no pool — nunca quebra o fluxo.
 *
 *   busca: {host}/search?w={termo}  → props.pageProps.pageProps.results.products (sku, name, url)
 *   preço: {host}{produtoUrl}       → props.pageProps.productData.price_aux.value_to (value_from = "de")
 *
 * Validado ao vivo 14/07: ZenRows vence o Akamai (home 200); dipirona → 48 produtos; Novalgina R$41,99.
 * O preço é o PADRÃO da rede (não por CEP — a RD não expõe simulação simples); o CEP/entrega o
 * usuário confirma no site (handoff). Custo: 1 request de busca + 1 de preço por remédio (cache reduz).
 */
import axios from 'axios';
import type { PlatformNetwork } from './registry.js';
import type { PlatformProduct } from './types.js';
import { rankProductMatches } from './matching.js';

const ZENROWS_BASE = 'https://api.zenrows.com/v1/';
const DEFAULT_TIMEOUT_MS = 25000; // ZenRows resolve Akamai — bem mais lento que REST

/** true se o proxy anti-bot está configurado (sem ele, a RD fica desligada). */
export function zenrowsConfigured(): boolean {
  return !!(process.env['ZENROWS_API_KEY'] ?? '').trim();
}

/** GET via ZenRows → HTML cru da página (ou null se sem key / erro). */
async function zenrowsGetHtml(targetUrl: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<string | null> {
  const apikey = (process.env['ZENROWS_API_KEY'] ?? '').trim();
  if (!apikey) return null;
  try {
    const res = await axios.get(ZENROWS_BASE, {
      params: { apikey, url: targetUrl },
      timeout: timeoutMs,
      responseType: 'text',
      transformResponse: [(d) => d], // não deixa o axios parsear (queremos o HTML cru)
      validateStatus: (s) => s >= 200 && s < 300,
    });
    return typeof res.data === 'string' ? res.data : String(res.data ?? '');
  } catch {
    return null;
  }
}

/** Extrai o JSON do <script id="__NEXT_DATA__"> (SSR do Next.js). */
export function extractNextData(html: string): Record<string, unknown> | null {
  const m = /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(html ?? '');
  if (!m) return null;
  try {
    return JSON.parse(m[1]!) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// helpers de navegação defensiva no __NEXT_DATA__ (shape dinâmico)
function get(obj: unknown, ...path: string[]): unknown {
  let cur: unknown = obj;
  for (const k of path) {
    if (cur && typeof cur === 'object' && k in (cur as Record<string, unknown>)) cur = (cur as Record<string, unknown>)[k];
    else return undefined;
  }
  return cur;
}

export interface RDSearchHit { sku: string; name: string; url: string; brand: string | null; isKit: boolean }

/** Parseia os produtos da página de busca. Exportado pra teste com fixture. */
export function parseRDSearch(nextData: Record<string, unknown> | null): RDSearchHit[] {
  const prods = get(nextData, 'props', 'pageProps', 'pageProps', 'results', 'products');
  if (!Array.isArray(prods)) return [];
  const out: RDSearchHit[] = [];
  for (const p of prods) {
    const sku = String((p as Record<string, unknown>)?.['sku'] ?? '');
    const name = String((p as Record<string, unknown>)?.['name'] ?? '');
    const url = String((p as Record<string, unknown>)?.['url'] ?? '');
    if (sku && name && url) {
      out.push({ sku, name, url, brand: ((p as Record<string, unknown>)['brand'] as string) ?? null, isKit: !!(p as Record<string, unknown>)['isKit'] });
    }
  }
  return out;
}

/** Parseia o preço da página do produto (price_aux.value_to). Exportado pra teste. */
export function parseRDPrice(nextData: Record<string, unknown> | null): { price: number; listPrice: number | null } | null {
  const pd = get(nextData, 'props', 'pageProps', 'productData') as Record<string, unknown> | undefined;
  if (!pd) return null;
  const aux = pd['price_aux'] as Record<string, unknown> | undefined;
  const valueTo = aux && typeof aux['value_to'] === 'number' ? (aux['value_to'] as number) : null;
  const flat = typeof pd['price'] === 'number' && (pd['price'] as number) > 0 ? (pd['price'] as number) : null;
  const price = valueTo && valueTo > 0 ? valueTo : flat;
  if (price == null || price <= 0) return null;
  const from = aux && typeof aux['value_from'] === 'number' ? (aux['value_from'] as number) : null;
  return { price, listPrice: from && from > price ? from : null };
}

async function searchRD(net: PlatformNetwork, termo: string, timeoutMs?: number): Promise<RDSearchHit[]> {
  const html = await zenrowsGetHtml(`${net.host}/search?w=${encodeURIComponent(termo)}`, timeoutMs);
  return html ? parseRDSearch(extractNextData(html)) : [];
}

async function priceRD(net: PlatformNetwork, produtoUrl: string, timeoutMs?: number): Promise<{ price: number; listPrice: number | null } | null> {
  const full = produtoUrl.startsWith('http') ? produtoUrl : `${net.host}${produtoUrl.startsWith('/') ? '' : '/'}${produtoUrl}`;
  const html = await zenrowsGetHtml(full, timeoutMs);
  return html ? parseRDPrice(extractNextData(html)) : null;
}

function absoluteUrl(net: PlatformNetwork, url: string): string {
  return url.startsWith('http') ? url.split('?')[0]! : `${net.host}${url.startsWith('/') ? '' : '/'}${url}`.split('?')[0]!;
}

// Cache por (rede, termo) — evita re-renderizar (e re-gastar créditos ZenRows) em buscas
// repetidas. Preço da RD muda devagar; TTL 30min.
const RD_CACHE = new Map<string, { at: number; product: PlatformProduct | null }>();
const RD_CACHE_TTL_MS = 30 * 60 * 1000;

/**
 * Cota UM remédio na RD: busca → ranqueia (matching) → resolve o preço do melhor match.
 * Devolve um PlatformProduct (com preço e productUrl) ou null. Custo: 2 requests ZenRows
 * (cache-first — repetição não gasta crédito).
 */
export async function quoteRDProduct(
  net: PlatformNetwork,
  query: string,
  opts: { timeoutMs?: number; minScore?: number } = {},
): Promise<PlatformProduct | null> {
  const cacheKey = `${net.id}::${query.trim().toLowerCase()}`;
  const cached = RD_CACHE.get(cacheKey);
  if (cached && Date.now() - cached.at < RD_CACHE_TTL_MS) return cached.product;

  const result = await quoteRDProductUncached(net, query, opts);
  RD_CACHE.set(cacheKey, { at: Date.now(), product: result });
  return result;
}

async function quoteRDProductUncached(
  net: PlatformNetwork,
  query: string,
  opts: { timeoutMs?: number; minScore?: number },
): Promise<PlatformProduct | null> {
  const hits = await searchRD(net, query, opts.timeoutMs);
  if (!hits.length) return null;
  // hits → PlatformProduct SEM preço (o matching não usa preço); price real vem depois.
  const candidates: PlatformProduct[] = hits.map((h) => ({
    network: net.id, networkLabel: net.label, group: net.group,
    productName: h.name, sku: h.sku, sellerId: '1', ean: null,
    price: 0, listPrice: null, availableQuantity: 1,
    productUrl: absoluteUrl(net, h.url), activeIngredient: null,
  }));
  const best = rankProductMatches(query, candidates, { minScore: opts.minScore })[0];
  if (!best) return null;
  const pr = await priceRD(net, best.product.productUrl, opts.timeoutMs);
  if (!pr) return null;
  return { ...best.product, price: pr.price, listPrice: pr.listPrice };
}
