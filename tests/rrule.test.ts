import { describe, expect, it } from 'vitest';
import { nextOccurrence, parseRrule, resolveReminderFirstRun } from '../packages/shared/src/rrule.js';

// Brasília = UTC-3 (sem DST desde 2019): 8h BRT = 11h UTC.

describe('parseRrule', () => {
  it('parseia DAILY com BYHOUR/BYMINUTE', () => {
    expect(parseRrule('FREQ=DAILY;BYHOUR=8;BYMINUTE=30')).toEqual({
      freq: 'DAILY',
      interval: 1,
      byHour: 8,
      byMinute: 30,
    });
  });

  it('parseia WEEKLY com BYDAY', () => {
    expect(parseRrule('FREQ=WEEKLY;BYDAY=MO,WE;BYHOUR=9')).toMatchObject({
      freq: 'WEEKLY',
      byDays: [1, 3],
      byHour: 9,
    });
  });

  it('aceita prefixo RRULE: e campos fora de ordem', () => {
    expect(parseRrule('RRULE:BYHOUR=7;FREQ=DAILY')).toMatchObject({ freq: 'DAILY', byHour: 7 });
  });

  it('rejeita lixo', () => {
    expect(parseRrule('qualquer coisa')).toBeNull();
    expect(parseRrule('FREQ=YEARLY')).toBeNull();
  });
});

describe('nextOccurrence — horário de Brasília', () => {
  it('DAILY BYHOUR=8 disparado às 8h BRT → amanhã 8h BRT (11h UTC)', () => {
    const from = new Date('2026-06-11T11:00:15Z'); // 8h00m15s BRT
    const next = nextOccurrence('FREQ=DAILY;BYHOUR=8;BYMINUTE=0', from);
    expect(next?.toISOString()).toBe('2026-06-12T11:00:00.000Z');
  });

  it('DAILY BYHOUR=20 consultado de manhã → hoje mesmo às 20h BRT', () => {
    const from = new Date('2026-06-11T12:00:00Z'); // 9h BRT
    const next = nextOccurrence('FREQ=DAILY;BYHOUR=20;BYMINUTE=0', from);
    expect(next?.toISOString()).toBe('2026-06-11T23:00:00.000Z');
  });

  it('DAILY;INTERVAL=2 pula um dia', () => {
    const from = new Date('2026-06-11T11:00:15Z');
    const next = nextOccurrence('FREQ=DAILY;INTERVAL=2;BYHOUR=8;BYMINUTE=0', from);
    expect(next?.toISOString()).toBe('2026-06-13T11:00:00.000Z');
  });

  it('HOURLY;INTERVAL=2 avança 2h do disparo (segundos zerados)', () => {
    const from = new Date('2026-06-11T14:00:10Z');
    const next = nextOccurrence('FREQ=HOURLY;INTERVAL=2', from);
    expect(next?.toISOString()).toBe('2026-06-11T16:00:00.000Z');
  });

  it('WEEKLY BYDAY=MO acha a próxima segunda às 9h BRT', () => {
    // 2026-06-11 é quinta. Próxima segunda = 2026-06-15.
    const from = new Date('2026-06-11T11:00:00Z');
    const next = nextOccurrence('FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0', from);
    expect(next?.toISOString()).toBe('2026-06-15T12:00:00.000Z');
  });

  it('MONTHLY BYMONTHDAY=31 pula meses curtos', () => {
    const from = new Date('2026-01-31T15:00:01Z'); // 31/jan 12h00m01s BRT
    const next = nextOccurrence('FREQ=MONTHLY;BYMONTHDAY=31;BYHOUR=12;BYMINUTE=0', from);
    expect(next?.toISOString()).toBe('2026-03-31T15:00:00.000Z'); // fevereiro não tem 31
  });

  it('sem BYHOUR mantém a hora do from (não inventa default)', () => {
    const from = new Date('2026-06-11T11:10:00Z'); // 8h10 BRT
    const next = nextOccurrence('FREQ=DAILY', from);
    expect(next?.toISOString()).toBe('2026-06-12T11:10:00.000Z');
  });

  it('retorna null pra rrule inválido', () => {
    expect(nextOccurrence('FREQ=YEARLY;BYHOUR=8')).toBeNull();
  });
});

describe('resolveReminderFirstRun — footgun da string vazia (incidente Antônia Flávia)', () => {
  const from = new Date('2026-07-02T11:00:15Z'); // 8h00m15s BRT

  it('scheduled_at="" + rrule válido NÃO recusa — calcula pelo rrule', () => {
    // O bug real: `"" ?? x` devolve `""`; nextOccurrence nunca era chamado.
    const first = resolveReminderFirstRun('', 'FREQ=DAILY;BYHOUR=8;BYMINUTE=30', from);
    expect(first).toBe('2026-07-02T11:30:00.000Z');
  });

  it('scheduled_at só-espaços é tratado como ausente', () => {
    const first = resolveReminderFirstRun('   ', 'FREQ=DAILY;BYHOUR=20;BYMINUTE=0', from);
    expect(first).toBe('2026-07-02T23:00:00.000Z');
  });

  it('scheduled_at real prevalece sobre o rrule', () => {
    const first = resolveReminderFirstRun('2026-08-01T13:00:00.000Z', 'FREQ=DAILY;BYHOUR=8', from);
    expect(first).toBe('2026-08-01T13:00:00.000Z');
  });

  it('rrule="" e scheduled_at="" → null (nada utilizável)', () => {
    expect(resolveReminderFirstRun('', '', from)).toBeNull();
    expect(resolveReminderFirstRun(undefined, undefined, from)).toBeNull();
  });

  it('rrule vazio mas scheduled_at válido → usa o scheduled_at', () => {
    expect(resolveReminderFirstRun('2026-07-05T10:00:00.000Z', '', from)).toBe('2026-07-05T10:00:00.000Z');
  });

  it('resultado é sempre estritamente no futuro', () => {
    const from = new Date('2026-06-11T11:00:00Z'); // exatamente 8h BRT
    const next = nextOccurrence('FREQ=DAILY;BYHOUR=8;BYMINUTE=0', from);
    expect(next!.getTime()).toBeGreaterThan(from.getTime());
  });
});
