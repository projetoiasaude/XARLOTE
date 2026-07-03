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
import { db, writeEvent, writeLog, listDeviceTokens, deleteDeviceTokens } from '@iasaude/db';
import { isSimulatorMode } from '@iasaude/whatsapp';
import { SARA_INSTANCE, nextOccurrence, isPlaceholderPhone } from '@iasaude/shared';
import { loadPrompts } from '../config/prompts.js';
import { sendPush } from '@iasaude/integrations';
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
  // Kill-switch por fluxo (hot-reload via /prompts) — freio de emergência sem
  // desligar a Xarlote inteira nem redeploy.
  if (!loadPrompts().reminders_enabled) return;

  const now = new Date();

  const { data: due, error } = await db
    .from('reminders')
    .select('id, user_id, type, title, body, rrule, next_run_at, users(phone_e164, preferred_name, timezone)')
    .eq('status', 'pending')
    .lte('next_run_at', now.toISOString())
    .order('next_run_at', { ascending: true }) // backlog processa em ordem, sem starvation
    .limit(50);

  if (error) {
    await writeLog('error', 'reminder', `Busca de lembretes vencidos falhou: ${error.message}`);
    return;
  }
  if (!due?.length) return;

  const STALE_MS = 45 * 60_000; // recorrente atrasado > 45min = pula (espera a próxima)

  for (const reminder of due as unknown as DueReminder[]) {
    const user = reminder.users;
    if (!user?.phone_e164) continue;

    // Número de TESTE/placeholder (ex: usuária Marina do simulador): auto-cancela
    // o lembrete-zumbi na 1ª passada — senão claim+mirror+envio-bloqueado se
    // repetem TODO dia pra sempre, poluindo o alerta de "possível ban".
    if (isPlaceholderPhone(user.phone_e164)) {
      await db.from('reminders').update({ status: 'cancelled' }).eq('id', reminder.id);
      await writeLog('warn', 'reminder', `lembrete cancelado — telefone placeholder/teste (${user.phone_e164})`, {});
      continue;
    }

    // 1. Claim: recorrente avança pro próximo disparo e CONTINUA pending;
    //    one-shot vira `sent`. Filtro por next_run_at = claim otimista
    //    (se outra réplica já avançou a row, 0 linhas mudam e pulamos).
    // Recorrência calculada no FUSO DO USUÁRIO (default Brasília) — "8h30" tem
    // que ser 8h30 onde a pessoa mora, não onde o servidor roda.
    const userTz = (user as { timezone?: string | null }).timezone || undefined;
    const next = reminder.rrule ? nextOccurrence(reminder.rrule, now, userTz) : null;
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

    // STALENESS: após downtime longo, um recorrente MUITO atrasado ("remédio das
    // 8h" chegando 14h) é pior que não chegar (dose fora de hora). Claim já avançou
    // pro próximo disparo; aqui só pulamos o ENVIO desta ocorrência velha. One-shot
    // atrasado ainda envia (é a única chance dele).
    const lateMs = now.getTime() - new Date(reminder.next_run_at).getTime();
    if (reminder.rrule && lateMs > STALE_MS) {
      await writeLog('warn', 'reminder', `lembrete recorrente pulado — atrasado ${Math.round(lateMs / 60000)}min (aguarda próxima ocorrência)`, {});
      continue;
    }

    const name = user.preferred_name ?? 'você';
    // body:"" (string vazia que a LLM às vezes manda) NÃO é null → `?? fallback`
    // não pega e o WhatsApp recebia mensagem VAZIA (rejeitada). Trata vazio.
    const msg = reminder.body?.trim() ? reminder.body : `Ei ${name}, lembrete: ${reminder.title} 💊`;

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

    // 4. Push pro app nativo (acorda mesmo com o app fechado). No-op se FCM
    //    não configurado; tokens mortos são limpos. Abre direto no chat.
    try {
      const tokens = await listDeviceTokens(reminder.user_id);
      if (tokens.length) {
        const title = reminder.type === 'medication' ? '💊 Hora do remédio' : 'Xarlote';
        const result = await sendPush(tokens, {
          title,
          body: msg,
          data: { kind: 'reminder', reminder_id: reminder.id, route: '/app' },
        });
        if (result.invalidTokens.length) await deleteDeviceTokens(result.invalidTokens);
      }
    } catch (err) {
      await writeLog('warn', 'reminder', `push falhou: ${String(err).slice(0, 120)}`, { traceId: undefined });
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
