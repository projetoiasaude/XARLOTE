/**
 * O alerta que não significava nada.
 *
 * 25/08/2026, 09:45. Chegou no WhatsApp do fundador, severidade alta: "LLM p95 alto".
 * As 6 horas anteriores tinham NOVE chamadas, mediana de 5,8s e uma de 57s.
 *
 * O detector exigia 10 amostras e usava `floor(n × 0,95)` — com n=10, índice 9, o
 * MÁXIMO. Em volume baixo, "p95" era só a pior chamada da janela.
 */
import { describe, it, expect } from 'vitest';
import {
  avaliarLatencia, percentilPorPosto, descreverLatencia,
  AMOSTRA_MINIMA_P95, LIMIAR_CHAMADA_LENTA_MS,
} from '../packages/shared/src/latencia.js';

describe('o índice que apontava pro máximo', () => {
  it('floor(n × 0,95) escolhia o último elemento em amostra pequena', () => {
    const dez = [1, 2, 3, 4, 5, 6, 7, 8, 9, 100];
    expect(Math.floor(dez.length * 0.95)).toBe(9);   // o bug: índice do MÁXIMO
    expect(dez[9]).toBe(100);
    expect(percentilPorPosto(dez, 0.95)).toBe(100);  // por posto também, mas...
  });

  it('…e nunca estoura o fim do array', () => {
    expect(percentilPorPosto([5], 0.95)).toBe(5);
    expect(percentilPorPosto([], 0.95)).toBeNull();
    expect(percentilPorPosto([1, 2, 3, 4], 0.5)).toBe(2);
  });
});

describe('o caso real de 25/08 não alerta mais', () => {
  const NOVE_CHAMADAS = [3200, 4100, 5810, 5900, 6400, 7100, 9200, 11400, 57216];

  it('nove chamadas com uma lenta: sem alerta', () => {
    const v = avaliarLatencia(NOVE_CHAMADAS);
    expect(v.alertar).toBe(false);
    if (!v.alertar) expect(v.motivo).toBe('amostra_insuficiente');
  });

  it('mas TRÊS chamadas absurdas alertam, mesmo em volume baixo', () => {
    // Contagem acima de um limiar duro é válida com 9 ou 9.000 amostras.
    const v = avaliarLatencia([3200, 4100, 50_000, 61_000, 47_500]);
    expect(v).toMatchObject({ alertar: true, tipo: 'chamadas_lentas', lentas: 3 });
  });

  it('uma lenta é azar, não incidente', () => {
    expect(avaliarLatencia([3000, 4000, 5000, 60_000]).alertar).toBe(false);
  });
});

describe('com amostra de verdade, o p95 volta a valer', () => {
  it(`${AMOSTRA_MINIMA_P95}+ chamadas lentas disparam o alerta de distribuição`, () => {
    const muitas = Array.from({ length: 40 }, (_, i) => (i < 36 ? 31_000 : 40_000));
    const v = avaliarLatencia(muitas);
    expect(v).toMatchObject({ alertar: true, tipo: 'p95' });
  });

  it('sistema saudável com volume alto não alerta', () => {
    const v = avaliarLatencia(Array.from({ length: 60 }, () => 4000));
    expect(v).toEqual({ alertar: false, motivo: 'saudavel' });
  });

  it('sem dados não inventa alerta', () => {
    expect(avaliarLatencia([])).toEqual({ alertar: false, motivo: 'sem_dados' });
    expect(avaliarLatencia([0, -1, NaN])).toEqual({ alertar: false, motivo: 'sem_dados' });
  });
});

describe('a mensagem diz o que foi medido', () => {
  it('o alerta de chamadas lentas informa quantas, o pior caso e o total', () => {
    const v = avaliarLatencia([3000, 50_000, 61_000, 47_500]);
    const txt = descreverLatencia(v)!;
    expect(txt).toContain('3 chamadas');
    expect(txt).toContain('61.0s');
    expect(txt).toContain('4 no total');
    expect(txt).toContain(`${(LIMIAR_CHAMADA_LENTA_MS / 1000).toFixed(1)}s`);
  });

  it('sem alerta, não há texto', () => {
    expect(descreverLatencia({ alertar: false, motivo: 'saudavel' })).toBeNull();
  });
});
