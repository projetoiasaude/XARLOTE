/**
 * Adaptador da Ultrafarma — plataforma PRÓPRIA (Angular SSR + Linx Impulse), NÃO é VTEX/Akamai.
 *
 * Aberta server-side (CDN GoCache 200, sem anti-bot), SEM proxy. A busca renderiza os cards no
 * próprio HTML (SSR) — preço incluso, sem 2ª chamada:
 *   busca: GET {host}/busca?q={termo}  → 302 → {host}/lp/{termo}
 *   card:  <div class="product-item …"> img .../produtos/{id}/small (title=nome)
 *          + <a class="product-item-link" href="/{slug}">
 *          + .product-item-name + .product-item-price-info (R$ atual) + .product-item-old-price ("de")
 *
 * Preço é o PADRÃO da rede (Ultrafarma é online-nacional; CEP/entrega confirmados no site → handoff).
 * Validado ao vivo 15/07 (dipirona → 12 cards com nome+slug+preço reais, ex. genérico R$2,23–4,27).
 */
import axios from 'axios';
import type { PlatformNetwork } from './registry.js';
import type { PlatformProduct } from './types.js';
import { rankProductMatches } from './matching.js';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const DEFAULT_TIMEOUT_MS = 9000;

/** "1.234,56" → 1234.56 ; "4,27" → 4.27 ; null se não parsear. */
export function parseBrl(s: string): number | null {
  const cleaned = s.replace(/[^\d.,]/g, '').replace(/\./g, '').replace(',', '.');
  const n = parseFloat(cleaned);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function unescapeHtml(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Parseia os cards de produto do HTML SSR da Ultrafarma. Divide o documento por container
 * `product-item` e extrai (nome, slug, preço, preço "de", id) de cada bloco isolado — evita
 * cruzar a fronteira entre cards (achado do parser: janela larga misturava vizinhos).
 */
export function parseUltrafarmaProducts(net: PlatformNetwork, html: string): PlatformProduct[] {
  const opens: number[] = [];
  // container do card = classe `product-item` isolada (seguida de espaço ou aspas), NUNCA
  // `product-item-name`/`-price`/… (o lookahead exclui `-` e word-char depois de "product-item").
  // Aceita QUALQUER tag (div/li/section/custom-element do Angular) — senão um card não-div colaria
  // no vizinho e herdaria o preço errado (review M4).
  const containerRe = /<[a-z][a-z0-9-]*[^>]*class="[^"]*\bproduct-item(?![-\w])[^"]*"/gi;
  let cm: RegExpExecArray | null;
  while ((cm = containerRe.exec(html)) !== null) opens.push(cm.index);
  opens.push(html.length);

  const out: PlatformProduct[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < opens.length - 1; i++) {
    const block = html.slice(opens[i]!, opens[i + 1]!);

    // nome: âncora com fronteira de classe (não casa `product-item-name-brand` — review L3).
    const nameM = /product-item-name(?![-\w])[^>]*>\s*(?:<[^>]+>\s*)*([^<]{3,120})/.exec(block);
    if (!nameM) continue;
    const productName = unescapeHtml(nameM[1]!);

    // slug: SÓ o anchor do produto (product-item-link). Sem fallback de href genérico — pegaria
    // link de categoria/breadcrumb e o handoff apontaria pro lugar errado (review L1).
    const slugM =
      /<a[^>]*class="[^"]*product-item-link[^"]*"[^>]*href="([^"]+)"/.exec(block) ??
      /<a[^>]*href="([^"]+)"[^>]*class="[^"]*product-item-link/.exec(block);
    if (!slugM) continue;
    const slug = slugM[1]!;

    // preço de VENDA: ancorado ao rótulo "Por" (o preço vigente que o cliente paga). Na estrutura
    // real o "De" (riscado) vem ANTES do "Por" e NÃO é texto "R$" (fica em data-preco) → o 1º
    // "R$ x,yy" após "Por" é a venda, nunca o "de" (review M3). Fallback (card sem desconto, sem
    // "Por") = 1º "R$" do bloco, que aí É a própria venda.
    const priceM =
      />\s*Por\s*<[\s\S]{0,500}?R\$\s*([\d.]+,\d{2})/i.exec(block) ??
      /R\$\s*([\d.]+,\d{2})/.exec(block);
    const price = priceM ? parseBrl(priceM[1]!) : null;
    if (price == null) continue;

    // "de" (preço riscado): data-preco do product-item-old-price ("27,080" → 27,08). Só se > venda.
    const oldM = /product-item-old-price(?![-\w])[\s\S]{0,160}?data-preco="([\d.,]+)"/.exec(block);
    const listRaw = oldM ? parseBrl(oldM[1]!) : null;
    const listPrice = listRaw != null && listRaw > price ? listRaw : null;

    const idM = /\/produtos?\/(\d+)\/(?:small|medium|big)/.exec(block);
    const sku = idM ? idM[1]! : slug.replace(/[^a-z0-9]/gi, '').slice(0, 24);

    if (seen.has(slug)) continue;
    seen.add(slug);

    out.push({
      network: net.id,
      networkLabel: net.label,
      group: net.group,
      productName,
      sku,
      sellerId: '1',
      ean: null,
      price,
      listPrice: listPrice != null && listPrice > price ? listPrice : null,
      availableQuantity: 1, // só cards de produto disponível são renderizados na busca
      productUrl: slug.startsWith('http') ? slug : `${net.host}/${slug.replace(/^\//, '')}`,
      activeIngredient: null,
    });
  }
  return out;
}

// Cache por (rede, termo) — TTL 30min (preço muda devagar).
const ULTRA_CACHE = new Map<string, { at: number; product: PlatformProduct | null }>();
const ULTRA_CACHE_TTL_MS = 30 * 60 * 1000;

/**
 * Cota UM remédio na Ultrafarma: busca (SSR) → parseia cards → ranqueia o melhor match.
 * 1 request server-side (preço já vem no HTML). Retorna PlatformProduct ou null.
 */
export async function quoteUltrafarmaProduct(
  net: PlatformNetwork,
  query: string,
  opts: { timeoutMs?: number; minScore?: number } = {},
): Promise<PlatformProduct | null> {
  const key = `${net.id}::${query.trim().toLowerCase()}`;
  const cached = ULTRA_CACHE.get(key);
  if (cached && Date.now() - cached.at < ULTRA_CACHE_TTL_MS) return cached.product;

  const result = await quoteUltrafarmaUncached(net, query, opts);
  ULTRA_CACHE.set(key, { at: Date.now(), product: result });
  return result;
}

async function quoteUltrafarmaUncached(
  net: PlatformNetwork,
  query: string,
  opts: { timeoutMs?: number; minScore?: number },
): Promise<PlatformProduct | null> {
  const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const res = await axios.get(`${net.host}/busca?q=${encodeURIComponent(query)}`, {
    timeout,
    responseType: 'text',
    transformResponse: [(d) => d],
    maxRedirects: 2, // /busca → 302 → /lp/{termo} (1 hop; teto baixo evita multiplicar o timeout — review L2)
    headers: { 'User-Agent': UA, Accept: 'text/html' },
    validateStatus: (s) => s >= 200 && s < 400,
  });
  const products = parseUltrafarmaProducts(net, String(res.data ?? ''));
  if (!products.length) return null;
  const best = rankProductMatches(query, products, { minScore: opts.minScore })[0];
  return best ? best.product : null;
}

/** Limpa o cache (teste/manutenção). */
export function _clearUltrafarmaCache(): void {
  ULTRA_CACHE.clear();
}
