import { db } from '@iasaude/db';
import { sendText } from '@iasaude/whatsapp';
import { isSimulatorMode } from '@iasaude/whatsapp';
import { SARA_INSTANCE } from '@iasaude/shared';

export async function dispatchReminders(): Promise<void> {
  const now = new Date().toISOString();

  const { data: due, error } = await db
    .from('reminders')
    .select('*, users(phone_e164, preferred_name)')
    .eq('status', 'pending')
    .lte('next_run_at', now)
    .limit(50);

  if (error || !due?.length) return;

  for (const reminder of due) {
    const user = (reminder as any).users;
    if (!user?.phone_e164) continue;

    const name = user.preferred_name ?? 'você';
    const msg = reminder.body ?? `Ei ${name}, lembrete: ${reminder.title} 💊`;

    // Insert as outbound message in any active conversation
    const { data: conv } = await db
      .from('conversations')
      .select('id')
      .eq('party_type', 'user')
      .eq('status', 'active')
      .eq('whatsapp_instance', SARA_INSTANCE)
      .contains('whatsapp_jid', user.phone_e164.replace('+', ''))
      .single();

    if (conv) {
      await db.from('messages').insert({
        conversation_id: conv.id,
        direction: 'out',
        sender_role: 'assistant',
        content_type: 'text',
        content: msg,
      });
    }

    if (!isSimulatorMode()) {
      await sendText(SARA_INSTANCE, user.phone_e164, msg).catch(console.error);
    }

    // Update reminder
    await db.from('reminders').update({ status: 'sent', last_run_at: now }).eq('id', reminder.id);
  }
}
