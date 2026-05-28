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

  // Modo simulador OU instância do agente não configurada (sem WhatsApp conectado
  // pro lado das farmácias) → apenas persistimos a mensagem e o operador
  // responde manualmente no dashboard como se fosse a farmácia.
  const agentTokenConfigured = !!process.env['UAZAPI_AGENT_TOKEN'];
  if (isSimulatorMode() || !agentTokenConfigured) {
    await writeLog('info', 'agent', 'Mensagem do agente salva — aguardando resposta manual no dashboard (chat por farmácia)', {
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

/**
 * Envia mensagem da Xarlote pra uma CLÍNICA (fluxo de consulta médica).
 *
 * Diferente da farmácia, clínicas são descobertas no Google (números reais de
 * médicos). Por segurança, o envio real só acontece quando explicitamente
 * ativado via `CLINIC_OUTBOUND_MODE=real`. O DEFAULT é simulação: a mensagem é
 * persistida e o operador responde como a clínica pelo painel do /simulator
 * (POST /api/simulate/clinic-reply).
 *
 * Isso evita mandar WhatsApp pra médicos reais durante testes/beta.
 */
export async function sendOutboundToClinic(
  conversationId: string,
  clinicPhone: string,
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

  const realMode = process.env['CLINIC_OUTBOUND_MODE'] === 'real';
  const agentTokenConfigured = !!process.env['UAZAPI_AGENT_TOKEN'];

  // Default = simulação. Só manda real se CLINIC_OUTBOUND_MODE=real E não é simulador E tem token.
  if (!realMode || isSimulatorMode() || !agentTokenConfigured) {
    await writeLog('info', 'clinic', 'Mensagem pra clínica salva (modo simulação) — responda pelo painel do simulador', {
      traceId, conversationId,
    });
    return;
  }

  try {
    await sendText(AGENT_INSTANCE, clinicPhone, text);
    await writeLog('info', 'clinic', `Mensagem REAL enviada pra clínica ${clinicPhone.slice(0, 8)}***`, { traceId, conversationId });
  } catch (err) {
    await writeLog('error', 'clinic', `Falha ao enviar WA pra clínica: ${String(err)}`, { traceId, clinicPhone });
  }
}
