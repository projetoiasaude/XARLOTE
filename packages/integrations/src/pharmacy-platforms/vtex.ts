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
import type { PlatformProduct, PlatformFulfillment, FulfillmentOption, PickupStore } from './types.js';

// User-Agent de navegador: as APIs REST do Grupo A respondem sem isso, mas mandar um UA
// realista reduz chance de tropeçar em regra de bot leve (e nunca finge ser outra coisa).
const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

const DEFAULT_TIMEOUT_MS = 8000;
// Limites de sanidade pra descartar SLA-sentinela ("não entrego aqui de verdade"): nenhum
// frete real de farmácia passa de R$150, nem prazo real de e-commerce passa de ~20 dias.
const MAX_REALISTIC_FEE_CENTS = 15000;
const MAX_REALISTIC_ETA_MIN = 20 * 24 * 60;
/** "No mesmo dia útil", sem hora: tratado como 8h pra ordenar (ver estimateToMinutes). */
const MESMO_DIA_MIN = 8 * 60;

/**
 * O cliente HTTP da VTEX — trocável SÓ em teste.
 *
 * Com pnpm, o `axios` deste pacote é outro arquivo físico que o da raiz (que nem existe),
 * então `vi.mock('axios')` num teste não intercepta nada: a primeira versão do teste ponta
 * a ponta da cotação bateu nas APIs REAIS da Pague Menos. Uma costura explícita é mais
 * honesta que um mock por caminho de versão (`.pnpm/axios@1.15.1/...`), que quebraria em
 * silêncio no próximo upgrade.
 */
export interface ClienteHttp {
  get<T = unknown>(url: string, cfg?: AxiosRequestConfig): Promise<{ data: T }>;
  post<T = unknown>(url: string, body: unknown, cfg?: AxiosRequestConfig): Promise<{ data: T }>;
}
let http: ClienteHttp = axios;

/** Só pra teste: troca o cliente HTTP (`null` volta pro axios). */
export function __definirClienteHttpParaTeste(cliente: ClienteHttp | null): void {
  http = cliente ?? axios;
}

function headers() {
  return { 'User-Agent': BROWSER_UA, Accept: 'application/json', 'Accept-Language': 'pt-BR' };
}

/**
 * Tentativas em erro de rede/timeout/5xx — não martela (CLAUDE.md: timeout+retry).
 *
 * ⚠️ `tries` é o TOTAL de tentativas, e nunca menos que 1. A primeira versão da troca de
 * marca (24/09) passou `retries: 0` querendo dizer "sem nova tentativa" — o laço não
 * rodava, a função lançava `undefined` sem fazer a chamada, e o `catch` de quem chamou
 * engolia. A etapa inteira ficou morta sem uma linha de log; a revisão independente pegou.
 */
async function withRetry<T>(fn: () => Promise<T>, tries = 2): Promise<T> {
  let lastErr: unknown;
  const total = Math.max(1, Math.floor(tries));
  for (let i = 0; i < total; i++) {
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

const DIAS_DA_SEMANA = ['no domingo', 'na segunda', 'na terça', 'na quarta', 'na quinta', 'na sexta', 'no sábado'];

/**
 * O prazo em texto — com a HORA do relógio quando ele passa da meia-noite.
 *
 * A VTEX já respeita o horário da loja e do entregador. Medido ao vivo em 24/09 às 20:41:
 * a loja de Teresina que fecha às 21h passou de "60m" pra "12h" (data: amanhã 08:00), as
 * lojas de Fortaleza já fechadas deram "11h"/"12h" (a abertura + 1h) e a EXPRESSA da
 * Drogaria São Paulo virou "18h" (amanhã 14:00). O número está certo, mas à noite ele não
 * diz nada: "retire em 12 horas" é "amanhã a partir das 8h". Por isso, quando a rede manda
 * a data e ela cai noutro dia, o texto usa a data.
 *
 * Só para prazo em minutos/horas acima de 4h: "2bd" com data 00:01 é dia útil, não hora
 * marcada; e "60 min" às 23h58 continua "60 min" (é verdade e é o que importa). Data no
 * passado, malformada ou a mais de 7 dias → o texto de sempre.
 */
export function textoDoPrazo(estimate: string, estimateDate: string | null | undefined, retirada: boolean, agora: Date = new Date()): string {
  const base = formatShippingEstimate(estimate);
  if (!estimateDate || !/^\d+\s*(m|min|h)$/i.test((estimate ?? '').trim())) return base;
  if (estimateToMinutes(estimate) <= 240) return base;
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.exec(estimateDate.trim());
  if (!m) return base;
  const [, dia, hh, mm, tz] = m as unknown as [string, string, string, string, string];
  const quando = Date.parse(estimateDate);
  if (!Number.isFinite(quando) || quando <= agora.getTime() || quando - agora.getTime() > 7 * 24 * 60 * 60 * 1000) return base;
  // "Hoje" no fuso da PRÓPRIA data (o da loja) — o servidor roda em UTC.
  const offsetMin = tz === 'Z' ? 0 : (tz.startsWith('-') ? -1 : 1) * (Number(tz.slice(1, 3)) * 60 + Number(tz.slice(4, 6)));
  const diaLocal = (deslocDias: number) => new Date(agora.getTime() + offsetMin * 60_000 + deslocDias * 86_400_000).toISOString().slice(0, 10);
  if (dia === diaLocal(0)) return base;
  const hora = mm === '00' ? `${Number(hh)}h` : `${Number(hh)}h${mm}`;
  const limite = retirada ? `a partir das ${hora}` : `até as ${hora}`;
  if (dia === diaLocal(1)) return `amanhã ${limite}`;
  const semana = DIAS_DA_SEMANA[new Date(`${dia}T12:00:00Z`).getUTCDay()]!;
  return `${semana} (${dia.slice(8, 10)}/${dia.slice(5, 7)}) ${limite}`;
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
  const data = await withRetry(async () => (await http.get<unknown[]>(url, cfg)).data, opts.retries ?? 2);
  if (!Array.isArray(data)) return [];
  const out: PlatformProduct[] = [];
  for (const raw of data) {
    const mapped = mapVtexProduct(net, raw);
    if (mapped) out.push(mapped);
  }
  return out;
}

// ───────────────────────── SIMULAÇÃO POR CEP ─────────────────────────

/** Converte shippingEstimate num nº de minutos comparável (pra achar a opção mais rápida). */
export function estimateToMinutes(est: string): number {
  const m = /^(\d+)\s*(m|h|d|bd|min)$/i.exec((est ?? '').trim());
  if (!m) return Number.MAX_SAFE_INTEGER;
  const n = Number(m[1]);
  const u = m[2]!.toLowerCase();
  if (u === 'm' || u === 'min') return n;
  if (u === 'h') return n * 60;
  // "0bd"/"0d" = "no mesmo dia útil" — NÃO é "agora". Contado como 0 minutos, ele virava
  // "⚡ chega agora" e ganhava de uma entrega real de 60 min. Oito horas é a leitura honesta
  // de "ainda hoje, sem hora marcada".
  if (n === 0) return MESMO_DIA_MIN;
  return n * 24 * 60; // 'd' e 'bd' contam como dias (útil ~ dia pro ranking)
}


/** Uma opção de logística que vale para a CESTA INTEIRA (ver `agregarSlasDaCesta`). */
interface SlaDaCesta {
  id: string;
  name: string;
  pickup: boolean;
  /** o prazo do item MAIS LENTO — a cesta só chega quando o último item chega */
  etaMinutes: number;
  estimate: string;
  /** `shippingEstimateDate` do item mais lento (ISO com fuso da loja) — ver `textoDoPrazo` */
  estimateDate: string | null;
  /** frete da cesta = soma da fração de cada item (o VTEX rateia o frete por item) */
  feeCents: number;
  store: PickupStore | null;
  distanceKm: number | null;
}

function slaRealista(s: Record<string, unknown>): boolean {
  const feeCents = typeof s['price'] === 'number' ? (s['price'] as number) : 0;
  return feeCents <= MAX_REALISTIC_FEE_CENTS && estimateToMinutes(String(s['shippingEstimate'] ?? '')) <= MAX_REALISTIC_ETA_MIN;
}

/**
 * A loja como o CHECKOUT a lista: nome da filial, rua com número, bairro e distância.
 *
 * A primeira versão guardava só rua + bairro e trocava o nome pela rua: duas filiais
 * Pacheco na Av. T-63 (Setor Bueno e Setor Bueno 9) viravam o MESMO texto, e a retirada é
 * reservada numa loja específica. O nome da filial é o que a pessoa vai escolher no site.
 */
function lojaDoSla(s: Record<string, unknown>): PickupStore | null {
  const info = (s['pickupStoreInfo'] ?? null) as Record<string, unknown> | null;
  if (!info) return null;
  const limpar = (v: unknown) =>
    typeof v === 'string' ? v.replace(/\s+/g, ' ').replace(/\s+,/g, ',').replace(/[\s.\-–]+$/, '').trim() : '';
  const name = limpar(info['friendlyName']) || limpar(s['name']);
  if (!name) return null;
  const a = (info['address'] ?? null) as Record<string, unknown> | null;
  const rua = a ? limpar(a['street']) : '';
  const numeroCru = a ? limpar(a['number']) : '';
  const numero = numeroCru && !/^s\/?n$/i.test(numeroCru) && numeroCru !== '0' ? numeroCru : '';
  const bairro = a ? limpar(a['neighborhood']) : '';
  const partes = [rua && numero ? `${rua}, ${numero}` : rua, bairro].filter(Boolean);
  // Precisão de 10 m: arredondar pra 0,1 km fazia 352 m virar "400 m" na mensagem.
  const dist = typeof s['pickupDistance'] === 'number' && Number.isFinite(s['pickupDistance'] as number)
    ? Math.round((s['pickupDistance'] as number) * 100) / 100
    : null;
  return { name, address: partes.length ? partes.join(', ') : null, distanceKm: dist };
}

/**
 * As opções de logística que valem para TODOS os itens da cesta.
 *
 * ⚠️ A versão anterior lia só `logisticsInfo[0]` — o PRIMEIRO item. Numa receita com
 * dipirona (entrega em 90 min) e amoxicilina (antibiótico: a rede só entrega em 1 dia útil,
 * porque o entregador precisa recolher a receita), a Xarlote prometia 90 min para a cesta
 * inteira. Medido ao vivo em 24/09 na Pague Menos, CEP do Setor Central.
 *
 * Uma opção só vale para a cesta se TODO item a oferece (mesmo `id` de SLA); o prazo é o
 * do item mais lento e o frete é a soma das frações. Loja de retirada idem: se um item não
 * está naquela loja, a pessoa não retira a cesta ali.
 */
export function agregarSlasDaCesta(li: Record<string, unknown>[]): SlaDaCesta[] {
  // ⚠️ Item sem NENHUMA opção no CEP (indisponível, "cannotBeDelivered") não participa da
  // interseção: ele sai da cesta de qualquer jeito (vira "não achei aqui"), e contá-lo
  // zerava a logística dos outros — a Drogaria São Paulo aparecia "sem entrega" com a
  // losartana saindo em 3h, só porque o omeprazol da mesma receita não tinha estoque
  // (revisão de 24/09: 3 de 8 receitas reais). Quem chama ainda re-simula a cesta final.
  const entregaveis = li.filter((e) =>
    (Array.isArray(e['slas']) ? (e['slas'] as Record<string, unknown>[]) : []).some(slaRealista));
  if (!entregaveis.length) return [];
  const porId = new Map<string, SlaDaCesta & { itens: number }>();
  for (const entrada of entregaveis) {
    const slas = Array.isArray(entrada['slas']) ? (entrada['slas'] as Record<string, unknown>[]) : [];
    const vistos = new Set<string>();
    for (const s of slas) {
      if (!slaRealista(s)) continue;
      // O VTEX sempre manda `id`; o nome e a combinação canal+prazo são só rede de
      // segurança pra payload incompleto — sem eles, a opção sumiria em silêncio.
      const id = String(s['id'] ?? s['name'] ?? `${String(s['deliveryChannel'] ?? '')}:${String(s['shippingEstimate'] ?? '')}`);
      if (vistos.has(id)) continue;
      vistos.add(id);
      const estimate = String(s['shippingEstimate'] ?? '');
      const eta = estimateToMinutes(estimate);
      const fee = typeof s['price'] === 'number' ? (s['price'] as number) : 0;
      const data = typeof s['shippingEstimateDate'] === 'string' ? (s['shippingEstimateDate'] as string) : null;
      const atual = porId.get(id);
      if (!atual) {
        const pickup = s['deliveryChannel'] === 'pickup-in-point';
        const store = pickup ? lojaDoSla(s) : null;
        porId.set(id, {
          id, name: String(s['name'] ?? id), pickup,
          etaMinutes: eta, estimate, estimateDate: data, feeCents: fee, store,
          distanceKm: store?.distanceKm ?? null, itens: 1,
        });
      } else {
        atual.itens += 1;
        atual.feeCents += fee;
        if (eta > atual.etaMinutes) { atual.etaMinutes = eta; atual.estimate = estimate; atual.estimateDate = data; }
        else if (eta === atual.etaMinutes && data && (!atual.estimateDate || Date.parse(data) > Date.parse(atual.estimateDate))) {
          atual.estimateDate = data;
        }
      }
    }
  }
  return [...porId.values()].filter((x) => x.itens === entregaveis.length);
}

function comoOpcao(x: SlaDaCesta): FulfillmentOption {
  return {
    etaText: textoDoPrazo(x.estimate, x.estimateDate, x.pickup),
    feeReais: centavosToReais(x.feeCents),
    etaMinutes: x.etaMinutes,
    slaName: x.name,
    ...(x.pickup ? { store: x.store } : {}),
  };
}

/**
 * Melhor ENTREGA (mais rápida; desempate pelo menor frete) e melhor RETIRADA (mais rápida;
 * desempate pela loja mais PERTO — frete é zero em todas) entre as opções que valem pra
 * cesta inteira. Descarta SLA-sentinela (frete gigante + prazo enorme, ex.: São João
 * "30 dias / R$1000" = "não entrego de verdade aqui").
 */
function bestSlasFromLogistics(li: Record<string, unknown>[]): { delivery: FulfillmentOption | null; pickup: FulfillmentOption | null } {
  const validas = agregarSlasDaCesta(li);
  const entrega = validas
    .filter((x) => !x.pickup)
    .sort((a, b) => a.etaMinutes - b.etaMinutes || a.feeCents - b.feeCents)[0];
  const retirada = validas
    .filter((x) => x.pickup)
    .sort((a, b) =>
      a.etaMinutes - b.etaMinutes
      || (a.distanceKm ?? Number.MAX_SAFE_INTEGER) - (b.distanceKm ?? Number.MAX_SAFE_INTEGER)
      || a.feeCents - b.feeCents)[0];
  return {
    delivery: entrega ? comoOpcao(entrega) : null,
    pickup: retirada ? comoOpcao(retirada) : null,
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
  const data = await withRetry(async () => (await http.post<unknown>(url, body, cfg)).data, opts.retries ?? 2);
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
  /**
   * Por sku: preço UNITÁRIO no CEP (reais), disponibilidade e se existe ALGUMA forma de
   * receber/retirar aqui. `available` sozinho engana: o item pode constar como disponível
   * no catálogo e não ter nenhuma entrega nem loja pro CEP.
   */
  perSku: Record<string, { price: number; available: boolean; temLogistica?: boolean }>;
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
  const perSku: Record<string, { price: number; available: boolean; temLogistica?: boolean }> = {};
  let total = 0;
  let allAvailable = true;
  const li = Array.isArray(d['logisticsInfo']) ? (d['logisticsInfo'] as Record<string, unknown>[]) : [];
  items.forEach((it, idx) => {
    const id = String(it['id'] ?? '');
    const price = centavosToReais(typeof it['price'] === 'number' ? (it['price'] as number) : 0);
    const qty = typeof it['quantity'] === 'number' ? (it['quantity'] as number) : 1;
    const available = String(it['availability'] ?? '') === 'available';
    // A logística do item vem pelo `itemIndex`; sem ele, pela posição.
    const entrada = li.find((e) => e['itemIndex'] === idx) ?? li[idx];
    const temLogistica = entrada
      ? (Array.isArray(entrada['slas']) ? (entrada['slas'] as Record<string, unknown>[]) : []).some(slaRealista)
      : undefined;
    if (id) perSku[id] = { price, available, ...(temLogistica !== undefined ? { temLogistica } : {}) };
    if (available) total += price * qty;
    else allAvailable = false;
  });
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
  const data = await withRetry(async () => (await http.post<unknown>(url, body, cfg)).data, opts.retries ?? 2);
  return parseVtexBasketSimulation(data);
}
