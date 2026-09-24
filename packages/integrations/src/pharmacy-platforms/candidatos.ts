/**
 * Qual MARCA oferecer em cada rede — a que existe no estoque DAQUELE CEP.
 *
 * ## O defeito (medição ao vivo em 24/09, CEP do Setor Central de Goiânia)
 *
 * A cotação pegava o produto mais parecido com o pedido (o 1º do ranking de match) e só
 * então perguntava ao CEP se havia estoque. Quando aquela MARCA não estava nas lojas da
 * região, a rede inteira saía da cotação para aquele remédio — mesmo tendo outras marcas
 * da mesma losartana 50mg na prateleira. Na medição, 3 dos 6 primeiros resultados não
 * tinham nenhuma entrega nem loja pro CEP (losartana Eurofarma e amoxicilina Ocylin na
 * Drogaria São Paulo; losartana na Pague Menos).
 *
 * ## A regra
 *
 * Guardar até `MAX_CANDIDATOS` produtos por pedido — todos já aprovados pelo ranking
 * (mesma substância, dose e forma; o ranqueador rejeita dose divergente) — perguntar ao
 * CEP por todos de uma vez, e ficar com o PRIMEIRO, na ordem do ranking, que está
 * disponível E tem como chegar (entrega ou retirada). Sem resposta do CEP, cai no
 * comportamento antigo (o 1º do ranking) em vez de sumir com a rede.
 */

/** Quantas marcas alternativas perguntar por remédio — o bastante pra achar estoque, pouco pra não pesar. */
export const MAX_CANDIDATOS = 3;

export interface CandidatoDeSku {
  sku: string;
  sellerId: string;
}

export interface PedidoComCandidatos<C extends CandidatoDeSku> {
  label: string;
  /** candidatos em ordem de preferência (a do ranking de match) */
  candidatos: readonly C[];
}

export interface EscolhaDeCandidatos<C extends CandidatoDeSku> {
  /** um por pedido atendido, na ordem dos pedidos */
  escolhidos: Array<{ pedidoIdx: number; candidato: C }>;
  /** rótulos dos pedidos sem NENHUM candidato utilizável no CEP */
  faltando: string[];
}

type EstadoNoCep = { available: boolean; temLogistica?: boolean };

/** O sku serve NESTE CEP? `temLogistica` ausente = desconhecido → não descarta. */
function serveNoCep(estado: EstadoNoCep | undefined): boolean {
  if (!estado) return false;
  return estado.available && estado.temLogistica !== false;
}

/**
 * Escolhe, por pedido, o primeiro candidato que o CEP consegue atender.
 *
 * `perSku = null` significa "não consegui perguntar ao CEP" (simulação falhou ou não foi
 * feita): aí vale o 1º do ranking, e quem decide o estoque é a simulação final da cesta —
 * exatamente como era antes, pra nunca ficar PIOR que a versão anterior.
 */
export function escolherCandidatosDisponiveis<C extends CandidatoDeSku>(
  pedidos: readonly PedidoComCandidatos<C>[],
  perSku: Record<string, EstadoNoCep> | null,
): EscolhaDeCandidatos<C> {
  const escolhidos: EscolhaDeCandidatos<C>['escolhidos'] = [];
  const faltando: string[] = [];
  pedidos.forEach((p, pedidoIdx) => {
    if (!p.candidatos.length) {
      faltando.push(p.label);
      return;
    }
    if (perSku === null) {
      escolhidos.push({ pedidoIdx, candidato: p.candidatos[0]! });
      return;
    }
    const bom = p.candidatos.find((c) => serveNoCep(perSku[c.sku]));
    if (bom) escolhidos.push({ pedidoIdx, candidato: bom });
    else faltando.push(p.label);
  });
  return { escolhidos, faltando };
}
