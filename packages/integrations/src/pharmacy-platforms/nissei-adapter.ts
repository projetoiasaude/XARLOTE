/**
 * Adaptador da Nissei (Farmácias Nissei) — plataforma PRÓPRIA (backend Django + Elasticsearch),
 * NÃO é VTEX/Akamai. Aberta server-side (nginx 200, sem anti-bot), SEM proxy.
 *
 * ⚠️ A busca é 100% via API (o HTML de /pesquisa/?q= traz só um grid DEFAULT fixo — não os
 * resultados; por isso NÃO se parseia o HTML). Fluxo real (validado ao vivo 15/07):
 *   csrf : GET  {host}/pesquisa/          → cookie `csrftoken` + campo `csrfmiddlewaretoken`
 *   busca: POST {host}/pesquisa/pesquisar (csrf + termo=…) →
 *          {"produtos":[{ "_id", "_source":{ "nm_produto","url_produto","is_disponivel" } }], "quantidade"}
 *   preço: POST {host}/pegar/preco (csrf + produtos_ids[]) →
 *          {"precos":{"<id>":{"publico":{"valor_fim","valor_ini","is_disponivel","produto_url"}}}}
 *
 * Ranqueia por nome (nm_produto) e só então busca o preço dos melhores ids (barato). Preço é o
 * PADRÃO da rede (a Nissei confirma filial/entrega no site → handoff, sem preço por CEP).
 * Django CSRF: o par (cookie `csrftoken` + `csrfmiddlewaretoken`) tem que voltar junto no POST.
 */
import axios from 'axios';
import type { PlatformNetwork } from './registry.js';
import type { PlatformProduct } from './types.js';
import { rankProductMatches } from './matching.js';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const DEFAULT_TIMEOUT_MS = 9000;
const PRICE_TOP_N = 12; // só busca preço dos N melhores matches (a busca já ranqueia por relevância)

/** Humaniza o slug → nome legível (fallback quando nm_produto falta). "1gr"→"1g" (a Nissei usa "gr"). */
export function humanizeNisseiSlug(slug: string): string {
  const words = slug
    .replace(/^\//, '')
    .replace(/-/g, ' ')
    .replace(/\b(\d+)gr\b/gi, '$1g')
    .replace(/\s+/g, ' ')
    .trim();
  return words.replace(/\b\w/g, (c) => c.toUpperCase());
}

function num(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    // Robusto a BR ("1.234,56") e US ("1234.56"): se há vírgula, ela é o decimal → remove os
    // pontos de milhar; senão o ponto é o decimal. Sem isso, "1.234,56" viraria 1.234 (review M2).
    const s = v.includes(',') ? v.replace(/\./g, '').replace(',', '.') : v;
    const n = parseFloat(s.replace(/[^\d.]/g, ''));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function absoluteUrl(net: PlatformNetwork, url: string): string {
  if (!url) return net.host;
  if (url.startsWith('http')) return url.split('?')[0]!;
  return `${net.host}/${url.replace(/^\//, '')}`.split('?')[0]!;
}

export interface NisseiCsrf {
  csrf: string | null;
  /** valor do cookie csrftoken (Django exige o par cookie+token no POST) */
  cookie: string | null;
}

/** Extrai o csrf token (inline) + o cookie csrftoken do Set-Cookie de um GET. */
export function parseNisseiCsrf(html: string, setCookie: string[] | undefined): NisseiCsrf {
  const csrfM =
    /name="csrfmiddlewaretoken"\s+value="([^"]+)"/.exec(html) ??
    /csrfmiddlewaretoken['":\s>]+([A-Za-z0-9]{24,})/.exec(html);
  let cookie: string | null = null;
  for (const c of setCookie ?? []) {
    const cm = /csrftoken=([^;]+)/.exec(c);
    if (cm) {
      cookie = cm[1]!;
      break;
    }
  }
  // token do form OU, na falta, o próprio valor do cookie (Django aceita X-CSRFToken == cookie).
  return { csrf: csrfM ? csrfM[1]! : cookie, cookie };
}

export interface NisseiResult {
  id: string;
  name: string;
  slug: string;
  available: boolean;
}

/** Parseia os produtos da resposta de /pesquisa/pesquisar (Elasticsearch). Exportado pra teste. */
export function parseNisseiResults(json: unknown): NisseiResult[] {
  const prods = (json as { produtos?: unknown })?.produtos;
  if (!Array.isArray(prods)) return [];
  const out: NisseiResult[] = [];
  for (const p of prods) {
    const rec = (p ?? {}) as Record<string, unknown>;
    const src = (rec['_source'] ?? {}) as Record<string, unknown>;
    const id = String(rec['_id'] ?? src['cd_produto'] ?? '');
    const slug = String(src['url_produto'] ?? '');
    const name = String(src['nm_produto'] ?? (slug ? humanizeNisseiSlug(slug) : ''));
    if (!id || !name || !slug) continue;
    out.push({ id, name, slug, available: src['is_disponivel'] !== false });
  }
  return out;
}

export interface NisseiPriceEntry {
  url: string;
  price: number;
  listPrice: number | null;
  available: boolean;
  tipo: string;
}

/** Parseia a resposta de /pegar/preco em {id → {url, price, …}}. Exportado pra teste. */
export function parseNisseiPrices(json: unknown): Record<string, NisseiPriceEntry> {
  const out: Record<string, NisseiPriceEntry> = {};
  const precos = (json as { precos?: unknown })?.precos;
  if (!precos || typeof precos !== 'object') return out;
  for (const [id, clubesRaw] of Object.entries(precos as Record<string, unknown>)) {
    const clubes = (clubesRaw ?? {}) as Record<string, unknown>;
    // SÓ o preço `publico` (o que qualquer visitante paga). Sem publico → pula o produto: cair num
    // clube arbitrário exporia preço de SÓCIO (menor que o visitante paga no site) — preço enganoso
    // é o risco 🔴 P6 da auditoria do 1º pedido (review M1).
    const p = clubes['publico'] as Record<string, unknown> | undefined;
    if (!p) continue;
    const price = num(p['valor_fim']) ?? num(p['valor_ini']);
    if (price == null || price <= 0) continue;
    const listIni = num(p['valor_ini']);
    out[id] = {
      url: String(p['produto_url'] ?? ''),
      price,
      listPrice: listIni != null && listIni > price ? listIni : null,
      available: p['is_disponivel'] !== false,
      tipo: String(p['produto_tipo'] ?? ''),
    };
  }
  return out;
}

// ─── requests ────────────────────────────────────────────────────────────────

// csrf+cookie são reutilizáveis por um tempo → cache (evita re-baixar a página só pelo token).
const CSRF_CACHE = new Map<string, { at: number; csrf: string; cookie: string }>();
const CSRF_TTL_MS = 8 * 60 * 1000;

async function getCsrf(net: PlatformNetwork, timeout: number): Promise<NisseiCsrf> {
  const c = CSRF_CACHE.get(net.id);
  if (c && Date.now() - c.at < CSRF_TTL_MS) return { csrf: c.csrf, cookie: c.cookie };
  const res = await axios.get(`${net.host}/pesquisa/`, {
    timeout,
    responseType: 'text',
    transformResponse: [(d) => d],
    headers: { 'User-Agent': UA, Accept: 'text/html' },
    validateStatus: (s) => s >= 200 && s < 300,
  });
  const parsed = parseNisseiCsrf(String(res.data ?? ''), res.headers['set-cookie']);
  if (parsed.csrf && parsed.cookie) CSRF_CACHE.set(net.id, { at: Date.now(), csrf: parsed.csrf, cookie: parsed.cookie });
  return parsed;
}

function postHeaders(net: PlatformNetwork, csrf: string, cookie: string): Record<string, string> {
  return {
    'User-Agent': UA,
    'X-Requested-With': 'XMLHttpRequest',
    'X-CSRFToken': csrf,
    'Content-Type': 'application/x-www-form-urlencoded',
    Referer: `${net.host}/pesquisa/`,
    Cookie: `csrftoken=${cookie}`,
  };
}

async function searchNissei(net: PlatformNetwork, termo: string, csrf: string, cookie: string, timeout: number): Promise<NisseiResult[]> {
  const form = new URLSearchParams();
  form.set('csrfmiddlewaretoken', csrf);
  form.set('termo', termo);
  const res = await axios.post(`${net.host}/pesquisa/pesquisar`, form.toString(), {
    timeout,
    responseType: 'json',
    headers: postHeaders(net, csrf, cookie),
    validateStatus: (s) => s >= 200 && s < 300,
  });
  return parseNisseiResults(res.data);
}

async function priceNissei(net: PlatformNetwork, ids: string[], csrf: string, cookie: string, timeout: number): Promise<Record<string, NisseiPriceEntry>> {
  if (!ids.length) return {};
  const form = new URLSearchParams();
  form.set('csrfmiddlewaretoken', csrf);
  for (const id of ids) form.append('produtos_ids[]', id);
  const res = await axios.post(`${net.host}/pegar/preco`, form.toString(), {
    timeout,
    responseType: 'json',
    headers: postHeaders(net, csrf, cookie),
    validateStatus: (s) => s >= 200 && s < 300,
  });
  return parseNisseiPrices(res.data);
}

// Cache do resultado final por (rede, termo) — TTL 30min (preço muda devagar).
const NISSEI_CACHE = new Map<string, { at: number; product: PlatformProduct | null }>();
const NISSEI_CACHE_TTL_MS = 30 * 60 * 1000;

/**
 * Cota UM remédio na Nissei: busca (API ES) → ranqueia por nome → preço dos melhores ids →
 * devolve o melhor match DISPONÍVEL com preço. Retorna PlatformProduct ou null.
 */
export async function quoteNisseiProduct(
  net: PlatformNetwork,
  query: string,
  opts: { timeoutMs?: number; minScore?: number } = {},
): Promise<PlatformProduct | null> {
  const key = `${net.id}::${query.trim().toLowerCase()}`;
  const cached = NISSEI_CACHE.get(key);
  if (cached && Date.now() - cached.at < NISSEI_CACHE_TTL_MS) return cached.product;

  // Erro (rede/timeout/403 persistente) PROPAGA e NÃO entra no cache — senão um blip congelaria
  // "não achei" por 30min mesmo com o remédio em estoque (review M5). Só cacheia resultado REAL
  // (produto, ou null de "buscou e não casou"). O chamador (quoteBasketCustom) trata o throw.
  const result = await quoteNisseiUncached(net, query, opts);
  NISSEI_CACHE.set(key, { at: Date.now(), product: result });
  return result;
}

async function quoteNisseiUncached(
  net: PlatformNetwork,
  query: string,
  opts: { timeoutMs?: number; minScore?: number },
): Promise<PlatformProduct | null> {
  const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let { csrf, cookie } = await getCsrf(net, timeout);
  if (!csrf || !cookie) return null;

  // busca + preço num closure — se QUALQUER POST der 403 (token expirado), renova o csrf UMA vez
  // e refaz TUDO (a renovação cobre busca E preço — review M5).
  const run = async (): Promise<PlatformProduct | null> => {
    const results = await searchNissei(net, query, csrf!, cookie!, timeout);
    if (!results.length) return null;

    // candidatos SEM preço (matching usa só o nome) → ranqueia → preço só dos melhores.
    const candidates: PlatformProduct[] = results.map((r) => ({
      network: net.id,
      networkLabel: net.label,
      group: net.group,
      productName: r.name,
      sku: r.id,
      sellerId: '1',
      ean: null,
      price: 0,
      listPrice: null,
      availableQuantity: r.available ? 1 : 0,
      productUrl: absoluteUrl(net, r.slug),
      activeIngredient: null,
    }));
    const ranked = rankProductMatches(query, candidates, { minScore: opts.minScore }).filter(
      (m) => m.product.availableQuantity > 0,
    );
    if (!ranked.length) return null;

    const prices = await priceNissei(net, ranked.slice(0, PRICE_TOP_N).map((m) => m.product.sku), csrf!, cookie!, timeout);
    for (const m of ranked) {
      const pe = prices[m.product.sku];
      if (pe && pe.available && pe.price > 0) return { ...m.product, price: pe.price, listPrice: pe.listPrice };
    }
    return null;
  };

  try {
    return await run();
  } catch (err) {
    if (axios.isAxiosError(err) && err.response?.status === 403) {
      CSRF_CACHE.delete(net.id);
      ({ csrf, cookie } = await getCsrf(net, timeout));
      if (!csrf || !cookie) return null;
      return await run();
    }
    throw err;
  }
}

/** Limpa os caches (teste/manutenção). */
export function _clearNisseiCache(): void {
  NISSEI_CACHE.clear();
  CSRF_CACHE.clear();
}
