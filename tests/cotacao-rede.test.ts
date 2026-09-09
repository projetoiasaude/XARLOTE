/**
 * Ordenação das cotações de rede — e quem não deve receber WhatsApp.
 *
 * Os números destes testes NÃO são inventados: saíram de uma corrida real contra as
 * APIs das redes em 01/09/2026, CEP 74223-060 (Setor Bueno, Goiânia). Ficam aqui como
 * contrato porque foi essa corrida que mostrou o defeito — a produção ordenava pelo
 * preço do remédio e colocava em primeiro lugar a opção que custava quase o dobro e
 * chegava dez dias depois.
 */
import { describe, it, expect } from 'vitest';
import {
  compararCotacoesDeRede,
  ordenarCotacoesDeRede,
  faixaDePrazo,
  totalEntregue,
  temOpcaoImediata,
  type CotacaoOrdenavel,
} from '../packages/shared/src/cotacao-rede.js';

/** Helper: uma cotação de 1 item, com entrega opcional. */
function cot(
  total: number,
  entrega: { fee: number; min: number } | null,
  opts: { itens?: number; retirada?: { fee: number; min: number } } = {},
): CotacaoOrdenavel {
  return {
    lines: Array.from({ length: opts.itens ?? 1 }, (_, i) => i),
    total,
    delivery: entrega ? { feeReais: entrega.fee, etaMinutes: entrega.min } : null,
    pickup: opts.retirada ? { feeReais: opts.retirada.fee, etaMinutes: opts.retirada.min } : null,
  };
}

const DIA = 24 * 60;

describe('omeprazol 20mg — a corrida real de 01/09 em Goiânia', () => {
  // Os cinco que responderam, com o preço e o frete que as APIs devolveram.
  const catarinense = cot(12.56, { fee: 28.42, min: 10 * DIA });
  const indiana = cot(14.98, { fee: 6.76, min: 4 * DIA });
  const pagueMenos = cot(16.99, { fee: 7.90, min: 60 });
  const drogal = cot(17.99, { fee: 10.67, min: 5 * DIA });
  const pacheco = cot(21.26, { fee: 7.90, min: 60 });

  it('o menor preço de remédio é a PIOR compra — quase o dobro e dez dias mais lenta', () => {
    expect(catarinense.total).toBeLessThan(indiana.total);      // parecia a mais barata
    expect(totalEntregue(catarinense)).toBeCloseTo(40.98, 2);
    expect(totalEntregue(indiana)).toBeCloseTo(21.74, 2);
    expect(totalEntregue(catarinense)).toBeGreaterThan(totalEntregue(indiana));
  });

  it('quem entrega em 60 min vem primeiro, e entre eles o mais barato entregue', () => {
    const ordem = ordenarCotacoesDeRede([catarinense, indiana, pagueMenos, drogal, pacheco]);
    expect(ordem[0]).toBe(pagueMenos);   // 60 min, R$ 24,89
    expect(ordem[1]).toBe(pacheco);      // 60 min, R$ 29,16
    expect(ordem[2]).toBe(indiana);      // 4 dias, R$ 21,74 — mais barata, mas não chega hoje
    expect(ordem[4]).toBe(catarinense);  // a "mais barata" da tela antiga, em último
  });

  it('a ordem antiga (por preço do remédio) daria a resposta errada', () => {
    const antiga = [catarinense, indiana, pagueMenos, drogal, pacheco].sort((a, b) => a.total - b.total);
    expect(antiga[0]).toBe(catarinense);
    expect(ordenarCotacoesDeRede(antiga)[0]).not.toBe(catarinense);
  });
});

describe('faixaDePrazo', () => {
  it('separa agora, hoje e dias pela janela de 4h e de 1 dia', () => {
    expect(faixaDePrazo(cot(10, { fee: 0, min: 60 }))).toBe('agora');
    expect(faixaDePrazo(cot(10, { fee: 0, min: 4 * 60 }))).toBe('agora');
    expect(faixaDePrazo(cot(10, { fee: 0, min: 4 * 60 + 1 }))).toBe('hoje');
    expect(faixaDePrazo(cot(10, { fee: 0, min: DIA + 1 }))).toBe('dias');
  });

  it('sem entrega mas com retirada é "so-retirada"; sem nada é "nenhuma"', () => {
    expect(faixaDePrazo(cot(10, null, { retirada: { fee: 0, min: 60 } }))).toBe('so-retirada');
    expect(faixaDePrazo(cot(10, null))).toBe('nenhuma');
  });
});

describe('regras de desempate', () => {
  it('cobertura vence velocidade: rede com 2 dos 2 remédios passa na frente', () => {
    const completaLenta = cot(50, { fee: 5, min: 5 * DIA }, { itens: 2 });
    const parcialRapida = cot(10, { fee: 5, min: 60 }, { itens: 1 });
    expect(compararCotacoesDeRede(completaLenta, parcialRapida)).toBeLessThan(0);
  });

  it('retirar hoje na loja vale mais que receber em cinco dias', () => {
    const retiraHoje = cot(20, null, { retirada: { fee: 0, min: 60 } });
    const entregaDaquiA5Dias = cot(20, { fee: 5, min: 5 * DIA });
    expect(compararCotacoesDeRede(retiraHoje, entregaDaquiA5Dias)).toBeLessThan(0);
  });

  it('sem entrega e sem retirada vai pro fim, mesmo sendo a mais barata', () => {
    const saoJoao = cot(1, null);                       // R$ 1 e nenhuma logística
    const pacheco = cot(99, { fee: 7.9, min: 60 });
    expect(ordenarCotacoesDeRede([saoJoao, pacheco])[0]).toBe(pacheco);
  });

  it('não muta o array de entrada', () => {
    const entrada = [cot(30, { fee: 0, min: 5 * DIA }), cot(10, { fee: 0, min: 60 })];
    const copia = [...entrada];
    ordenarCotacoesDeRede(entrada);
    expect(entrada).toEqual(copia);
  });
});

describe('temOpcaoImediata', () => {
  it('reconhece entrega rápida e retirada no mesmo dia', () => {
    expect(temOpcaoImediata([cot(10, { fee: 0, min: 90 })])).toBe(true);
    expect(temOpcaoImediata([cot(10, null, { retirada: { fee: 0, min: 60 } })])).toBe(true);
  });

  it('cinco dias úteis não é imediato', () => {
    expect(temOpcaoImediata([cot(10, { fee: 0, min: 5 * DIA })])).toBe(false);
    expect(temOpcaoImediata([])).toBe(false);
  });
});
