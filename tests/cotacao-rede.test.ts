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
  selecionarParaEntregaNaHora,
  custoDaManchete,
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
  it('separa agora, hoje e dias pela janela de 4h e de 12h', () => {
    expect(faixaDePrazo(cot(10, { fee: 0, min: 60 }))).toBe('agora');
    expect(faixaDePrazo(cot(10, { fee: 0, min: 4 * 60 }))).toBe('agora');
    expect(faixaDePrazo(cot(10, { fee: 0, min: 4 * 60 + 1 }))).toBe('hoje');
    expect(faixaDePrazo(cot(10, { fee: 0, min: 12 * 60 }))).toBe('hoje');
    expect(faixaDePrazo(cot(10, { fee: 0, min: DIA + 1 }))).toBe('dias');
  });

  it('"1 dia útil" e "21 horas" NÃO são hoje (a janela de 24h mentia — ajuste de 24/09)', () => {
    expect(faixaDePrazo(cot(10, { fee: 0, min: DIA }))).toBe('dias');      // 1bd = 1440 min
    expect(faixaDePrazo(cot(10, { fee: 0, min: 21 * 60 }))).toBe('dias');  // "EXPRESSA 21h" da DSP
  });

  it('retirada em até 4h é "retirar-agora"; mais tarde é "so-retirada"; sem nada é "nenhuma"', () => {
    expect(faixaDePrazo(cot(10, null, { retirada: { fee: 0, min: 60 } }))).toBe('retirar-agora');
    expect(faixaDePrazo(cot(10, null, { retirada: { fee: 0, min: 5 * 60 } }))).toBe('so-retirada');
    expect(faixaDePrazo(cot(10, null))).toBe('nenhuma');
  });

  it('amoxicilina na Pague Menos (medição real 24/09): entrega 1 dia útil + retirada 60 min = na hora', () => {
    // A faixa antiga olhava só a entrega: "hoje" e manchete "chega em 1 dia útil",
    // escondendo que a pessoa podia ter o antibiótico em 1 hora a 350 m de casa.
    const amox = cot(21.9, { fee: 2.45, min: DIA }, { retirada: { fee: 0, min: 60 } });
    expect(faixaDePrazo(amox)).toBe('retirar-agora');
  });

  it('entrega rápida continua mandando mesmo com retirada ainda mais rápida (não exige sair de casa)', () => {
    expect(faixaDePrazo(cot(10, { fee: 7.9, min: 90 }, { retirada: { fee: 0, min: 30 } }))).toBe('agora');
  });
});

describe('regras de desempate', () => {
  it('cobertura vence velocidade: rede com 2 dos 2 remédios passa na frente', () => {
    const completaLenta = cot(50, { fee: 5, min: 5 * DIA }, { itens: 2 });
    const parcialRapida = cot(10, { fee: 5, min: 60 }, { itens: 1 });
    expect(compararCotacoesDeRede(completaLenta, parcialRapida)).toBeLessThan(0);
  });

  it('retirar em 60 min vence entrega em 1 dia útil, e perde só pra entrega rápida', () => {
    const retiraJa = cot(21.9, { fee: 2.45, min: DIA }, { retirada: { fee: 0, min: 60 } });
    const entregaAmanha = cot(15, { fee: 5, min: DIA });
    const entregaEm90 = cot(30, { fee: 7.9, min: 90 });
    const ordem = ordenarCotacoesDeRede([entregaAmanha, retiraJa, entregaEm90]);
    expect(ordem).toEqual([entregaEm90, retiraJa, entregaAmanha]);
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

  it('retirada só amanhã NÃO é imediata (antes, qualquer retirada em até 24h dizia "hoje mesmo")', () => {
    expect(temOpcaoImediata([cot(10, null, { retirada: { fee: 0, min: 20 * 60 } })])).toBe(false);
  });
});

describe('selecionarParaEntregaNaHora — o modo "entrega na hora"', () => {
  const pagueMenos60 = cot(16.99, { fee: 7.9, min: 60 });
  const pacheco90 = cot(21.26, { fee: 7.9, min: 90 });
  const drogal4dias = cot(3.49, { fee: 10.57, min: 4 * DIA });
  const catarinense11dias = cot(5.75, { fee: 30.35, min: 11 * DIA });

  it('havendo quem resolve agora, os lentos saem da lista', () => {
    const ordenadas = ordenarCotacoesDeRede([drogal4dias, pagueMenos60, catarinense11dias, pacheco90]);
    const r = selecionarParaEntregaNaHora(ordenadas);
    expect(r.soNaHora).toBe(true);
    expect(r.cotacoes).toEqual([pagueMenos60, pacheco90]);
  });

  it('retirada rápida conta como "na hora"', () => {
    const retira = cot(21.9, { fee: 2.45, min: DIA }, { retirada: { fee: 0, min: 60 } });
    const r = selecionarParaEntregaNaHora(ordenarCotacoesDeRede([drogal4dias, retira]));
    expect(r.cotacoes).toEqual([retira]);
  });

  it('NUNCA esconde a única opção com a receita COMPLETA, mesmo lenta', () => {
    const completaLenta = cot(40, { fee: 10, min: 4 * DIA }, { itens: 3 });
    const parcialRapida = cot(20, { fee: 7.9, min: 60 }, { itens: 2 });
    const r = selecionarParaEntregaNaHora(ordenarCotacoesDeRede([parcialRapida, completaLenta]));
    expect(r.cotacoes).toContain(completaLenta);
    expect(r.cotacoes).toContain(parcialRapida);
  });

  it('sem ninguém rápido, nada é filtrado — a honestidade é mostrar o prazo que existe', () => {
    const ordenadas = ordenarCotacoesDeRede([drogal4dias, catarinense11dias]);
    const r = selecionarParaEntregaNaHora(ordenadas);
    expect(r.soNaHora).toBe(false);
    expect(r.cotacoes).toEqual(ordenadas);
  });

  it('preserva a ordem de entrada e não muta', () => {
    const ordenadas = ordenarCotacoesDeRede([pacheco90, pagueMenos60]);
    const copia = [...ordenadas];
    selecionarParaEntregaNaHora(ordenadas);
    expect(ordenadas).toEqual(copia);
  });
});

describe('custoDaManchete — o preço da opção PROMETIDA (prova ao vivo 24/09)', () => {
  it('amoxicilina: "retire em 60 min" custa R$ 10,49 — o frete de R$ 4,90 da entrega de 1 dia útil não entra', () => {
    const amox = cot(10.49, { fee: 4.9, min: DIA }, { retirada: { fee: 0, min: 60 } });
    expect(custoDaManchete(amox)).toBeCloseTo(10.49, 2);
    expect(totalEntregue(amox)).toBeCloseTo(15.39, 2); // o número que a manchete mostrava
  });

  it('manchete de entrega continua com o frete (o que sai do bolso)', () => {
    expect(custoDaManchete(cot(14.99, { fee: 7.9, min: 90 }))).toBeCloseTo(22.89, 2);
  });

  it('na mesma faixa de retirada, o desempate é pelo preço de RETIRAR, não pelo frete de uma entrega ignorada', () => {
    const freteCaroMasRemedioBarato = cot(10, { fee: 30, min: 5 * DIA }, { retirada: { fee: 0, min: 60 } });
    const freteBaratoRemedioCaro = cot(15, { fee: 2, min: 5 * DIA }, { retirada: { fee: 0, min: 60 } });
    expect(ordenarCotacoesDeRede([freteBaratoRemedioCaro, freteCaroMasRemedioBarato])[0]).toBe(freteCaroMasRemedioBarato);
  });
});
