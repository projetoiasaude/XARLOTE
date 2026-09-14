import { describe, it, expect } from 'vitest';
import { decidirRotaDaMensagem, posVendaAberto, type CotacaoCandidata } from '../packages/shared/src/rota-farmacia';

const AGORA = new Date('2026-09-10T15:25:15Z').getTime(); // 12:25 BRT, quando a Coimbra perguntou o nome
const H = 60 * 60 * 1000;

function cot(p: Partial<CotacaoCandidata> & { id: string; orderId: string; status: string; orderStatus: string; createdAt: string; orderCreatedAt?: string }): CotacaoCandidata {
  return {
    id: p.id, orderId: p.orderId, status: p.status, createdAt: p.createdAt,
    completedAt: p.completedAt ?? null,
    order: {
      status: p.orderStatus,
      selectedQuoteId: p.order?.selectedQuoteId ?? null,
      closedAt: p.order?.closedAt ?? null,
      createdAt: p.orderCreatedAt ?? p.createdAt,
    },
  };
}

// A conversa REAL da Drogaria Coimbra em 10/09: um pedido de julho fechado (outro paciente),
// dois pedidos de hoje (o "Aflor" cancelado/unavailable e o "Daflon Flex" cotado).
const julho = cot({ id: 'q-jul', orderId: 'o-jul', status: 'quoted', orderStatus: 'handed_off', createdAt: '2026-07-14T16:57:20Z', completedAt: '2026-07-14T17:35:17Z', order: { selectedQuoteId: 'q-jul', closedAt: '2026-07-14T17:26:15Z', createdAt: '2026-07-14T16:57:11Z', status: 'handed_off' } });
const aflor = cot({ id: 'q-aflor', orderId: 'o-aflor', status: 'unavailable', orderStatus: 'cancelled', createdAt: '2026-09-10T15:13:14Z', completedAt: '2026-09-10T15:18:48Z' });
const daflon = cot({ id: 'q-daflon', orderId: 'o-daflon', status: 'quoted', orderStatus: 'quoted', createdAt: '2026-09-10T15:19:34Z', completedAt: '2026-09-10T15:23:26Z', orderCreatedAt: '2026-09-10T15:19:25Z' });

describe('decidirRotaDaMensagem — o cenário da Ludmila', () => {
  it('"qual nome da pessoa que vai receber?" vai pro pedido VIVO de hoje, não pro de julho', () => {
    const d = decidirRotaDaMensagem([julho, aflor, daflon], 'Qual nome da pessoa que vai receber?', AGORA);
    expect(d.rota).toBe('pos_cotacao');
    expect(d.cotacao?.id).toBe('q-daflon');
  });
  it('"5 reais de frete" e "69.90" também', () => {
    expect(decidirRotaDaMensagem([julho, aflor, daflon], '5 reais de frete', AGORA).rota).toBe('pos_cotacao');
    expect(decidirRotaDaMensagem([julho, aflor, daflon], '69.90', AGORA).rota).toBe('pos_cotacao');
  });
  it('sem o pedido de hoje, o de julho está vencido → nenhuma, com o porquê', () => {
    const d = decidirRotaDaMensagem([julho], 'oi', AGORA);
    expect(d.rota).toBe('nenhuma');
    expect(d.motivo).toContain('pós-venda vencido');
  });
});

describe('precedência das rotas', () => {
  it('negociação aberta vence tudo', () => {
    const neg = cot({ id: 'q-neg', orderId: 'o-neg', status: 'negotiating', orderStatus: 'quoting', createdAt: '2026-09-10T15:20:00Z' });
    const d = decidirRotaDaMensagem([julho, daflon, neg], 'tem sim, 30 reais', AGORA);
    expect(d.rota).toBe('negociacao');
    expect(d.cotacao?.id).toBe('q-neg');
  });
  it('chegada/nome durante negociação desvia pro pós-venda SÓ se a janela dele estiver aberta', () => {
    const neg = cot({ id: 'q-neg', orderId: 'o-neg', status: 'negotiating', orderStatus: 'quoting', createdAt: '2026-09-10T15:20:00Z' });
    const fechadoOntem = cot({ id: 'q-ontem', orderId: 'o-ontem', status: 'quoted', orderStatus: 'handed_off', createdAt: '2026-09-09T15:00:00Z', order: { selectedQuoteId: 'q-ontem', closedAt: '2026-09-09T16:00:00Z', createdAt: '2026-09-09T15:00:00Z', status: 'handed_off' } });
    expect(decidirRotaDaMensagem([fechadoOntem, neg], 'o motoboy tá na porta', AGORA).rota).toBe('pos_venda');
    expect(decidirRotaDaMensagem([julho, neg], 'o motoboy tá na porta', AGORA).rota).toBe('negociacao'); // julho vencido
  });
  it('pós-venda aberto vem antes de pós-cotação; prefere a cotação escolhida', () => {
    const fechadoHoje = cot({ id: 'q-hoje', orderId: 'o-hoje', status: 'quoted', orderStatus: 'handed_off', createdAt: '2026-09-10T13:00:00Z', order: { selectedQuoteId: 'q-hoje', closedAt: '2026-09-10T14:00:00Z', createdAt: '2026-09-10T13:00:00Z', status: 'handed_off' } });
    const irma = cot({ id: 'q-irma', orderId: 'o-hoje', status: 'quoted', orderStatus: 'handed_off', createdAt: '2026-09-10T13:01:00Z', order: { selectedQuoteId: 'q-hoje', closedAt: '2026-09-10T14:00:00Z', createdAt: '2026-09-10T13:00:00Z', status: 'handed_off' } });
    const d = decidirRotaDaMensagem([irma, fechadoHoje, daflon], 'saiu pra entrega', AGORA);
    expect(d.rota).toBe('pos_venda');
    expect(d.cotacao?.id).toBe('q-hoje');
  });
  it('pós-cotação exige pedido vivo, sem escolhida e recente', () => {
    const decidido = cot({ id: 'q-d', orderId: 'o-d', status: 'quoted', orderStatus: 'quoted', createdAt: '2026-09-10T15:19:34Z', order: { selectedQuoteId: 'q-outra', closedAt: null, createdAt: '2026-09-10T15:19:25Z', status: 'quoted' } });
    expect(decidirRotaDaMensagem([decidido], 'frete 5', AGORA).rota).toBe('nenhuma');
    const velho = cot({ id: 'q-v', orderId: 'o-v', status: 'quoted', orderStatus: 'quoted', createdAt: '2026-09-08T15:19:34Z', orderCreatedAt: '2026-09-08T15:19:25Z' });
    expect(decidirRotaDaMensagem([velho], 'frete 5', AGORA).rota).toBe('nenhuma');
  });
  it('resposta tardia revive timeout de pedido recente (quoting/failed/quoted)', () => {
    const tardia = cot({ id: 'q-t', orderId: 'o-t', status: 'timeout', orderStatus: 'failed', createdAt: '2026-09-10T14:00:00Z', orderCreatedAt: '2026-09-10T13:55:00Z' });
    expect(decidirRotaDaMensagem([julho, tardia], 'tem sim, 25 reais', AGORA).rota).toBe('tardia');
    const tardiaVelha = cot({ id: 'q-tv', orderId: 'o-tv', status: 'timeout', orderStatus: 'failed', createdAt: '2026-09-08T14:00:00Z', orderCreatedAt: '2026-09-08T13:55:00Z' });
    expect(decidirRotaDaMensagem([tardiaVelha], 'tem sim', AGORA).rota).toBe('nenhuma');
  });
  it('ambiguidade é reportada, nunca engolida', () => {
    const a = cot({ id: 'a', orderId: 'o1', status: 'negotiating', orderStatus: 'quoting', createdAt: '2026-09-10T15:20:00Z' });
    const b = cot({ id: 'b', orderId: 'o2', status: 'negotiating', orderStatus: 'quoting', createdAt: '2026-09-10T15:21:00Z' });
    const d = decidirRotaDaMensagem([a, b], 'tem', AGORA);
    expect(d.rota).toBe('negociacao');
    expect(d.cotacao?.id).toBe('b');
    expect(d.ambiguidade).toBe('pedidos_distintos');
  });
});

describe('posVendaAberto', () => {
  it('72h a partir do closed_at; sem âncora não vence', () => {
    expect(posVendaAberto(julho, AGORA)).toBe(false);
    expect(posVendaAberto({ ...julho, order: { ...julho.order, closedAt: new Date(AGORA - 71 * H).toISOString() } }, AGORA)).toBe(true);
    expect(posVendaAberto({ ...julho, completedAt: null, order: { ...julho.order, closedAt: null } }, AGORA)).toBe(true);
  });
});
