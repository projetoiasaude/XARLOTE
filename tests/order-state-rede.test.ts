/**
 * O bloco "ESTADO DO PEDIDO" que o modelo lê a cada turno sabe que as grandes redes já mandaram
 * link (revisão de 28/09): o pedido em que só o BAIRRO falhou não é "nenhuma opção viável".
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@iasaude/db', () => ({ db: {}, writeLog: async () => {} }));

const { buildOrderStateBlock } = await import('../apps/api/src/handlers/order-state.js');

const base = {
  orderId: 'o1', items: [{ name: 'Cefaliv' }], createdAt: new Date().toISOString(), selectedQuoteId: null,
  suppliers: [], closedAt: null, deliveryDeadline: null, closeConditions: null, supplierAckAfterClose: false,
  platformHandoff: false, deliveryAddress: null, deliveryLat: null, deliveryLng: null,
};

describe('estado do pedido com a oferta das redes', () => {
  it('bairro falhou + redes com link: não diz "nenhuma opção viável"', () => {
    const b = buildOrderStateBlock({ ...base, status: 'failed', ofertaDaRede: { rede: 'Pague Menos', total: 25.59, prazo: '⚡ chega em 60 min' } } as never);
    expect(b).not.toContain('nenhuma opção viável');
    expect(b).toContain('as opções das GRANDES REDES já foram enviadas com link');
    expect(b).toContain('Pague Menos R$ 25,59');
    expect(b).toContain('NUNCA diga que "nada deu certo"');
  });

  it('sem oferta das redes, o texto de antes', () => {
    const b = buildOrderStateBlock({ ...base, status: 'failed', ofertaDaRede: null } as never);
    expect(b).toContain('NÃO fechou — nenhuma opção viável ainda');
  });
});
