/**
 * O texto da cotação nas grandes redes (modo "entrega na hora", 24/09/2026).
 *
 * Os casos saíram da medição ao vivo com um CEP do Setor Central de Goiânia: a Drogaria
 * São Paulo retira em lojas "Drogarias Pacheco" (mesmo grupo) a 1,6 km; a Pague Menos,
 * na loja da Av. Goiás a 350 m; a amoxicilina só tinha entrega em 1 dia útil, mas
 * retirada em 60 min.
 */
import { describe, it, expect } from 'vitest';
import {
  formatarDistancia,
  ondeRetirar,
  seloDePrazo,
  linhaDeLogistica,
  podeDizerPertinho,
  type CotacaoApresentavel,
} from '../packages/shared/src/entrega-na-hora.js';

const DIA = 24 * 60;
const lojaPacheco = { name: 'Drogarias Pacheco - Filial Republica Do Libano 2', address: 'Avenida República do Líbano, Setor Oeste', distanceKm: 1.6 };
const lojaPagueMenos = { name: 'Pague Menos - Av. Goiás, 415 (Loja 304)', address: 'Avenida Goiás, Setor Central', distanceKm: 0.35 };

function cot(p: Partial<CotacaoApresentavel> & { networkLabel: string }): CotacaoApresentavel {
  return { lines: [1], total: 14.99, delivery: null, pickup: null, ...p };
}

describe('formatarDistancia', () => {
  it('metros abaixo de 1 km, uma casa entre 1 e 10 km, inteiro acima', () => {
    expect(formatarDistancia(0.35)).toBe('350 m');
    expect(formatarDistancia(0.02)).toBe('50 m');
    expect(formatarDistancia(1.6)).toBe('1,6 km');
    expect(formatarDistancia(12.3)).toBe('12 km');
  });
});

describe('ondeRetirar — a loja como o checkout lista (nome da filial + endereço + distância)', () => {
  it('nome que já traz a rua → só o nome e a distância (sem repetir o endereço)', () => {
    expect(ondeRetirar(lojaPagueMenos)).toBe(' na *Pague Menos - Av. Goiás, 415 (Loja 304)* (350 m)');
    expect(ondeRetirar(lojaPacheco)).toBe(' na *Drogarias Pacheco - Filial Republica Do Libano 2* (1,6 km)');
  });

  it('duas filiais na MESMA avenida viram textos DIFERENTES (revisão 24/09: Pacheco Setor Bueno × Setor Bueno 9)', () => {
    const a = ondeRetirar({ name: 'Drogarias Pacheco - Filial Setor Bueno', address: 'Avenida T-63, 1830, Setor Bueno', distanceKm: 4.8 });
    const b = ondeRetirar({ name: 'Drogarias Pacheco - Filial Setor Bueno 9', address: 'Avenida T-63, 2440, Setor Bueno', distanceKm: 5.3 });
    expect(a).not.toBe(b);
    expect(a).toBe(' na *Drogarias Pacheco - Filial Setor Bueno* — Avenida T-63, 1830, Setor Bueno (4,8 km)');
  });

  it('a marca da FACHADA aparece (a DSP de Goiânia retira em lojas Pacheco)', () => {
    expect(ondeRetirar(lojaPacheco)).toContain('Drogarias Pacheco');
  });

  it('fachada de rede IRMÃ é explicada — só quando o registro marcou (Extrafarma → Pague Menos)', () => {
    expect(ondeRetirar({ ...lojaPagueMenos, marcaDoGrupo: 'Pague Menos' })).toBe(' na *Pague Menos - Av. Goiás, 415 (Loja 304)* (350 m) — loja do mesmo grupo');
    expect(ondeRetirar({ ...lojaPacheco, marcaDoGrupo: 'Drogaria Pacheco' })).toContain('— loja do mesmo grupo');
    expect(ondeRetirar(lojaPacheco)).not.toContain('mesmo grupo');
  });


  it('rua curta/numérica não "casa" por acaso dentro do nome — o endereço vai junto', () => {
    expect(ondeRetirar({ name: 'Pague Menos - Loja 104', address: 'Rua 10, Setor Sul', distanceKm: 0.97 }))
      .toBe(' na *Pague Menos - Loja 104* — Rua 10, Setor Sul (970 m)');
  });

  it('sem endereço usa só o nome; sem distância, não inventa uma', () => {
    expect(ondeRetirar({ name: 'Pague Menos - Loja 12', address: null, distanceKm: null })).toBe(' na *Pague Menos - Loja 12*');
  });

  it('sem loja informada → vazio (nada de endereço inventado)', () => {
    expect(ondeRetirar(null)).toBe('');
    expect(ondeRetirar(undefined)).toBe('');
  });
});

describe('seloDePrazo — a manchete é o jeito mais rápido de ter o remédio', () => {
  it('entrega rápida', () => {
    const q = cot({ networkLabel: 'Pague Menos', delivery: { etaText: '60 min', feeReais: 7.9, etaMinutes: 60 } });
    expect(seloDePrazo(q)).toBe('⚡ chega em 60 min');
  });

  it('retirada rápida vence entrega lenta (amoxicilina)', () => {
    const q = cot({
      networkLabel: 'Pague Menos',
      delivery: { etaText: '1 dia útil', feeReais: 2.45, etaMinutes: DIA },
      pickup: { etaText: '60 min', feeReais: 0, etaMinutes: 60, store: lojaPagueMenos },
    });
    expect(seloDePrazo(q)).toBe('⚡ retire em 60 min');
  });

  it('lento continua dizendo o prazo, sem raio', () => {
    const q = cot({ networkLabel: 'Drogal', delivery: { etaText: '4 dias úteis', feeReais: 10.57, etaMinutes: 4 * DIA } });
    expect(seloDePrazo(q)).toBe('chega em 4 dias úteis');
  });

  it('sem nenhuma opção conhecida → "confira o prazo no site", NUNCA "sem entrega pro seu CEP"', () => {
    // Quase sempre é simulação que não rodou (429/timeout) ou rede que não simula por CEP.
    expect(seloDePrazo(cot({ networkLabel: 'São João' }))).toBe('confira o prazo no site');
  });

  it('"no mesmo dia útil" não vira "chega em no mesmo dia útil"', () => {
    const q = cot({ networkLabel: 'X', delivery: { etaText: 'no mesmo dia útil', feeReais: 5, etaMinutes: 480 } });
    expect(seloDePrazo(q)).toBe('chega no mesmo dia útil');
  });
});

describe('linhaDeLogistica — a opção mais rápida primeiro, e ONDE retirar', () => {
  it('Drogaria São Paulo: entrega 90 min, ou retire em 30 min na Pacheco a 1,6 km', () => {
    const q = cot({
      networkLabel: 'Drogaria São Paulo',
      delivery: { etaText: '90 min', feeReais: 7.9, etaMinutes: 90 },
      pickup: { etaText: '30 min', feeReais: 0, etaMinutes: 30, store: { ...lojaPacheco, marcaDoGrupo: 'Drogaria Pacheco' } },
    });
    expect(linhaDeLogistica(q)).toBe(
      'entrega em 90 min (R$ 7,90) · ou retire em 30 min na *Drogarias Pacheco - Filial Republica Do Libano 2* (1,6 km) — loja do mesmo grupo',
    );
  });

  it('amoxicilina: a retirada em 60 min vem ANTES da entrega de 1 dia útil', () => {
    const q = cot({
      networkLabel: 'Pague Menos',
      delivery: { etaText: '1 dia útil', feeReais: 2.45, etaMinutes: DIA },
      pickup: { etaText: '60 min', feeReais: 0, etaMinutes: 60, store: lojaPagueMenos },
    });
    expect(linhaDeLogistica(q)).toBe(
      'retire em 60 min na *Pague Menos - Av. Goiás, 415 (Loja 304)* (350 m) · ou entrega em 1 dia útil (R$ 2,45)',
    );
  });

  it('frete zero aparece como "grátis"', () => {
    const q = cot({ networkLabel: 'Pague Menos', delivery: { etaText: '2 horas', feeReais: 0, etaMinutes: 120 } });
    expect(linhaDeLogistica(q)).toBe('entrega em 2 horas grátis');
  });
});

describe('podeDizerPertinho — só com prova', () => {
  it('entrega em até 4h prova que a loja é local', () => {
    expect(podeDizerPertinho([cot({ networkLabel: 'X', delivery: { etaText: '90 min', feeReais: 7.9, etaMinutes: 90 } })])).toBe(true);
  });

  it('retirada rápida perto prova; longe não', () => {
    const perto = cot({ networkLabel: 'X', pickup: { etaText: '60 min', feeReais: 0, etaMinutes: 60, store: lojaPagueMenos } });
    const longe = cot({ networkLabel: 'X', pickup: { etaText: '60 min', feeReais: 0, etaMinutes: 60, store: { ...lojaPagueMenos, distanceKm: 32 } } });
    expect(podeDizerPertinho([perto])).toBe(true);
    expect(podeDizerPertinho([longe])).toBe(false);
  });

  it('só entrega em dias (de outro estado) NÃO é pertinho — era o que a mensagem dizia', () => {
    expect(podeDizerPertinho([cot({ networkLabel: 'Catarinense', delivery: { etaText: '11 dias úteis', feeReais: 30.35, etaMinutes: 11 * DIA } })])).toBe(false);
  });

  it('retirada sem distância informada não conta como prova', () => {
    const semDist = cot({ networkLabel: 'X', pickup: { etaText: '60 min', feeReais: 0, etaMinutes: 60, store: { ...lojaPagueMenos, distanceKm: null } } });
    expect(podeDizerPertinho([semDist])).toBe(false);
  });
});
