/**
 * Como ordenar as cotações das grandes redes — e quais redes NÃO devem receber WhatsApp.
 *
 * Duas decisões que estavam erradas em produção até 01/09/2026, medidas ao vivo:
 *
 * 1. A ordem era por PREÇO DO REMÉDIO. Numa cotação real de omeprazol em Goiânia, a
 *    Catarinense aparecia em 1º com R$ 12,56 — e cobrava R$ 28,42 de frete em 10 dias
 *    úteis: R$ 40,98. A Indiana entregava o mesmo por R$ 21,74. Apresentar "a mais
 *    barata" que é quase o dobro e dez dias mais lenta não é um detalhe de ordenação,
 *    é dar a resposta errada com cara de resposta certa. Em 2 de 3 remédios testados
 *    o menor preço NÃO era a melhor compra.
 *
 * 2. A Drogasil recebia WhatsApp como se fosse farmácia de bairro (ela aparece no
 *    Google Places "verificada"), esperando um balconista responder. Esse conserto NÃO
 *    mora aqui: `isPharmacyChain` (pharmacy.ts) já responde "é rede grande?", com uma
 *    lista curada pra não confundir a "Farmácia Araújo" do dono independente com a rede.
 *    O tool-executor passou a usá-lo pra excluir rede do time de WhatsApp.
 *
 * Tudo aqui é PURO: sem I/O, sem relógio. O tipo de entrada é ESTRUTURAL de propósito
 * — `packages/shared` não conhece `PlatformBasketQuote` (a dependência é ao contrário),
 * e o que importa pra ordenar são só estes quatro campos.
 */

/** O mínimo que uma cotação precisa expor pra ser ordenada. */
export interface CotacaoOrdenavel {
  /** itens do pedido que ESTA rede tem — só o comprimento importa aqui */
  lines: readonly unknown[];
  /** soma dos itens, SEM frete */
  total: number;
  delivery: { feeReais: number; etaMinutes: number } | null;
  pickup: { feeReais: number; etaMinutes: number } | null;
}

/**
 * Quão rápido a pessoa TEM O REMÉDIO NA MÃO, em faixas que ela reconhece.
 *
 * `retirar-agora` nasceu da medição de 24/09: a amoxicilina na Pague Menos de Goiânia só
 * tinha entrega em "1 dia útil" (antibiótico: o entregador precisa recolher a receita),
 * mas tinha RETIRADA EM 60 MIN a 400 m. A faixa antiga olhava só a entrega — marcava
 * "hoje", a manchete dizia "chega em 1 dia útil" e escondia que dava pra resolver em uma
 * hora. Retirada rápida é "na hora" tanto quanto entrega rápida.
 */
export type FaixaDePrazo = 'agora' | 'retirar-agora' | 'hoje' | 'dias' | 'so-retirada' | 'nenhuma';

/**
 * "Agora" = até 4h. É a janela em que as redes vendem "entrega rápida" (60/90 min) e a
 * única em que a Xarlote pode dizer "você resolve agora" sem mentir.
 */
export const MINUTOS_AGORA = 4 * 60;
/**
 * "Hoje" = até 12h. Era 24h — e aí "1 dia útil" (= 1440 min) e "21 horas" contavam como
 * "hoje", quando os dois querem dizer amanhã. Sem saber a hora de corte da loja, 12h é o
 * teto honesto de "ainda hoje".
 */
export const MINUTOS_HOJE = 12 * 60;

export function faixaDePrazo(q: CotacaoOrdenavel): FaixaDePrazo {
  const entrega = q.delivery?.etaMinutes;
  const retirada = q.pickup?.etaMinutes;
  if (entrega !== undefined && entrega <= MINUTOS_AGORA) return 'agora';
  if (retirada !== undefined && retirada <= MINUTOS_AGORA) return 'retirar-agora';
  if (entrega !== undefined && entrega <= MINUTOS_HOJE) return 'hoje';
  // Entrega em dias e retirada MAIS CEDO — o caso comum à noite (medido em 24/09, 20:41: a
  // loja abre amanhã às 8h e a entrega fica pra amanhã 14h ou 2 dias úteis). A manchete é a
  // retirada. Antes a faixa ficava 'dias', e a rede com as DUAS opções ranqueava PIOR do que
  // se só tivesse a retirada.
  if (retirada !== undefined && (entrega === undefined || retirada < entrega)) return 'so-retirada';
  return entrega !== undefined ? 'dias' : 'nenhuma';
}

/** Ordem de preferência das faixas (menor = melhor). */
const PESO_FAIXA: Record<FaixaDePrazo, number> = {
  agora: 0,
  // Retirar em até 4h vem logo depois da entrega rápida: resolve agora, só exige sair de casa.
  'retirar-agora': 1,
  hoje: 2,
  // Retirar mais tarde na loja (sem entrega, ou antes da entrega em dias) ainda vale mais
  // que esperar dias pela entrega: a pessoa PODE ter o remédio antes, se quiser.
  'so-retirada': 3,
  dias: 4,
  nenhuma: 5,
};

/**
 * O que a pessoa REALMENTE paga: itens + frete. Sem entrega, cai pro total dos itens
 * (a retirada não tem frete) — e a falta de entrega já foi penalizada na faixa.
 */
export function totalEntregue(q: CotacaoOrdenavel): number {
  return q.total + (q.delivery?.feeReais ?? 0);
}

/**
 * O preço da opção que a MANCHETE promete. Quando a promessa é retirar na loja, o frete
 * de uma entrega que a pessoa não vai usar NÃO entra: na medição de 24/09 a amoxicilina
 * aparecia "R$ 15,39 · retire em 60 min" quando retirando custava R$ 10,49 — R$ 4,90 de
 * frete de uma entrega de 1 dia útil, somado na promessa errada.
 */
export function custoDaManchete(q: CotacaoOrdenavel): number {
  const f = faixaDePrazo(q);
  if (f === 'retirar-agora' || f === 'so-retirada') return q.total + (q.pickup?.feeReais ?? 0);
  return totalEntregue(q);
}

/**
 * Comparador oficial: cobertura → quando chega → quanto custa a opção prometida.
 *
 * Cobertura vem primeiro porque uma rede barata que só tem 1 dos 3 remédios obriga a
 * pessoa a fazer uma segunda compra em outro lugar — o preço menor é ilusório.
 */
export function compararCotacoesDeRede(a: CotacaoOrdenavel, b: CotacaoOrdenavel): number {
  if (a.lines.length !== b.lines.length) return b.lines.length - a.lines.length;
  const fa = PESO_FAIXA[faixaDePrazo(a)];
  const fb = PESO_FAIXA[faixaDePrazo(b)];
  if (fa !== fb) return fa - fb;
  return custoDaManchete(a) - custoDaManchete(b);
}

/** Ordena sem mutar a entrada. */
export function ordenarCotacoesDeRede<T extends CotacaoOrdenavel>(quotes: readonly T[]): T[] {
  return [...quotes].sort(compararCotacoesDeRede);
}

/** A pessoa tem o remédio em até 4h — recebendo em casa OU retirando na loja? */
export function ehNaHora(q: CotacaoOrdenavel): boolean {
  const f = faixaDePrazo(q);
  return f === 'agora' || f === 'retirar-agora';
}

/** Há ao menos uma opção que resolve AGORA (entrega ou retirada em até 4h)? */
export function temOpcaoImediata(quotes: readonly CotacaoOrdenavel[]): boolean {
  return quotes.some(ehNaHora);
}

/**
 * MODO ENTREGA NA HORA: quando existe opção que resolve agora, mostrar SÓ as que resolvem
 * agora — a promessa da Xarlote é "você tem o remédio hoje", e "chega em 4 dias úteis"
 * listado logo abaixo é exatamente o que o fundador pediu pra não aparecer.
 *
 * Com UMA exceção, pra nunca esconder a única resposta completa: uma opção lenta que tem
 * MAIS itens da receita do que a melhor opção rápida continua na lista (a pessoa precisa
 * saber que ali tem tudo). Sem nenhuma opção rápida, nada é filtrado — aí a honestidade é
 * mostrar a mais rápida que existe, com o prazo dela.
 *
 * Preserva a ordem de entrada (espera a lista já ordenada por `ordenarCotacoesDeRede`).
 */
export function selecionarParaEntregaNaHora<T extends CotacaoOrdenavel>(
  ordenadas: readonly T[],
): { cotacoes: T[]; soNaHora: boolean } {
  const rapidas = ordenadas.filter(ehNaHora);
  if (!rapidas.length) return { cotacoes: [...ordenadas], soNaHora: false };
  const coberturaRapida = Math.max(...rapidas.map((q) => q.lines.length));
  // A exceção é UMA: a melhor opção lenta que cobre mais itens. A 1ª versão mantinha TODAS
  // — com três lentas completas e uma rápida parcial, o corte do top-3 sumia justamente com
  // a rápida, e o log ainda dizia "só as que resolvem na hora" (revisão de 24/09).
  const excecao = ordenadas.find((q) => !ehNaHora(q) && q.lines.length > coberturaRapida);
  return {
    cotacoes: ordenadas.filter((q) => ehNaHora(q) || q === excecao),
    soNaHora: !excecao,
  };
}
