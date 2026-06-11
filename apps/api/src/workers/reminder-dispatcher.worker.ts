/**
 * Despachante de lembretes proativos — a Xarlote "acorda" e fala primeiro.
 *
 * A cada tick (30s, sob cron-lock) pega lembretes `pending` vencidos e:
 *   1. RECLAMA a row primeiro (avança next_run_at pelo rrule, ou marca `sent`
 *      se for one-shot) — claim-before-send garante no-máximo-um envio mesmo
 *      se o processo cair no meio (lembrete duplicado de remédio é pior que
 *      um raro lembrete perdido).
 *   2. Espelha a mensagem na conversa canônica (messages INSERT) → o app
 *      recebe via Supabase Realtime na hora, como qualquer fala da Xarlote.
 *   3. Envia pro WhatsApp REAL via fila outbound (rate-limit — CLAUDE.md §5).
 *
 * Recorrência: BYHOUR/BYMINUTE do rrule são SEMPRE horário de Brasília
 * (contrato com a LLM) — ver packages/shared/src/rrule.ts.
 */
import { db, writeEvent, writeLog } from '@iasaude/db';
import { isSimulatorMode } from '@iasaude/whatsapp';
import { SARA_INSTANCE, nextOccurrence } from '@iasaude/shared';
import { dispatchOutbound } from '../queues/outbound.queue.js';

interface DueReminder {
  id: string;
  user_id: string;
  type: string;
  title: string;
  body: string | null;
  rrule: string | null;
  next_run_at: string;
  users: { phone_e164: string | null; preferred_name: string | null } | null;
}

export async function dispatchReminders(): Promise<void> {
  const now = new Date();

  const { data: due, error } = await db
    .from('reminders')
    .select('id, user_id, type, title, body, rrule, next_run_at, users(phone_e164, preferred_name)')
    .eq('status', 'pending')
    .lte('next_run_at', now.toISOString())
    .limit(50);

  if (error) {
    await writeLog('error', 'reminder', `Busca de lembretes vencidos falhou: ${error.message}`);
    return;
  }
  if (!due?.length) return;

  for (const reminder of due as unknown as DueReminder[]) {
    const user = reminder.users;
    if (!user?.phone_e164) continue;

    // 1. Claim: recorrente avança pro próximo disparo e CONTINUA pending;
    //    one-shot vira `sent`. Filtro por next_run_at = claim otimista
    //    (se outra réplica já avançou a row, 0 linhas mudam e pulamos).
    const next = reminder.rrule ? nextOccurrence(reminder.rrule, now) : null;
    const claim = next
      ? { next_run_at: next.toISOString(), last_run_at: now.toISOString() }
      : { status: 'sent', last_run_at: now.toISOString() };

    const { data: claimed } = await db
      .from('reminders')
      .update(claim)
      .eq('id', reminder.id)
      .eq('status', 'pending')
      .eq('next_run_at', reminder.next_run_at)
      .select('id');
    if (!claimed?.length) continue;

    const name = user.preferred_name ?? 'você';
    const msg = reminder.body ?? `Ei ${name}, lembrete: ${reminder.title} 💊`;

    // 2. Espelha na conversa canônica (mesma do WhatsApp) → app vê via realtime.
    const { data: conv } = await db
      .from('conversations')
      .select('id')
      .eq('party_type', 'user')
      .eq('user_id', reminder.user_id)
      .eq('whatsapp_instance', SARA_INSTANCE)
      .order('last_message_at', { ascending: false, nullsFirst: false })
      .limit(1)
      .maybeSingle();

    if (conv) {
      await db.from('messages').insert({
        conversation_id: conv.id,
        direction: 'out',
        sender_role: 'assistant',
        content_type: 'text',
        content: msg,
      });
      await db.from('conversations').update({ last_message_at: now.toISOString() }).eq('id', conv.id);
    }

    // 3. WhatsApp real, SEMPRE pela fila (rate-limit anti-ban).
    if (!isSimulatorMode()) {
      await dispatchOutbound({
        kind: 'text',
        instance: SARA_INSTANCE,
        phoneE164: user.phone_e164,
        text: msg,
      });
    }

    void writeEvent({
      eventName: 'reminder.dispatched',
      userId: reminder.user_id,
      conversationId: conv?.id,
      payload: {
        reminder_id: reminder.id,
        type: reminder.type,
        recurring: Boolean(reminder.rrule),
        next_run_at: next?.toISOString() ?? null,
        mirrored_to_app: Boolean(conv),
      },
    });
  }
}
