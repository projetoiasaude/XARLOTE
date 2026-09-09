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

/** Quão rápido chega, em faixas que uma pessoa reconhece. */
export type FaixaDePrazo = 'agora' | 'hoje' | 'dias' | 'so-retirada' | 'nenhuma';

/**
 * "Agora" = até 4h. É a janela em que as redes vendem "entrega rápida" (60/90 min) e a
 * única em que a Xarlote pode dizer "você resolve hoje" sem mentir. Acima de 4h e dentro
 * do dia ainda é "hoje"; passou disso, a pessoa vai esperar — e precisa saber disso ANTES
 * de escolher, não depois de pagar.
 */
export const MINUTOS_AGORA = 4 * 60;
export const MINUTOS_HOJE = 24 * 60;

export function faixaDePrazo(q: CotacaoOrdenavel): FaixaDePrazo {
  if (q.delivery) {
    if (q.delivery.etaMinutes <= MINUTOS_AGORA) return 'agora';
    if (q.delivery.etaMinutes <= MINUTOS_HOJE) return 'hoje';
    return 'dias';
  }
  return q.pickup ? 'so-retirada' : 'nenhuma';
}

/** Ordem de preferência das faixas (menor = melhor). */
const PESO_FAIXA: Record<FaixaDePrazo, number> = {
  agora: 0,
  hoje: 1,
  // Retirar hoje na loja vale mais que receber em 5 dias: a pessoa PODE ter o remédio
  // hoje se quiser. Só perde pra entrega rápida, que não exige sair de casa.
  'so-retirada': 2,
  dias: 3,
  nenhuma: 4,
};

/**
 * O que a pessoa REALMENTE paga: itens + frete. Sem entrega, cai pro total dos itens
 * (a retirada não tem frete) — e a falta de entrega já foi penalizada na faixa.
 */
export function totalEntregue(q: CotacaoOrdenavel): number {
  return q.total + (q.delivery?.feeReais ?? 0);
}

/**
 * Comparador oficial: cobertura → quando chega → quanto custa entregue.
 *
 * Cobertura vem primeiro porque uma rede barata que só tem 1 dos 3 remédios obriga a
 * pessoa a fazer uma segunda compra em outro lugar — o preço menor é ilusório.
 */
export function compararCotacoesDeRede(a: CotacaoOrdenavel, b: CotacaoOrdenavel): number {
  if (a.lines.length !== b.lines.length) return b.lines.length - a.lines.length;
  const fa = PESO_FAIXA[faixaDePrazo(a)];
  const fb = PESO_FAIXA[faixaDePrazo(b)];
  if (fa !== fb) return fa - fb;
  return totalEntregue(a) - totalEntregue(b);
}

/** Ordena sem mutar a entrada. */
export function ordenarCotacoesDeRede<T extends CotacaoOrdenavel>(quotes: readonly T[]): T[] {
  return [...quotes].sort(compararCotacoesDeRede);
}

/** Há ao menos uma opção que resolve HOJE (entrega rápida ou retirada no mesmo dia)? */
export function temOpcaoImediata(quotes: readonly CotacaoOrdenavel[]): boolean {
  return quotes.some((q) => {
    const f = faixaDePrazo(q);
    return f === 'agora' || (f === 'so-retirada' && (q.pickup?.etaMinutes ?? Infinity) <= MINUTOS_HOJE);
  });
}
