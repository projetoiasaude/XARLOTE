import { describe, it, expect } from 'vitest';
import {
  adherenceLabel,
  adherenceScore,
  adherenceSeries,
  brDayKey,
  type DoseLogEntry,
} from '../packages/shared/src/adherence.js';

/**
 * A série e o número da adesão ao tratamento.
 *
 * O contrato que este arquivo protege é a PARIDADE com a função SQL
 * `calc_adherence_score`, que já roda em produção e alimenta
 * `users.adherence_score_30d`:
 *
 *   taken / total, onde total = TODA linha na janela (`snoozed` entra no denominador)
 *   e o resultado é NULL quando não há linha nenhuma.
 *
 * Se este módulo calculasse "melhor", o gráfico mostraria uma curva e o número do topo
 * da tela mostraria outro valor — e o paciente não teria como saber em qual acreditar.
 *
 * Os dados de exemplo espelham a distribuição REAL de produção em 11/08/2026:
 * 67 `taken`, 4 `snoozed`, 4 `skipped`.
 */

const AGORA = Date.parse('2026-08-11T15:00:00Z'); // 12:00 em Brasília
const d = (iso: string, status: string): DoseLogEntry => ({ scheduledAt: iso, status });

describe('brDayKey — o dia é o do PACIENTE, não o UTC', () => {
  it('dose das 22h de Brasília fica no dia dela, não no seguinte', () => {
    // 22h de 10/08 em Brasília = 01h UTC de 11/08. Em UTC migraria de dia e o gráfico
    // sairia torto justamente nas doses da noite — as mais comuns.
    expect(brDayKey(Date.parse('2026-08-11T01:00:00Z'))).toBe('2026-08-10');
  });

  it('dose das 2h da manhã de Brasília fica no próprio dia', () => {
    expect(brDayKey(Date.parse('2026-08-11T05:00:00Z'))).toBe('2026-08-11');
  });

  it('meia-noite e um minuto de Brasília já é o dia novo', () => {
    expect(brDayKey(Date.parse('2026-08-11T03:01:00Z'))).toBe('2026-08-11');
  });

  it('23h59 de Brasília ainda é o dia velho', () => {
    expect(brDayKey(Date.parse('2026-08-11T02:59:00Z'))).toBe('2026-08-10');
  });
});

describe('adherenceScore — paridade com calc_adherence_score', () => {
  it('taken/total, com snoozed NO DENOMINADOR', () => {
    // 2 taken de 3 registros (1 snoozed) = 0.67. Se snoozed fosse ignorado daria 1.0
    // e o gráfico discordaria do número gravado no banco.
    const e = [
      d('2026-08-11T12:00:00Z', 'taken'),
      d('2026-08-11T13:00:00Z', 'taken'),
      d('2026-08-11T14:00:00Z', 'snoozed'),
    ];
    expect(adherenceScore(e, { days: 30, nowMs: AGORA })).toBe(0.67);
  });

  it('skipped também conta no denominador', () => {
    const e = [d('2026-08-11T12:00:00Z', 'taken'), d('2026-08-11T13:00:00Z', 'skipped')];
    expect(adherenceScore(e, { days: 30, nowMs: AGORA })).toBe(0.5);
  });

  it('sem registro nenhum devolve NULL, nunca zero', () => {
    // Zero diria "não tomou os remédios"; null diz "ainda não sei". Um paciente novo
    // não pode abrir o app e ver 0% de adesão.
    expect(adherenceScore([], { days: 30, nowMs: AGORA })).toBeNull();
  });

  it('registro fora da janela é ignorado', () => {
    const e = [
      d('2026-08-11T12:00:00Z', 'taken'),
      d('2026-05-01T12:00:00Z', 'skipped'), // 100 dias atrás
    ];
    expect(adherenceScore(e, { days: 30, nowMs: AGORA })).toBe(1);
  });

  it('arredonda em 2 casas como o ROUND do Postgres', () => {
    const e = [
      d('2026-08-11T10:00:00Z', 'taken'),
      d('2026-08-11T11:00:00Z', 'taken'),
      d('2026-08-11T12:00:00Z', 'skipped'),
      d('2026-08-11T13:00:00Z', 'skipped'),
      d('2026-08-11T14:00:00Z', 'skipped'),
      d('2026-08-11T15:00:00Z', 'skipped'),
      d('2026-08-11T16:00:00Z', 'skipped'),
    ];
    // 2/7 = 0.2857… → 0.29
    expect(adherenceScore(e, { days: 30, nowMs: AGORA })).toBe(0.29);
  });

  it('distribuição real de produção (67 taken, 4 snoozed, 4 skipped) = 0.89', () => {
    const e: DoseLogEntry[] = [
      ...Array.from({ length: 67 }, () => d('2026-08-10T12:00:00Z', 'taken')),
      ...Array.from({ length: 4 }, () => d('2026-08-10T12:00:00Z', 'snoozed')),
      ...Array.from({ length: 4 }, () => d('2026-08-10T12:00:00Z', 'skipped')),
    ];
    expect(adherenceScore(e, { days: 30, nowMs: AGORA })).toBe(0.89);
  });
});

describe('adherenceSeries', () => {
  it('devolve exatamente `days` dias, do mais antigo pro mais recente', () => {
    const s = adherenceSeries([], { days: 7, nowMs: AGORA });
    expect(s).toHaveLength(7);
    expect(s[0]!.day).toBe('2026-08-05');
    expect(s[6]!.day).toBe('2026-08-11');
    // Ordem crescente é o que o eixo do gráfico espera.
    expect([...s].sort((a, b) => (a.day < b.day ? -1 : 1)).map((x) => x.day)).toEqual(s.map((x) => x.day));
  });

  it('dia SEM dose tem ratio null, NÃO zero', () => {
    // O defeito que isto impede: gráfico desenhando queda a zero em dia que não tinha
    // remédio agendado — uma queda de adesão que nunca existiu, capaz de levar um
    // médico a mudar conduta com base em nada.
    const s = adherenceSeries([d('2026-08-11T12:00:00Z', 'taken')], { days: 3, nowMs: AGORA });
    expect(s.map((x) => x.ratio)).toEqual([null, null, 1]);
    expect(s[0]!.total).toBe(0);
  });

  it('agrupa no dia de Brasília, não no UTC', () => {
    const s = adherenceSeries(
      [d('2026-08-11T01:00:00Z', 'taken')], // 22h de 10/08 em Brasília
      { days: 3, nowMs: AGORA },
    );
    const dia10 = s.find((x) => x.day === '2026-08-10')!;
    const dia11 = s.find((x) => x.day === '2026-08-11')!;
    expect(dia10.taken).toBe(1);
    expect(dia11.total).toBe(0);
  });

  it('mistura de status no mesmo dia conta certo', () => {
    const s = adherenceSeries(
      [
        d('2026-08-11T12:00:00Z', 'taken'),
        d('2026-08-11T13:00:00Z', 'skipped'),
        d('2026-08-11T14:00:00Z', 'snoozed'),
        d('2026-08-11T15:00:00Z', 'taken'),
      ],
      { days: 2, nowMs: AGORA },
    );
    const hoje = s[1]!;
    expect(hoje.taken).toBe(2);
    expect(hoje.total).toBe(4);
    expect(hoje.ratio).toBe(0.5);
  });

  it('linha com data corrompida não derruba o gráfico', () => {
    const s = adherenceSeries(
      [d('não é data', 'taken'), d('2026-08-11T12:00:00Z', 'taken')],
      { days: 1, nowMs: AGORA },
    );
    expect(s[0]!.total).toBe(1);
  });

  it('dose fora da janela não entra em dia nenhum', () => {
    const s = adherenceSeries([d('2026-01-01T12:00:00Z', 'taken')], { days: 3, nowMs: AGORA });
    expect(s.every((x) => x.total === 0)).toBe(true);
  });

  it('a soma da série bate com o score da mesma janela', () => {
    // Invariante: gráfico e número contam a MESMA história.
    const e = [
      d('2026-08-09T12:00:00Z', 'taken'),
      d('2026-08-10T12:00:00Z', 'skipped'),
      d('2026-08-11T12:00:00Z', 'taken'),
    ];
    const s = adherenceSeries(e, { days: 7, nowMs: AGORA });
    const taken = s.reduce((a, x) => a + x.taken, 0);
    const total = s.reduce((a, x) => a + x.total, 0);
    expect(Math.round((taken / total) * 100) / 100).toBe(adherenceScore(e, { days: 7, nowMs: AGORA }));
  });
});

describe('adherenceLabel — a Xarlote acompanha, não repreende', () => {
  it('sem registro não vira 0%', () => {
    expect(adherenceLabel(null)).toBe('sem registro ainda');
  });

  it('nunca usa palavra de julgamento', () => {
    for (const r of [0, 0.3, 0.5, 0.75, 0.95, 1]) {
      const txt = adherenceLabel(r).toLowerCase();
      for (const proibida of ['ruim', 'péssim', 'fracass', 'falhou', 'errado', 'mal']) {
        expect(txt).not.toContain(proibida);
      }
    }
  });

  it('mostra a porcentagem em todas as faixas', () => {
    expect(adherenceLabel(1)).toContain('100%');
    expect(adherenceLabel(0.8)).toContain('80%');
    expect(adherenceLabel(0.4)).toContain('40%');
  });
});
