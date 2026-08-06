/**
 * reminder-actions — a máquina de estados das ações de lembrete do APP
 * (feito / +30min / cancelar). PURA: `nowMs` injetado, zero I/O.
 *
 * Extraída de `apps/api/src/routes/app.ts` (rota POST /app/reminders/:id/action)
 * para que o app nativo e o web usem EXATAMENTE a mesma regra — e para que ela
 * seja testável sem banco. Comportamentos que NÃO podem regredir:
 *
 *   • Cancelado é TERMINAL: done/snooze não ressuscitam (cancel de novo é no-op OK).
 *   • "done" num RECORRENTE = concluiu o de hoje → reagenda a próxima ocorrência e
 *     segue `pending` (marcar `acknowledged` mataria a recorrência).
 *   • "done" grava `last_confirmed_at` — é o que destrava o gate do backup
 *     condicional (migration 0020: o reforço só dispara se o primário NÃO foi
 *     confirmado).
 *   • "snooze" default 30min, aceitando 5min–24h.
 */

export type ReminderAppAction = 'done' | 'snooze' | 'cancel';

export interface ReminderActionInput {
  status: string;
  rrule: string | null;
  /** Próxima ocorrência JÁ resolvida pelo chamador quando há rrule (nextOccurrence). */
  nextRecurringIso: string | null;
}

export type ReminderActionDecision =
  | { kind: 'reject'; reason: 'cancelled_is_terminal' }
  | { kind: 'apply'; patch: Record<string, unknown> };

/**
 * Decide o patch a aplicar no lembrete para uma ação do paciente.
 *
 * O chamador resolve `nextRecurringIso` (precisa do rrule parser) e aplica o patch
 * no banco; esta função só DECIDE — é a parte que precisa estar certa em qualquer
 * cliente e em qualquer escala.
 */
export function reminderActionPatch(
  reminder: ReminderActionInput,
  action: ReminderAppAction,
  minutes: number | undefined,
  nowMs: number,
): ReminderActionDecision {
  // Cancelado é terminal: done/snooze não ressuscitam. Cancelar de novo é aceito
  // (idempotência barata — o paciente tocou duas vezes).
  if (reminder.status === 'cancelled' && action !== 'cancel') {
    return { kind: 'reject', reason: 'cancelled_is_terminal' };
  }

  const nowIso = new Date(nowMs).toISOString();

  if (action === 'done') {
    if (reminder.rrule && reminder.nextRecurringIso) {
      return {
        kind: 'apply',
        patch: {
          status: 'pending',
          next_run_at: reminder.nextRecurringIso,
          last_run_at: nowIso,
          last_confirmed_at: nowIso,
        },
      };
    }
    return { kind: 'apply', patch: { status: 'acknowledged', last_confirmed_at: nowIso } };
  }

  if (action === 'cancel') {
    return { kind: 'apply', patch: { status: 'cancelled' } };
  }

  // snooze — clampa no contrato da rota (5min a 24h) mesmo se o chamador vacilar.
  const mins = Math.min(Math.max(minutes ?? 30, 5), 24 * 60);
  return {
    kind: 'apply',
    patch: {
      status: 'pending',
      next_run_at: new Date(nowMs + mins * 60_000).toISOString(),
    },
  };
}
