/**
 * Cliente da API pública do VTEX (Grupo A). Endpoints validados ao vivo em Pacheco,
 * Pague Menos, Drogaria São Paulo e São João (2026-07-14) — ver docs/PHARMACY_PLATFORMS.md.
 *
 *   busca:     GET  {host}/api/catalog_system/pub/products/search?ft={termo}&_from=&_to=
 *   preço/CEP: POST {host}/api/checkout/pub/orderForms/simulation?sc={sc}
 *   handoff:   {host}/checkout/cart/add?sku={sku}&qty=&seller=&sc=   (carrinho pré-montado)
 */
import axios, { type AxiosRequestConfig } from 'axios';
import type { PlatformNetwork } from './registry.js';
import type { PlatformProduct, PlatformFulfillment, FulfillmentOption } from './types.js';

// User-Agent de navegador: as APIs REST do Grupo A respondem sem isso, mas mandar um UA
// realista reduz chance de tropeçar em regra de bot leve (e nunca finge ser outra coisa).
const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

const DEFAULT_TIMEOUT_MS = 8000;
// Limites de sanidade pra descartar SLA-sentinela ("não entrego aqui de verdade"): nenhum
// frete real de farmácia passa de R$150, nem prazo real de e-commerce passa de ~20 dias.
const MAX_REALISTIC_FEE_CENTS = 15000;
const MAX_REALISTIC_ETA_MIN = 20 * 24 * 60;

function headers() {
  return { 'User-Agent': BROWSER_UA, Accept: 'application/json', 'Accept-Language': 'pt-BR' };
}

/** Uma tentativa de retry em erro de rede/timeout/5xx — não martela (CLAUDE.md: timeout+retry). */
async function withRetry<T>(fn: () => Promise<T>, tries = 2): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

export function onlyDigits(s: string): string {
  return (s ?? '').replace(/\D/g, '');
}

function centavosToReais(c: number | null | undefined): number {
  return typeof c === 'number' && Number.isFinite(c) ? Math.round(c) / 100 : 0;
}

/** '60m'|'2h'|'1bd'|'5d' → texto PT-BR legível. Retorna o cru se o formato não casar. */
export function formatShippingEstimate(est: string): string {
  const raw = (est ?? '').trim();
  const m = /^(\d+)\s*(m|h|d|bd|min)$/i.exec(raw);
  if (!m) return raw;
  const n = Number(m[1]);
  const u = m[2]!.toLowerCase();
  if (u === 'm' || u === 'min') return `${n} min`;
  if (u === 'h') return n === 1 ? '1 hora' : `${n} horas`;
  if (u === 'bd') return n === 0 ? 'no mesmo dia útil' : n === 1 ? '1 dia útil' : `${n} dias úteis`;
  // 'd'
  return n === 0 ? 'hoje' : n === 1 ? '1 dia' : `${n} dias`;
}

// ─────────────────────────────── BUSCA ───────────────────────────────

/**
 * Extrai o MELHOR SKU de um produto do catálogo: entre os items×sellers, prefere
 * disponível e de menor preço. Exportada pra ser testável com fixtures reais.
 */
export function mapVtexProduct(net: Pick<PlatformNetwork, 'id' | 'label' | 'group'>, raw: unknown): PlatformProduct | null {
  const p = raw as Record<string, unknown>;
  if (!p || typeof p !== 'object') return null;
  const productName = typeof p['productName'] === 'string' ? (p['productName'] as string) : null;
  const items = Array.isArray(p['items']) ? (p['items'] as Record<string, unknown>[]) : [];
  if (!productName || items.length === 0) return null;

  let best: { sku: string; sellerId: string; ean: string | null; price: number; listPrice: number | null; qty: number } | null = null;
  for (const it of items) {
    const sku = typeof it['itemId'] === 'string' ? (it['itemId'] as string) : String(it['itemId'] ?? '');
    if (!sku) continue;
    const ean = typeof it['ean'] === 'string' && it['ean'] ? (it['ean'] as string) : null;
    const sellers = Array.isArray(it['sellers']) ? (it['sellers'] as Record<string, unknown>[]) : [];
    for (const s of sellers) {
      const sellerId = typeof s['sellerId'] === 'string' && s['sellerId'] ? (s['sellerId'] as string) : String(s['sellerId'] ?? '1');
      const offer = (s['commertialOffer'] ?? {}) as Record<string, unknown>;
      const price = typeof offer['Price'] === 'number' ? (offer['Price'] as number) : NaN;
      if (!Number.isFinite(price) || price <= 0) continue;
      const listPrice = typeof offer['ListPrice'] === 'number' ? (offer['ListPrice'] as number) : null;
      const qty = typeof offer['AvailableQuantity'] === 'number' ? (offer['AvailableQuantity'] as number) : 0;
      // "melhor" = disponível ganha de indisponível; entre iguais, menor preço.
      const better =
        !best ||
        (qty > 0 && best.qty <= 0) ||
        ((qty > 0) === (best.qty > 0) && price < best.price);
      if (better) best = { sku, sellerId, ean, price, listPrice, qty };
    }
  }
  if (!best) return null;

  const ingredient =
    Array.isArray(p['Princípio Ativo']) ? (p['Princípio Ativo'] as unknown[]).map(String).filter(Boolean) :
    Array.isArray(p['Principio Ativo']) ? (p['Principio Ativo'] as unknown[]).map(String).filter(Boolean) :
    null;

  return {
    network: net.id,
    networkLabel: net.label,
    group: net.group,
    productName,
    sku: best.sku,
    sellerId: best.sellerId,
    ean: best.ean,
    price: best.price,
    listPrice: best.listPrice && best.listPrice > best.price ? best.listPrice : null,
    availableQuantity: best.qty,
    productUrl: typeof p['link'] === 'string' ? (p['link'] as string) : `${''}`,
    activeIngredient: ingredient && ingredient.length ? ingredient : null,
  };
}

/** Busca produtos por texto livre na vitrine pública de uma rede VTEX. */
export async function searchVtexProducts(
  net: PlatformNetwork,
  term: string,
  opts: { limit?: number; timeoutMs?: number; retries?: number } = {},
): Promise<PlatformProduct[]> {
  const limit = Math.max(1, Math.min(opts.limit ?? 10, 50));
  const url =
    `${net.host}/api/catalog_system/pub/products/search` +
    `?ft=${encodeURIComponent(term)}&_from=0&_to=${limit - 1}&sc=${encodeURIComponent(net.salesChannel)}`;
  const cfg: AxiosRequestConfig = { timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, headers: headers() };
  const data = await withRetry(async () => (await axios.get<unknown[]>(url, cfg)).data, opts.retries ?? 2);
  if (!Array.isArray(data)) return [];
  const out: PlatformProduct[] = [];
  for (const raw of data) {
    const mapped = mapVtexProduct(net, raw);
    if (mapped) out.push(mapped);
  }
  return out;
}

// ───────────────────────── SIMULAÇÃO POR CEP ─────────────────────────

/** Escolhe a melhor opção de um conjunto de SLAs: menor prazo, desempate por menor frete. */
function pickBestSla(slas: Record<string, unknown>[]): FulfillmentOption | null {
  let best: { rankMin: number; fee: number; est: string } | null = null;
  for (const s of slas) {
    const est = typeof s['shippingEstimate'] === 'string' ? (s['shippingEstimate'] as string) : '';
    const fee = centavosToReais(typeof s['price'] === 'number' ? (s['price'] as number) : 0);
    const rankMin = estimateToMinutes(est);
    if (!best || rankMin < best.rankMin || (rankMin === best.rankMin && fee < best.fee)) {
      best = { rankMin, fee, est };
    }
  }
  return best ? { etaText: formatShippingEstimate(best.est), feeReais: best.fee } : null;
}

/** Converte shippingEstimate num nº de minutos comparável (pra achar a opção mais rápida). */
export function estimateToMinutes(est: string): number {
  const m = /^(\d+)\s*(m|h|d|bd|min)$/i.exec((est ?? '').trim());
  if (!m) return Number.MAX_SAFE_INTEGER;
  const n = Number(m[1]);
  const u = m[2]!.toLowerCase();
  if (u === 'm' || u === 'min') return n;
  if (u === 'h') return n * 60;
  return n * 24 * 60; // 'd' e 'bd' contam como dias (útil ~ dia pro ranking)
}

/**
 * Melhor entrega e retirada a partir do logisticsInfo, descartando SLA-sentinela (frete
 * gigante + prazo enorme, ex.: São João "30 dias / R$1000" = "não entrego de verdade aqui").
 */
function bestSlasFromLogistics(li: Record<string, unknown>[]): { delivery: FulfillmentOption | null; pickup: FulfillmentOption | null } {
  const slas = li[0] && Array.isArray(li[0]['slas']) ? (li[0]['slas'] as Record<string, unknown>[]) : [];
  const ok = (s: Record<string, unknown>) => {
    const feeCents = typeof s['price'] === 'number' ? (s['price'] as number) : 0;
    return feeCents <= MAX_REALISTIC_FEE_CENTS && estimateToMinutes(String(s['shippingEstimate'] ?? '')) <= MAX_REALISTIC_ETA_MIN;
  };
  const deliverySlas = slas.filter((s) => s['deliveryChannel'] !== 'pickup-in-point').filter(ok);
  const pickupSlas = slas.filter((s) => s['deliveryChannel'] === 'pickup-in-point').filter(ok);
  return {
    delivery: deliverySlas.length ? pickBestSla(deliverySlas) : null,
    pickup: pickupSlas.length ? pickBestSla(pickupSlas) : null,
  };
}

/**
 * Parser do orderForms/simulation → preço/estoque/entrega por CEP. Exportado pra teste.
 */
export function parseVtexSimulation(raw: unknown): PlatformFulfillment | null {
  const d = raw as Record<string, unknown>;
  if (!d || typeof d !== 'object') return null;
  const items = Array.isArray(d['items']) ? (d['items'] as Record<string, unknown>[]) : [];
  if (items.length === 0) return null;
  const it = items[0]!;
  const price = centavosToReais(typeof it['price'] === 'number' ? (it['price'] as number) : 0);
  if (price <= 0) return null;
  const listCents = typeof it['listPrice'] === 'number' ? (it['listPrice'] as number) : null;
  const listPrice = listCents && listCents > (it['price'] as number) ? centavosToReais(listCents) : null;
  const available = String(it['availability'] ?? '') === 'available';

  const li = Array.isArray(d['logisticsInfo']) ? (d['logisticsInfo'] as Record<string, unknown>[]) : [];
  const { delivery, pickup } = bestSlasFromLogistics(li);
  return { price, listPrice, available, delivery, pickup };
}

/** Simula a compra de 1 SKU num CEP → preço real + disponibilidade + entrega/retirada. */
export async function simulateVtexByCep(
  net: PlatformNetwork,
  sku: string,
  cep: string,
  opts: { seller?: string; timeoutMs?: number; retries?: number } = {},
): Promise<PlatformFulfillment | null> {
  const postalCode = onlyDigits(cep);
  if (postalCode.length !== 8) return null;
  const url = `${net.host}/api/checkout/pub/orderForms/simulation?sc=${encodeURIComponent(net.salesChannel)}`;
  const body = {
    items: [{ id: String(sku), quantity: 1, seller: String(opts.seller ?? '1') }],
    postalCode,
    country: 'BRA',
  };
  const cfg: AxiosRequestConfig = {
    timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    headers: { ...headers(), 'Content-Type': 'application/json' },
  };
  const data = await withRetry(async () => (await axios.post<unknown>(url, body, cfg)).data, opts.retries ?? 2);
  return parseVtexSimulation(data);
}

// ───────────────────────────── HANDOFF ─────────────────────────────

/** Link de carrinho pré-montado (add-to-cart). Validado ao vivo: cai no checkout com o item. */
export function buildVtexCartLink(net: PlatformNetwork, sku: string, qty = 1, seller = '1'): string {
  const q = Math.max(1, Math.floor(qty));
  return `${net.host}/checkout/cart/add?sku=${encodeURIComponent(sku)}&qty=${q}&seller=${encodeURIComponent(seller)}&sc=${encodeURIComponent(net.salesChannel)}`;
}

// ─── Cesta multi-item (pedido com N remédios → 1 carrinho, 1 pagamento) ───────

export interface BasketItem { sku: string; seller: string; qty: number; }

/**
 * Carrinho pré-montado com VÁRIOS SKUs (sku/qty/seller repetidos). Validado ao vivo:
 * `?sku=A&qty=1&seller=1&sku=B&qty=1&seller=1&sc=1` → 302 pro /checkout/#/cart com os dois.
 */
export function buildVtexCartLinkMulti(net: PlatformNetwork, items: BasketItem[]): string {
  const parts = items
    .map((it) => `sku=${encodeURIComponent(it.sku)}&qty=${Math.max(1, Math.floor(it.qty))}&seller=${encodeURIComponent(it.seller)}`)
    .join('&');
  return `${net.host}/checkout/cart/add?${parts}&sc=${encodeURIComponent(net.salesChannel)}`;
}

export interface VtexBasketResult {
  /** preço UNITÁRIO por sku no CEP (reais) */
  perSku: Record<string, { price: number; available: boolean }>;
  /** total da cesta no CEP (reais) — soma de price×qty dos itens disponíveis */
  total: number;
  /** todos os itens simulados estão disponíveis? */
  allAvailable: boolean;
  delivery: FulfillmentOption | null;
  pickup: FulfillmentOption | null;
}

/** Parser da simulação multi-item → preço por sku + total + entrega. Exportado pra teste. */
export function parseVtexBasketSimulation(raw: unknown): VtexBasketResult | null {
  const d = raw as Record<string, unknown>;
  if (!d || typeof d !== 'object') return null;
  const items = Array.isArray(d['items']) ? (d['items'] as Record<string, unknown>[]) : [];
  if (items.length === 0) return null;
  const perSku: Record<string, { price: number; available: boolean }> = {};
  let total = 0;
  let allAvailable = true;
  for (const it of items) {
    const id = String(it['id'] ?? '');
    const price = centavosToReais(typeof it['price'] === 'number' ? (it['price'] as number) : 0);
    const qty = typeof it['quantity'] === 'number' ? (it['quantity'] as number) : 1;
    const available = String(it['availability'] ?? '') === 'available';
    if (id) perSku[id] = { price, available };
    if (available) total += price * qty;
    else allAvailable = false;
  }
  const li = Array.isArray(d['logisticsInfo']) ? (d['logisticsInfo'] as Record<string, unknown>[]) : [];
  const { delivery, pickup } = bestSlasFromLogistics(li);
  return { perSku, total, allAvailable, delivery, pickup };
}

/** Simula uma CESTA (N skus) num CEP → preço por sku + total + entrega. */
export async function simulateVtexBasket(
  net: PlatformNetwork,
  items: BasketItem[],
  cep: string,
  opts: { timeoutMs?: number; retries?: number } = {},
): Promise<VtexBasketResult | null> {
  const postalCode = onlyDigits(cep);
  if (postalCode.length !== 8 || items.length === 0) return null;
  const url = `${net.host}/api/checkout/pub/orderForms/simulation?sc=${encodeURIComponent(net.salesChannel)}`;
  const body = {
    items: items.map((it) => ({ id: String(it.sku), quantity: Math.max(1, Math.floor(it.qty)), seller: String(it.seller) })),
    postalCode,
    country: 'BRA',
  };
  const cfg: AxiosRequestConfig = {
    timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    headers: { ...headers(), 'Content-Type': 'application/json' },
  };
  const data = await withRetry(async () => (await axios.post<unknown>(url, body, cfg)).data, opts.retries ?? 2);
  return parseVtexBasketSimulation(data);
}
