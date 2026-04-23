import { db } from '@iasaude/db';
import { isSimulatorMode, sendText } from '@iasaude/whatsapp';
import { SARA_INSTANCE } from '@iasaude/shared';

interface LlmMeta {
  model?: string;
  tokensIn?: number;
  tokensOut?: number;
  latencyMs?: number;
}

export async function sendOutbound(
  conversationId: string,
  phoneE164: string,
  text: string,
  traceId: string,
  llmMeta: LlmMeta = {}
): Promise<void> {
  // Persist outbound message first (realtime will push to dashboard)
  await db.from('messages').insert({
    conversation_id: conversationId,
    direction: 'out',
    sender_role: 'assistant',
    content_type: 'text',
    content: text,
    trace_id: traceId,
    llm_model: llmMeta.model ?? null,
    llm_tokens_in: llmMeta.tokensIn ?? null,
    llm_tokens_out: llmMeta.tokensOut ?? null,
    llm_latency_ms: llmMeta.latencyMs ?? null,
  });

  // Update last_message_at
  await db.from('conversations').update({ last_message_at: new Date().toISOString() }).eq('id', conversationId);

  // In simulator mode, do not call uazapi
  if (isSimulatorMode()) return;

  // In production, send via uazapi
  try {
    await sendText(SARA_INSTANCE, phoneE164, text);
  } catch (err) {
    await db.from('system_logs').insert({
      level: 'error',
      category: 'outbound',
      trace_id: traceId,
      message: `Failed to send WA message: ${String(err)}`,
      metadata: { phoneE164 },
    });
  }
}
