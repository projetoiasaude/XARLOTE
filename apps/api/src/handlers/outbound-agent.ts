import { db, writeLog } from '@iasaude/db';
import { isSimulatorMode, sendText } from '@iasaude/whatsapp';
import { AGENT_INSTANCE } from '@iasaude/shared';

/**
 * Sends a message from the agent to a pharmacy supplier.
 *
 * In simulator mode: message is persisted to DB only.
 * The user responds manually via the simulator pharmacy panel.
 * (POST /api/simulate/pharmacy-reply)
 *
 * In real mode: message is sent via uazapi WhatsApp.
 */
export async function sendOutboundToSupplier(
  conversationId: string,
  supplierPhone: string,
  text: string,
  traceId: string,
): Promise<void> {
  await db.from('messages').insert({
    conversation_id: conversationId,
    direction: 'out',
    sender_role: 'assistant',
    content_type: 'text',
    content: text,
    trace_id: traceId,
  });

  await db.from('conversations')
    .update({ last_message_at: new Date().toISOString() })
    .eq('id', conversationId);

  if (isSimulatorMode()) {
    // Simulator: no auto-reply. User manually responds as each pharmacy.
    await writeLog('info', 'agent', 'Mensagem do agente salva — aguardando resposta manual no painel de farmácias', {
      traceId, conversationId,
    });
    return;
  }

  try {
    await sendText(AGENT_INSTANCE, supplierPhone, text);
  } catch (err) {
    await writeLog('error', 'agent', `Falha ao enviar mensagem WA ao fornecedor: ${String(err)}`, {
      traceId, supplierPhone,
    });
  }
}
