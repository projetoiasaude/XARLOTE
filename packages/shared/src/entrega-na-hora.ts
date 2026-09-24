/**
 * O TEXTO da cotação nas grandes redes — puro, testável, e com uma regra só: dizer quando
 * a pessoa tem o remédio na mão, e ONDE, sem arredondar a verdade.
 *
 * Nasceu da medição ao vivo de 24/09 (CEP do Setor Central de Goiânia): a Drogaria São
 * Paulo e a Pague Menos entregam em 60–90 min e têm retirada em 30–60 min em lojas a
 * 0,4–5 km — com a loja e a distância na própria resposta da rede, que o parser jogava
 * fora. "Retire em 30 min" sem dizer onde não é uma promessa que a pessoa consiga cumprir.
 */
import { faixaDePrazo, type CotacaoOrdenavel } from './cotacao-rede.js';

export interface LojaApresentavel {
  name: string;
  address: string | null;
  distanceKm: number | null;
  /**
   * A fachada é de OUTRA rede do mesmo grupo econômico (a Extrafarma retira em lojas Pague
   * Menos; a Drogaria São Paulo, em lojas Pacheco). Vem do REGISTRO das redes, nunca de chute.
   */
  marcaDoGrupo?: string | null;
}

export interface OpcaoApresentavel {
  etaText: string;
  feeReais: number;
  etaMinutes: number;
  /** Nome da opção na rede ("SUPER EXPRESSA") — é o que a pessoa procura no checkout. */
  slaName?: string;
  store?: LojaApresentavel | null;
}

export interface CotacaoApresentavel extends CotacaoOrdenavel {
  networkLabel: string;
  delivery: OpcaoApresentavel | null;
  pickup: OpcaoApresentavel | null;
  /** A simulação do CEP rodou? Sem ela, não sabemos o prazo — e não podemos dizer "sem entrega". */
  pricedByCep?: boolean;
  /** Simulou a cesta e não há opção comum a todos os itens (cada um chega de um jeito). */
  semOpcaoComum?: boolean;
}

/**
 * Prazo desconhecido: a simulação não rodou (429/timeout), a rede não simula por CEP
 * (Nissei/Ultrafarma), ou os itens não têm opção comum. Em nenhum desses casos é verdade
 * dizer "sem entrega pro seu CEP" — a verdade é "confira no site".
 */
export function prazoDesconhecido(q: CotacaoApresentavel): boolean {
  return !q.delivery && !q.pickup;
}

/** Até onde dá pra chamar de "pertinho" sem exagerar. */
export const KM_PERTINHO = 5;

function reais(n: number): string {
  return `R$ ${n.toFixed(2).replace('.', ',')}`;
}

function fold(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

/** 0,35 → "350 m"; 0,97 → "970 m"; 1,6 → "1,6 km"; 12,3 → "12 km". Mínimo de 50 m. */
export function formatarDistancia(km: number): string {
  if (km < 1) return `${Math.max(50, Math.round(km * 100) * 10)} m`;
  if (km < 10) return `${km.toFixed(1).replace('.', ',')} km`;
  return `${Math.round(km)} km`;
}

/** Palavras de logradouro que não distinguem uma rua da outra. */
const TIPOS_DE_RUA = new Set(['avenida', 'av', 'rua', 'r', 'alameda', 'al', 'travessa', 'tv', 'praca', 'rodovia', 'estrada', 'quadra', 'qd']);

/** O miolo da rua ("Avenida Goiás" → "goias"), pra saber se o nome da loja já a contém. */
function nucleoDaRua(rua: string): string {
  return fold(rua).split(/[^a-z0-9]+/).filter((p) => p && !TIPOS_DE_RUA.has(p)).join(' ');
}

/**
 * ONDE retirar, do jeito que o checkout vai listar a loja:
 * " na *Pague Menos - Av. Goiás, 415 (Loja 304)* (350 m)" ou
 * " na *Drogarias Pacheco - Filial Setor Bueno 9* — Avenida T-63, 1830, Setor Bueno (4,8 km)".
 *
 * O nome da FILIAL vem sempre: é o que a pessoa escolhe no site e o que ela vê na fachada
 * (a Drogaria São Paulo de Goiânia retira em lojas Pacheco). A primeira versão trocava o
 * nome pela rua, e duas filiais na mesma avenida viravam o mesmo texto — com a retirada
 * reservada numa loja específica. O endereço entra quando o nome não o repete.
 */
export function ondeRetirar(loja: LojaApresentavel | null | undefined): string {
  if (!loja) return '';
  // Comprar no site da Extrafarma e retirar numa fachada Pague Menos é verdade (mesmo grupo)
  // — mas sem essa frase a pessoa acha que a Xarlote errou a loja (prova ao vivo de 24/09).
  const grupo = loja.marcaDoGrupo ? ' — loja do mesmo grupo' : '';
  const dist = loja.distanceKm !== null ? formatarDistancia(loja.distanceKm) : null;
  const ruaNoNome = loja.address
    ? (() => {
        const rua = nucleoDaRua(loja.address.split(',')[0] ?? '');
        // Rua curta ou só número ("Rua 10", "T-63") casaria por acaso dentro de "Loja 104":
        // aí o endereço sempre vai junto — sobrar informação é melhor que faltar.
        const distintiva = rua.replace(/\s/g, '').length >= 4 && !/^[\d\s]+$/.test(rua);
        return distintiva && fold(loja.name).includes(rua);
      })()
    : false;
  if (loja.address && !ruaNoNome) {
    return ` na *${loja.name}* — ${loja.address}${dist ? ` (${dist})` : ''}${grupo}`;
  }
  return ` na *${loja.name}*${dist ? ` (${dist})` : ''}${grupo}`;
}

/** "60 min" → "em 60 min"; "no mesmo dia útil" e "hoje" já trazem a preposição. */
function quando(etaText: string): string {
  return /^(no |hoje)/.test(etaText) ? etaText : `em ${etaText}`;
}

/**
 * A MANCHETE de prazo: o jeito mais rápido de ter o remédio. Entrega rápida vem na frente
 * (não exige sair de casa); retirada rápida vence entrega lenta.
 */
export function seloDePrazo(q: CotacaoApresentavel): string {
  switch (faixaDePrazo(q)) {
    case 'agora':
      return `⚡ chega ${quando(q.delivery!.etaText)}`;
    case 'retirar-agora':
      return `⚡ retire ${quando(q.pickup!.etaText)}`;
    case 'hoje':
    case 'dias':
      return `chega ${quando(q.delivery!.etaText)}`;
    case 'so-retirada':
      return `retire ${quando(q.pickup!.etaText)}`;
    case 'nenhuma':
      // Sem nenhuma opção conhecida. NÃO é "sem entrega pro seu CEP": na maioria das vezes
      // é simulação que não rodou (429/timeout) ou rede que não simula por CEP.
      return 'confira o prazo no site';
  }
}

/**
 * A linha de logística completa, com a opção MAIS RÁPIDA primeiro:
 * "entrega em 90 min (R$ 7,90) · ou retire em 30 min na *Drogarias Pacheco - Filial …* (1,6 km)".
 */
export function linhaDeLogistica(q: CotacaoApresentavel): string {
  const entrega = q.delivery
    ? `entrega ${quando(q.delivery.etaText)}${q.delivery.feeReais > 0 ? ` (${reais(q.delivery.feeReais)})` : ' grátis'}`
    : null;
  const retirada = q.pickup ? `retire ${quando(q.pickup.etaText)}${ondeRetirar(q.pickup.store)}` : null;
  const f = faixaDePrazo(q);
  const retiradaPrimeiro = f === 'retirar-agora' || f === 'so-retirada';
  const ordem = retiradaPrimeiro ? [retirada, entrega] : [entrega, retirada];
  const partes = ordem.filter((x): x is string => !!x);
  return partes.map((p, i) => (i === 0 ? p : `ou ${p}`)).join(' · ');
}

/**
 * Posso dizer "pertinho"? Só com prova: entrega em até 4h (a loja é local por definição)
 * ou uma retirada a até `KM_PERTINHO`. Antes a palavra saía até quando a opção mais rápida
 * vinha de outro estado em 11 dias úteis.
 */
export function podeDizerPertinho(qs: readonly CotacaoApresentavel[]): boolean {
  return qs.some((q) => {
    const f = faixaDePrazo(q);
    if (f === 'agora') return true;
    const d = q.pickup?.store?.distanceKm;
    return (f === 'retirar-agora' || f === 'so-retirada') && d !== null && d !== undefined && d <= KM_PERTINHO;
  });
}

/**
 * O que escolher no site. O link do carrinho NÃO consegue pré-selecionar a entrega nem a
 * loja (a simulação devolve `selectedSla: null`): o checkout abre no padrão da rede — na
 * Drogaria São Paulo, "NORMAL · 2 dias úteis" — e a pessoa acharia que a Xarlote prometeu
 * 3 horas à toa. Dizer o nome da opção fecha a distância entre a promessa e o botão.
 */
export function instrucaoDoCheckout(q: CotacaoApresentavel): string | null {
  const f = faixaDePrazo(q);
  if ((f === 'agora' || f === 'hoje' || f === 'dias') && q.delivery?.slaName) {
    return `👉 no site, escolha a entrega *${q.delivery.slaName}*`;
  }
  if ((f === 'retirar-agora' || f === 'so-retirada') && q.pickup) {
    const loja = q.pickup.store?.name;
    // A receita: quem retira antibiótico ou controlado precisa levar — e a mensagem não
    // sabe quais itens exigem. Um lembrete curto é sempre verdade e evita a viagem perdida.
    return `👉 no site, escolha *retirar na loja*${loja ? ` (${loja})` : ''} — se o remédio pede receita, leve ela`;
  }
  return null;
}
