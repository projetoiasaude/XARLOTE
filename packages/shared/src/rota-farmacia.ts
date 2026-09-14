/**
 * A QUAL PEDIDO PERTENCE A MENSAGEM DA FARMÁCIA? (caso Ludmila, 10/09/2026)
 *
 * A conversa com cada farmácia é UMA por telefone — compartilhada entre todos os pedidos, de
 * todos os pacientes, de todos os tempos. Quando a Drogaria Coimbra respondeu "69.90", "qual
 * nome da pessoa que vai receber?" e "5 reais de frete" DEPOIS de a cotação de hoje ter virado
 * `quoted`, o roteador não achou cotação em negociação e procurou um pedido em PÓS-VENDA
 * naquela conversa — e achou um de **14 de julho, de outro paciente** (Cefaliv/Dorflex,
 * `handed_off`). Como esse pedido estava fora da janela de 72 h, a mensagem foi descartada:
 * "fora da janela de pós-venda — não processada". Três vezes. O ramo certo ("farmácia mandou
 * o frete depois de cotar → leva ao cliente") existia, mas ficava DEPOIS do pós-venda e era
 * inalcançável para qualquer farmácia que já tivesse entregado um pedido algum dia.
 *
 * A raiz é a ORDEM DAS GUARDAS e um pós-venda sem limite de tempo. Aqui a decisão vira uma
 * função pura, com precedência explícita e testável:
 *
 *   1. cotação em NEGOCIAÇÃO nesta conversa → `negociacao`
 *      (sinal de chegada/nome desvia pro pós-venda SÓ se a janela dele estiver aberta);
 *   2. pedido em PÓS-VENDA com janela de 72 h ABERTA → `pos_venda`;
 *   3. cotação `quoted` de pedido VIVO (quoting|quoted, sem escolhida, recente) → `pos_cotacao`;
 *   4. cotação `timeout` de pedido recente → `tardia` (revive);
 *   5. nada → `nenhuma`, com o porquê.
 *
 * O handler só monta as candidatas e obedece.
 */

export const ARRIVAL_RE = /\b(na porta|motoq\w*|motoboy|motoca|entregador|sa[ií]u\s*(pra|para)\s*entrega|a caminho|ningu[ée]m\s+(atende\w*|abriu)|(entregador|motoq\w*|motoboy|entrega)\s+\w*\s*(cheg\w*|t[aâ]\s*a[íi]|na porta)|cheg\w*\s+(o|a)\s+(entregador|motoq\w*|motoboy|entrega))\b/i;
export const WHO_ASK_RE = /\b(procura\s+quem|nome\s+de\s+quem|quem\s+(vai\s+)?receb\w*|com\s+quem\s+deix|nome\s+d[oa]\s+(cliente|paciente|pessoa|respons))\b/i;

export type RotaDaMensagem = 'negociacao' | 'pos_venda' | 'pos_cotacao' | 'tardia' | 'nenhuma';

export interface CotacaoCandidata {
  id: string;
  orderId: string;
  /** pending | contacting | negotiating | quoted | unavailable | timeout */
  status: string;
  createdAt: string;
  completedAt: string | null;
  order: {
    status: string;
    selectedQuoteId: string | null;
    closedAt: string | null;
    createdAt: string;
  };
}

export interface DecisaoDeRota {
  rota: RotaDaMensagem;
  cotacao: CotacaoCandidata | null;
  motivo: string;
  /** Mais de uma candidata concorrendo pela mesma rota. */
  ambiguidade?: 'pedidos_distintos' | 'mesmo_pedido';
}

const NEGOCIANDO = new Set(['pending', 'contacting', 'negotiating']);
const POS_VENDA = new Set(['confirming', 'handed_off']);
const PEDIDO_VIVO = new Set(['quoting', 'quoted']);
const REVIVE_OK = new Set(['quoting', 'failed', 'quoted']);

export const JANELA_POS_VENDA_MS = 72 * 60 * 60 * 1000;
export const JANELA_PEDIDO_VIVO_MS = 24 * 60 * 60 * 1000;

function ms(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? null : t;
}

function maisRecente(a: CotacaoCandidata, b: CotacaoCandidata): number {
  return (ms(b.createdAt) ?? 0) - (ms(a.createdAt) ?? 0);
}

/** Janela de pós-venda ainda aberta? Âncora: closed_at do pedido; fallback: completed_at da cotação. */
export function posVendaAberto(c: CotacaoCandidata, agoraMs: number, janelaMs = JANELA_POS_VENDA_MS): boolean {
  const anchor = ms(c.order.closedAt) ?? ms(c.completedAt);
  if (anchor == null) return true; // sem âncora não dá pra dizer que venceu (comportamento antigo)
  return agoraMs - anchor <= janelaMs;
}

export function decidirRotaDaMensagem(
  candidatas: CotacaoCandidata[],
  texto: string,
  agoraMs: number,
  opts: { janelaPosVendaMs?: number; janelaPedidoVivoMs?: number } = {},
): DecisaoDeRota {
  const janelaPV = opts.janelaPosVendaMs ?? JANELA_POS_VENDA_MS;
  const janelaVivo = opts.janelaPedidoVivoMs ?? JANELA_PEDIDO_VIVO_MS;

  // Pós-venda ELEGÍVEL = pedido fechado, janela aberta; preferência pela cotação ESCOLHIDA.
  const posVendaElegiveis = candidatas
    .filter((c) => POS_VENDA.has(c.order.status) && posVendaAberto(c, agoraMs, janelaPV))
    .sort(maisRecente);
  const posVenda = posVendaElegiveis.find((c) => c.order.selectedQuoteId === c.id)
    ?? posVendaElegiveis.find((c) => c.status === 'quoted')
    ?? posVendaElegiveis[0]
    ?? null;

  // 1. Negociação aberta.
  const negociando = candidatas.filter((c) => NEGOCIANDO.has(c.status)).sort(maisRecente);
  if (negociando.length) {
    const sinalPosVenda = ARRIVAL_RE.test(texto) || WHO_ASK_RE.test(texto);
    if (sinalPosVenda && posVenda) {
      return { rota: 'pos_venda', cotacao: posVenda, motivo: 'sinal de chegada/nome durante negociação de outro pedido — pós-venda com janela aberta' };
    }
    const distintos = new Set(negociando.map((c) => c.orderId));
    return {
      rota: 'negociacao',
      cotacao: negociando[0] as CotacaoCandidata,
      motivo: 'cotação em negociação nesta conversa',
      ...(negociando.length > 1 ? { ambiguidade: distintos.size > 1 ? 'pedidos_distintos' : 'mesmo_pedido' } : {}),
    };
  }

  // 2. Pós-venda com janela aberta.
  if (posVenda) {
    const distintos = new Set(posVendaElegiveis.map((c) => c.orderId));
    return {
      rota: 'pos_venda',
      cotacao: posVenda,
      motivo: 'pedido fechado com janela de pós-venda aberta',
      ...(distintos.size > 1 ? { ambiguidade: 'pedidos_distintos' } : {}),
    };
  }

  // 3. Pós-cotação: cotou, o pedido está vivo e ninguém decidiu ainda.
  const posCotacao = candidatas
    .filter((c) => c.status === 'quoted' && PEDIDO_VIVO.has(c.order.status) && !c.order.selectedQuoteId)
    .filter((c) => { const t = ms(c.order.createdAt); return t != null && agoraMs - t <= janelaVivo; })
    .sort(maisRecente);
  if (posCotacao.length) {
    return { rota: 'pos_cotacao', cotacao: posCotacao[0] as CotacaoCandidata, motivo: 'cotação registrada de pedido vivo, sem decisão do paciente' };
  }

  // 4. Resposta tardia (a farmácia falou depois do timeout).
  const tardias = candidatas
    .filter((c) => c.status === 'timeout' && REVIVE_OK.has(c.order.status))
    .filter((c) => { const t = ms(c.order.createdAt); return t != null && agoraMs - t <= janelaVivo; })
    .sort(maisRecente);
  if (tardias.length) {
    return { rota: 'tardia', cotacao: tardias[0] as CotacaoCandidata, motivo: 'resposta depois do timeout, pedido ainda recente' };
  }

  // 5. Nada — explica o que existia e por que não serviu.
  const fechadosVencidos = candidatas.filter((c) => POS_VENDA.has(c.order.status)).length;
  const motivo = fechadosVencidos
    ? `só há pedido(s) fechado(s) com pós-venda vencido (${fechadosVencidos}) — conversa antiga`
    : candidatas.length ? 'nenhuma cotação viva, recente ou reabrível' : 'nenhuma cotação nesta conversa';
  return { rota: 'nenhuma', cotacao: null, motivo };
}
