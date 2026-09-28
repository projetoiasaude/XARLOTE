/**
 * Adaptador da FARMÁCIA MODELO (Goiânia, Av. República do Líbano, 1620, St. Oeste) — plataforma
 * PRÓPRIA (Vannon, ASP.NET), aberta server-side, sem antirrobô. Pesquisa de 28/09/2026 (o
 * fundador: "o máximo de busca que conseguirmos, pra já trazer o link com o CEP e a entrega na
 * hora"): é a única fonte achada com entrega em ~1h DENTRO do Setor Oeste — e é a mesma farmácia
 * cujo número recebia o nosso template de WhatsApp e nunca respondia.
 *
 *   busca : GET {host}/busca/{termo} → HTML com cartões: link "/{slug}/{id}-01", nome completo no
 *           `alt` da imagem (o <h2> vem truncado com "..."), "Por: R$ 9,99", EAN no nome da imagem.
 *   prazo : GET {host}/produtos/modalidades-entrega/{id}/{00000-000}/{qtd}
 *           → {"sucesso":true,"view":"<table>…"}, uma linha por modalidade:
 *             "Click & Retire | Frete Grátis | Dia da Postagem + 1 hora(s) | 2ª feira a Sábado:7h às 22h…"
 *             "Entrega (Goiânia) | R$ 5,00 | Dia da Postagem + 1 hora(s)"
 *           → {"sucesso":false,"mensagem":"…não possui estoque suficiente…na sua região."}
 *             = sem estoque pra esse CEP (é a checagem de estoque de verdade).
 *
 * O "+1 hora" é TEXTO FIXO contado da confirmação do pagamento: o horário da loja é aplicado aqui
 * (pedido às 21h30 fica pronto amanhã). Feriado a loja não informa — conta como dia comum. Não há
 * link de carrinho (o carrinho é da sessão): o link é a página do produto.
 */
import axios from 'axios';
import type { PlatformNetwork } from './registry.js';
import type { PlatformProduct, FulfillmentOption, PickupStore } from './types.js';
import { rankProductMatches, medNameForSearch } from './matching.js';
import { textoDoPrazo } from './vtex.js';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const DEFAULT_TIMEOUT_MS = 9000;

/** A loja de retirada (rodapé do site: Tanemil Farma LTDA, "Av. República do Líbano, 1620, St. Oeste"). */
export const LOJA_MODELO: PickupStore = {
  name: 'Farmácia Modelo',
  address: 'Av. República do Líbano, 1620, Setor Oeste',
  distanceKm: null,
  rua: 'Av. República do Líbano',
  numero: '1620',
  bairro: 'Setor Oeste',
};

function desescapar(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

function texto(html: string): string {
  return desescapar(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** "R$ 1.234,56" → 1234.56 */
function reais(s: string | null | undefined): number | null {
  const m = /R\$\s*([\d.]+,\d{2}|\d+(?:[.,]\d{2})?)/.exec(s ?? '');
  if (!m) return null;
  const n = Number(m[1]!.includes(',') ? m[1]!.replace(/\./g, '').replace(',', '.') : m[1]);
  return Number.isFinite(n) ? n : null;
}

/** Os cartões de produto da página de busca. */
export function parseModeloBusca(html: string, net: Pick<PlatformNetwork, 'id' | 'label' | 'group' | 'host'>): PlatformProduct[] {
  const out: PlatformProduct[] = [];
  const vistos = new Set<string>();
  for (const cartao of (html ?? '').split('class="item-box').slice(1)) {
    const link = /href="(\/[a-z0-9-]+\/(\d+)-01)"/i.exec(cartao);
    if (!link) continue;
    const id = link[2]!;
    if (vistos.has(id)) continue;
    const img = /<img[^>]*src="[^"]*\/([^"/]+)\.(?:jpg|jpeg|png|webp)"[^>]*alt="([^"]*)"/i.exec(cartao);
    const h2 = /<h2>([\s\S]*?)<\/h2>/i.exec(cartao);
    const nome = desescapar(img?.[2] ?? '') || texto(h2?.[1] ?? '');
    const precoPor = /class="preco-por"[\s\S]*?<\/p>/i.exec(cartao)?.[0] ?? '';
    const precoDe = /class="preco-de"[\s\S]*?<\/p>/i.exec(cartao)?.[0] ?? '';
    const preco = reais(precoPor);
    if (!nome || preco == null || preco <= 0) continue;
    const compravel = new RegExp(`data-compra="${id}"`).test(cartao);
    const ean = img && /^\d{8,14}$/.test(img[1]!) ? img[1]! : null;
    vistos.add(id);
    out.push({
      network: net.id,
      networkLabel: net.label,
      group: net.group,
      productName: nome.replace(/\.\.\.$/, '').trim(),
      sku: id,
      sellerId: '1',
      ean,
      price: preco,
      listPrice: reais(precoDe),
      availableQuantity: compravel ? 1 : 0,
      productUrl: `${net.host}${link[1]}`,
      activeIngredient: null,
    });
  }
  return out;
}

export interface ModalidadeModelo {
  nome: string;
  taxa: number;
  /** o texto do site ("Dia da Postagem + 1 hora(s)") */
  prazoTexto: string;
  /** o prazo DENTRO do horário da loja, em minutos (sem aplicar o horário) */
  prazoMin: number;
  descricao: string;
  retirada: boolean;
}

export type ModalidadesModelo =
  | { semEstoque: true; mensagem: string }
  | { semEstoque: false; opcoes: ModalidadeModelo[] };

/** "Dia da Postagem + 1 hora(s)" → 60; "+ 2 dia(s)" → 2 dias; sem número → null. */
export function prazoEmMinutos(txt: string): number | null {
  const t = (txt ?? '').toLowerCase();
  const h = /(\d+)\s*hora/.exec(t);
  if (h) return Number(h[1]) * 60;
  const m = /(\d+)\s*min/.exec(t);
  if (m) return Number(m[1]);
  const d = /(\d+)\s*dia/.exec(t);
  if (d) return Number(d[1]) * 24 * 60;
  return null;
}

/** A resposta de `/produtos/modalidades-entrega/...`. */
export function parseModeloModalidades(json: unknown): ModalidadesModelo | null {
  const j = json as { sucesso?: unknown; view?: unknown; mensagem?: unknown } | null;
  if (!j || typeof j !== 'object') return null;
  if (j.sucesso === false) {
    const msg = typeof j.mensagem === 'string' ? j.mensagem : '';
    return /estoque/i.test(msg) ? { semEstoque: true, mensagem: msg } : null;
  }
  if (j.sucesso !== true || typeof j.view !== 'string') return null;
  const corpo = /<tbody[^>]*id="info-modalidade"[^>]*>([\s\S]*?)<\/tbody>/i.exec(j.view)?.[1] ?? '';
  const opcoes: ModalidadeModelo[] = [];
  for (const tr of corpo.split(/<tr[^>]*>/i).slice(1)) {
    const tds = [...tr.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => texto(m[1]!));
    if (tds.length < 3) continue;
    const [nome, taxaTxt, prazoTexto, descricao = ''] = tds as [string, string, string, string?];
    const prazoMin = prazoEmMinutos(prazoTexto);
    // Frete que não dá pra ler ("A calcular") NÃO vira grátis: a modalidade sai da oferta.
    const taxa = /gr[aá]tis/i.test(taxaTxt) ? 0 : reais(taxaTxt);
    if (!nome || prazoMin == null || taxa == null) continue;
    opcoes.push({
      nome,
      taxa,
      prazoTexto,
      prazoMin,
      descricao,
      retirada: /retir/i.test(nome),
    });
  }
  return { semEstoque: false, opcoes };
}

export interface HorarioDaLoja {
  /** [abre, fecha] em horas cheias, segunda a sábado */
  semana: [number, number];
  /** [abre, fecha] aos domingos (e feriados — que a loja não informa por dia) */
  domingo: [number, number];
}

const HORARIO_PADRAO: HorarioDaLoja = { semana: [7, 22], domingo: [8, 22] };

/** "2ª feira a Sábado:7h às 22h -------- Domingos e Feriados: 8h às 22h" → horários; senão o padrão. */
export function horarioDaLoja(descricao: string | null | undefined): HorarioDaLoja {
  const faixas = [...(descricao ?? '').matchAll(/(\d{1,2})h\s*(?:às|as|a)\s*(\d{1,2})h/gi)].map((m) => [Number(m[1]), Number(m[2])] as [number, number]);
  if (!faixas.length) return HORARIO_PADRAO;
  return { semana: faixas[0]!, domingo: faixas[1] ?? faixas[0]! };
}

const BRT_MS = 3 * 60 * 60 * 1000;

/**
 * Quando fica pronto, respeitando o horário da loja. "Agora" fora do horário começa na próxima
 * abertura; se o prazo passa do fechamento, vai pro dia seguinte (abertura + prazo). Devolve o
 * instante (UTC) e o texto já no formato das outras redes ("60 min", "amanhã a partir das 8h").
 */
export function prontoNaLoja(
  prazoMin: number,
  horario: HorarioDaLoja,
  retirada: boolean,
  agora: Date = new Date(),
): { etaMinutes: number; etaText: string } | null {
  // Prazo em DIAS (ou maior que o expediente) não cabe numa janela da loja: sem promessa — a
  // mensagem cai pra "confira o prazo no site" em vez de inventar a data (revisão de 28/09).
  const maiorJanela = Math.max(horario.semana[1] - horario.semana[0], horario.domingo[1] - horario.domingo[0]) * 60;
  if (prazoMin > maiorJanela) return null;
  // Relógio de parede de Goiânia (UTC-3, sem horário de verão) representado em UTC.
  let t = new Date(agora.getTime() - BRT_MS);
  for (let dias = 0; dias < 8; dias++) {
    const [abre, fecha] = t.getUTCDay() === 0 ? horario.domingo : horario.semana;
    const abertura = Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate(), abre);
    const fechamento = Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate(), fecha);
    const inicio = Math.max(t.getTime(), abertura);
    if (inicio + prazoMin * 60_000 <= fechamento) {
      const prontoUtc = inicio + prazoMin * 60_000 + BRT_MS;
      const etaMinutes = Math.max(1, Math.round((prontoUtc - agora.getTime()) / 60_000));
      // Pra cima: "3 horas" pra algo pronto em 3h25 fazia a pessoa chegar antes (revisão de 28/09).
      const estimate = etaMinutes < 120 ? `${etaMinutes}m` : `${Math.ceil(etaMinutes / 60)}h`;
      const iso = new Date(prontoUtc - BRT_MS).toISOString().replace('Z', '-03:00').replace(/\.\d{3}/, '');
      return { etaMinutes, etaText: textoDoPrazo(estimate, iso, retirada, agora) };
    }
    t = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate() + 1));
  }
  return null;
}

function cepComHifen(cep8: string): string {
  const d = cep8.replace(/\D/g, '');
  return `${d.slice(0, 5)}-${d.slice(5, 8)}`;
}

const BUSCA_CACHE = new Map<string, { at: number; produtos: PlatformProduct[] }>();
const BUSCA_TTL_MS = 30 * 60 * 1000;

async function buscarModelo(net: PlatformNetwork, termo: string, timeout: number): Promise<PlatformProduct[]> {
  const key = `${net.id}::${termo.toLowerCase()}`;
  const c = BUSCA_CACHE.get(key);
  if (c && Date.now() - c.at < BUSCA_TTL_MS) return c.produtos;
  const { data } = await axios.get<string>(`${net.host}/busca/${encodeURIComponent(termo)}`, {
    timeout, responseType: 'text', headers: { 'User-Agent': UA, Accept: 'text/html', 'Accept-Language': 'pt-BR' },
  });
  const produtos = parseModeloBusca(String(data ?? ''), net);
  BUSCA_CACHE.set(key, { at: Date.now(), produtos });
  return produtos;
}

/**
 * Cota UM remédio na Farmácia Modelo: busca pelo NOME → ranqueia (a dose entra no ranqueador) →
 * o melhor comprável. O estoque por região vem depois, na simulação por CEP.
 */
export async function quoteModeloProduct(
  net: PlatformNetwork,
  query: string,
  opts: { timeoutMs?: number; minScore?: number } = {},
): Promise<PlatformProduct | null> {
  const produtos = await buscarModelo(net, medNameForSearch(query), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const ranked = rankProductMatches(query, produtos, { minScore: opts.minScore }).filter((m) => m.product.availableQuantity > 0);
  return ranked[0]?.product ?? null;
}

export interface SimulacaoModelo {
  delivery: FulfillmentOption | null;
  pickup: FulfillmentOption | null;
  /** SKUs sem estoque pra esse CEP ("não possui estoque suficiente…na sua região") */
  indisponiveis: string[];
}

/**
 * Prazo e frete REAIS pro CEP, por item (a loja é uma só: a cesta sai junto — frete é UM, o maior;
 * prazo é o do item mais lento). Item sem estoque na região sai da cesta. null = nenhuma resposta.
 */
export async function simulateModeloBasket(
  net: PlatformNetwork,
  itens: Array<{ sku: string; qty: number }>,
  cep8: string,
  opts: { timeoutMs?: number; agora?: Date } = {},
): Promise<SimulacaoModelo | null> {
  const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const respostas = await Promise.all(itens.map(async (it) => {
    try {
      const { data } = await axios.get<unknown>(
        `${net.host}/produtos/modalidades-entrega/${encodeURIComponent(it.sku)}/${cepComHifen(cep8)}/${Math.max(1, it.qty)}`,
        { timeout, headers: { 'User-Agent': UA, Accept: 'application/json', 'Accept-Language': 'pt-BR', 'X-Requested-With': 'XMLHttpRequest' } },
      );
      return { sku: it.sku, r: parseModeloModalidades(typeof data === 'string' ? JSON.parse(data) : data) };
    } catch {
      return { sku: it.sku, r: null };
    }
  }));
  return combinarSimulacaoModelo(respostas, opts.agora);
}

/**
 * PURA: junta as modalidades de cada item numa oferta da cesta. A loja é uma só, então o frete é
 * UM (o maior) e o prazo é o do item mais lento; uma modalidade só vale se valer pra todos os itens
 * com estoque. Item "sem estoque na região" sai. Nenhuma resposta válida → null.
 */
export function combinarSimulacaoModelo(
  respostas: Array<{ sku: string; r: ModalidadesModelo | null }>,
  agora: Date = new Date(),
): SimulacaoModelo | null {
  // Um item SEM resposta (timeout, erro) não teve o estoque da região conferido: prometer "60 min"
  // pra cesta com ele dentro seria prometer o que ninguém checou. A cesta inteira fica sem promessa
  // ("confira o prazo no site") — revisão de 28/09.
  if (!respostas.length || respostas.some((x) => !x.r)) return null;
  const indisponiveis = respostas.filter((x) => x.r?.semEstoque).map((x) => x.sku);
  const comOpcoes = respostas.map((x) => x.r).filter((r): r is Extract<ModalidadesModelo, { semEstoque: false }> => !!r && !r.semEstoque);
  // O horário é da LOJA (vale pra retirada e pra entrega); o site o escreve na linha do Click & Retire.
  const horario = horarioDaLoja(comOpcoes.flatMap((r) => r.opcoes.map((o) => o.descricao)).find((d) => /\d{1,2}h/.test(d ?? '')) ?? null);
  const escolher = (retirada: boolean): FulfillmentOption | null => {
    const porItem = comOpcoes.map((r) => r.opcoes.find((o) => o.retirada === retirada) ?? null);
    if (!porItem.length || porItem.some((o) => !o)) return null;       // a opção precisa valer pra cesta toda
    const lenta = porItem.reduce((a, b) => (b!.prazoMin > a!.prazoMin ? b : a))!;
    const taxa = Math.max(...porItem.map((o) => o!.taxa));
    const pronto = prontoNaLoja(lenta.prazoMin, horario, retirada, agora);
    if (!pronto) return null;
    return {
      etaText: pronto.etaText, etaMinutes: pronto.etaMinutes, feeReais: taxa, slaName: lenta.nome,
      ...(retirada ? { store: LOJA_MODELO } : {}),
    };
  };
  return { delivery: escolher(false), pickup: escolher(true), indisponiveis };
}

/** Limpa o cache (teste/manutenção). */
export function _clearModeloCache(): void {
  BUSCA_CACHE.clear();
}
