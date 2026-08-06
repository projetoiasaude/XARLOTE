import { describe, it, expect } from 'vitest';
import { reminderActionPatch } from '../packages/shared/src/reminder-actions.js';

/**
 * Blinda a máquina de estados das ações de lembrete do app (feito/+30min/cancelar),
 * extraída de apps/api/src/routes/app.ts pra reuso app nativo + web.
 *
 * PARIDADE OBRIGATÓRIA com o comportamento em produção:
 *   • cancelado é terminal (done/snooze → reject; cancel de novo → ok)
 *   • done em recorrente reagenda e segue pending (acknowledged mataria a recorrência)
 *   • done grava last_confirmed_at (destrava o gate do backup condicional — 0020)
 *   • snooze default 30min, clampado em 5min–24h
 */

const AGORA = Date.parse('2026-08-06T12:00:00Z');
const PROXIMA = '2026-08-07T10:00:00.000Z';

describe('done', () => {
  it('recorrente: reagenda pra próxima ocorrência e SEGUE pending', () => {
    const d = reminderActionPatch(
      { status: 'pending', rrule: 'FREQ=DAILY;BYHOUR=7', nextRecurringIso: PROXIMA },
      'done', undefined, AGORA,
    );
    expect(d.kind).toBe('apply');
    if (d.kind === 'apply') {
      expect(d.patch['status']).toBe('pending');
      expect(d.patch['next_run_at']).toBe(PROXIMA);
      expect(d.patch['last_confirmed_at']).toBe(new Date(AGORA).toISOString());
      expect(d.patch['last_run_at']).toBe(new Date(AGORA).toISOString());
    }
  });

  it('one-shot: vira acknowledged com last_confirmed_at', () => {
    const d = reminderActionPatch({ status: 'pending', rrule: null, nextRecurringIso: null }, 'done', undefined, AGORA);
    expect(d.kind).toBe('apply');
    if (d.kind === 'apply') {
      expect(d.patch['status']).toBe('acknowledged');
      expect(d.patch['last_confirmed_at']).toBe(new Date(AGORA).toISOString());
    }
  });
});

describe('snooze', () => {
  it('default 30 minutos', () => {
    const d = reminderActionPatch({ status: 'pending', rrule: null, nextRecurringIso: null }, 'snooze', undefined, AGORA);
    expect(d.kind).toBe('apply');
    if (d.kind === 'apply') expect(d.patch['next_run_at']).toBe(new Date(AGORA + 30 * 60_000).toISOString());
  });

  it('clampa abaixo de 5min e acima de 24h', () => {
    const baixo = reminderActionPatch({ status: 'pending', rrule: null, nextRecurringIso: null }, 'snooze', 1, AGORA);
    if (baixo.kind === 'apply') expect(baixo.patch['next_run_at']).toBe(new Date(AGORA + 5 * 60_000).toISOString());
    const alto = reminderActionPatch({ status: 'pending', rrule: null, nextRecurringIso: null }, 'snooze', 99999, AGORA);
    if (alto.kind === 'apply') expect(alto.patch['next_run_at']).toBe(new Date(AGORA + 24 * 60 * 60_000).toISOString());
  });
});

describe('🔴 cancelado é TERMINAL', () => {
  it('done num cancelado → reject (não ressuscita)', () => {
    const d = reminderActionPatch({ status: 'cancelled', rrule: null, nextRecurringIso: null }, 'done', undefined, AGORA);
    expect(d).toEqual({ kind: 'reject', reason: 'cancelled_is_terminal' });
  });
  it('snooze num cancelado → reject', () => {
    const d = reminderActionPatch({ status: 'cancelled', rrule: null, nextRecurringIso: null }, 'snooze', 30, AGORA);
    expect(d.kind).toBe('reject');
  });
  it('cancel de novo → aceito (paciente tocou 2x, idempotência barata)', () => {
    const d = reminderActionPatch({ status: 'cancelled', rrule: null, nextRecurringIso: null }, 'cancel', undefined, AGORA);
    expect(d.kind).toBe('apply');
    if (d.kind === 'apply') expect(d.patch['status']).toBe('cancelled');
  });
});
