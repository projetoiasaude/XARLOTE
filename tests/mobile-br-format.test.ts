import { describe, it, expect } from 'vitest';
import {
  brData,
  brDataLonga,
  brDesde,
  brDeitico,
  brDiaMes,
  brHora,
  brMesAno,
  brQuando,
  diaBrt,
  diffDiasBrt,
  msDe,
} from '../apps/mobile/src/lib/br-format.js';

/**
 * Datas em PT-BR no fuso do paciente.
 *
 * O que este arquivo existe pra impedir é um defeito que já custou caro no projeto por
 * outro caminho (o dêitico congelado do caso Elizabeth, 09/07): **rótulo de tempo
 * errado num app de medicação**. Aqui a tradução é direta — se "amanhã às 7h" aparecer
 * como "hoje às 7h", alguém toma remédio no dia errado.
 *
 * Todos os casos usam instantes UTC explícitos, porque o bug clássico é justamente a
 * função ler o fuso da MÁQUINA. Rodando este arquivo em qualquer TZ o resultado é o
 * mesmo — é o que prova que o -03:00 fixo está sendo aplicado de verdade.
 */

// 05/08/2026 às 14:30 UTC = 11:30 em Brasília.
const T = Date.parse('2026-08-05T14:30:00.000Z');

describe('msDe', () => {
  it('recusa entrada em que não se pode confiar em vez de chutar', () => {
    expect(msDe(null)).toBeNull();
    expect(msDe(undefined)).toBeNull();
    expect(msDe('')).toBeNull();
    expect(msDe('não é data')).toBeNull();
    expect(msDe('2026-08-05T14:30:00.000Z')).toBe(T);
  });
});

describe('conversão pro fuso de Brasília', () => {
  it('lê a hora em Brasília, não em UTC nem no fuso da máquina', () => {
    expect(brHora('2026-08-05T14:30:00.000Z')).toBe('11:30');
    expect(brData('2026-08-05T14:30:00.000Z')).toBe('05/08/2026');
    expect(brDiaMes('2026-08-05T14:30:00.000Z')).toBe('05/08');
    expect(brDataLonga('2026-08-05T14:30:00.000Z')).toBe('5 de agosto de 2026');
    expect(brMesAno('2026-08-05T14:30:00.000Z')).toBe('ago/2026');
  });

  it('a dose das 22h de Goiânia NÃO migra pro dia seguinte', () => {
    // 01:00 UTC do dia 06 é 22:00 do dia 05 em Brasília. Contado em UTC, o remédio da
    // noite apareceria no gráfico do dia seguinte — foi o motivo do deslocamento fixo.
    expect(diaBrt(Date.parse('2026-08-06T01:00:00.000Z'))).toBe('2026-08-05');
    expect(brHora('2026-08-06T01:00:00.000Z')).toBe('22:00');
  });

  it('usa a MESMA chave de dia que o cálculo de adesão em shared', () => {
    // Se estas duas divergissem, o gráfico e o rótulo da mesma tela contariam dias
    // diferentes. A igualdade é o contrato — não coincidência.
    expect(diaBrt(T)).toBe('2026-08-05');
  });

  it('coluna DATE (sem hora) NÃO retrocede um dia', () => {
    // `Date.parse('2026-08-01')` é meia-noite UTC = 21h do dia 31/07 em BRT. Sem a
    // âncora em Brasília, TODO exame do dia 1º aparecia no mês anterior — a biblioteca
    // agrupava um exame de agosto sob "jul/2026". Bug real, pego por teste.
    expect(brData('2026-08-01')).toBe('01/08/2026');
    expect(brMesAno('2026-08-01')).toBe('ago/2026');
    expect(brDiaMes('2026-01-01')).toBe('01/01');
    expect(brDataLonga('2026-03-01')).toBe('1 de março de 2026');
  });

  it('timestamptz com hora segue sendo instante real, sem âncora nenhuma', () => {
    // A correção acima vale SÓ pra data-sem-hora. `next_run_at` tem instante e não pode
    // ganhar 3 horas de brinde — seria remédio marcado pra hora errada.
    expect(brHora('2026-08-01T00:00:00.000Z')).toBe('21:00');
    expect(brData('2026-08-01T00:00:00.000Z')).toBe('31/07/2026');
  });

  it('ISO inválido devolve string vazia, nunca "Invalid Date" nem hoje', () => {
    expect(brHora('lixo')).toBe('');
    expect(brData(null)).toBe('');
    expect(brDataLonga(undefined)).toBe('');
  });
});

describe('diffDiasBrt — dias de calendário, não blocos de 24h', () => {
  it('às 23h, o remédio das 7h da manhã seguinte é AMANHÃ (8h de distância)', () => {
    const agora = Date.parse('2026-08-06T02:00:00.000Z'); // 23:00 do dia 05 em BRT
    const alvo = Date.parse('2026-08-06T10:00:00.000Z'); //  07:00 do dia 06 em BRT
    expect(alvo - agora).toBeLessThan(24 * 60 * 60 * 1000);
    expect(diffDiasBrt(alvo, agora)).toBe(1);
    expect(brDeitico(alvo, agora)).toBe('amanhã');
  });

  it('a 25 horas de distância pode ser AMANHÃ também', () => {
    const agora = Date.parse('2026-08-05T13:00:00.000Z'); // 10:00 BRT dia 05
    const alvo = Date.parse('2026-08-06T14:00:00.000Z'); //  11:00 BRT dia 06
    expect(alvo - agora).toBeGreaterThan(24 * 60 * 60 * 1000);
    expect(diffDiasBrt(alvo, agora)).toBe(1);
  });

  it('cobre a janela dêitica e sai dela em silêncio', () => {
    expect(brDeitico(T, T)).toBe('hoje');
    expect(brDeitico(T + 86_400_000, T)).toBe('amanhã');
    expect(brDeitico(T + 2 * 86_400_000, T)).toBe('depois de amanhã');
    expect(brDeitico(T - 86_400_000, T)).toBe('ontem');
    expect(brDeitico(T + 3 * 86_400_000, T)).toBeNull();
    expect(brDeitico(T - 2 * 86_400_000, T)).toBeNull();
  });
});

describe('brQuando — como a Xarlote falaria', () => {
  it('usa dêitico dentro da janela e dia da semana fora dela', () => {
    expect(brQuando('2026-08-05T11:00:00.000Z', T)).toBe('hoje às 08:00');
    expect(brQuando('2026-08-06T10:30:00.000Z', T)).toBe('amanhã às 07:30');
    // 22/08/2026 é um sábado.
    expect(brQuando('2026-08-22T12:00:00.000Z', T)).toBe('sáb, 22/08 às 09:00');
  });

  it('sem data não inventa frase', () => {
    expect(brQuando(null, T)).toBe('');
  });
});

describe('brDesde — quanto tempo faz', () => {
  it('degrada de minutos pra data absoluta na ordem certa', () => {
    expect(brDesde(new Date(T - 10_000).toISOString(), T)).toBe('agora');
    expect(brDesde(new Date(T - 5 * 60_000).toISOString(), T)).toBe('há 5 min');
    expect(brDesde(new Date(T - 3 * 3_600_000).toISOString(), T)).toBe('há 3 h');
    expect(brDesde('2026-08-04T14:30:00.000Z', T)).toBe('ontem');
    expect(brDesde('2026-08-01T14:30:00.000Z', T)).toBe('há 4 dias');
    // Além de uma semana, "há 34 dias" não diz nada — a data seca diz.
    expect(brDesde('2026-06-30T14:30:00.000Z', T)).toBe('30/06/2026');
  });

  it('relógio do aparelho adiantado nunca produz tempo negativo', () => {
    // Futuro por 30s (clock skew) tem que dizer 'agora', não 'em -1 min'.
    expect(brDesde(new Date(T + 30_000).toISOString(), T)).toBe('agora');
  });

  it('atravessa a meia-noite sem chamar de "há 2 h" o que já é ontem', () => {
    const agora = Date.parse('2026-08-06T04:00:00.000Z'); // 01:00 BRT do dia 06
    const antes = '2026-08-06T02:00:00.000Z'; //              23:00 BRT do dia 05
    // Duas horas de distância, mas dia de calendário diferente → 'ontem'.
    expect(brDesde(antes, agora)).toBe('ontem');
  });
});
