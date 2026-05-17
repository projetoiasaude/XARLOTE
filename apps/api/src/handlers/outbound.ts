import { db, writeLog } from '@iasaude/db';
import { isSimulatorMode, sendText, sendAudio } from '@iasaude/whatsapp';
import { synthesizeSpeech } from '@iasaude/integrations';
import { SARA_INSTANCE } from '@iasaude/shared';
import { loadPrompts } from '../config/prompts.js';

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

/**
 * Sintetiza `text` em áudio (ElevenLabs) e envia como voice note (PTT) via uazapi.
 * Cai pra `sendOutbound` (texto) automaticamente se TTS falhar ou estiver
 * desabilitado — UX é "best effort" pra áudio, nunca trava a conversa.
 *
 * Persiste a mensagem na tabela `messages` com:
 *   - `content_type = 'audio'`
 *   - `content` = transcrição (o próprio texto), pra ficar buscável e legível no dashboard
 *   - `media_mime = 'audio/mpeg'`
 *
 * Retorna `true` se mandou áudio, `false` se caiu pro fallback de texto.
 */
export async function sendOutboundAudio(
  conversationId: string,
  phoneE164: string,
  text: string,
  traceId: string,
  llmMeta: LlmMeta = {}
): Promise<boolean> {
  const cfg = loadPrompts();
  const apiKey = cfg.tts_api_key || process.env['ELEVENLABS_API_KEY'] || '';

  if (!cfg.tts_enabled || !apiKey) {
    await writeLog('info', 'tts', `TTS desabilitado ou sem API key — caindo pra texto`, { traceId, enabled: cfg.tts_enabled, hasKey: !!apiKey });
    await sendOutbound(conversationId, phoneE164, text, traceId, llmMeta);
    return false;
  }

  let synth: Awaited<ReturnType<typeof synthesizeSpeech>> | null = null;
  const ttsStart = Date.now();
  try {
    synth = await synthesizeSpeech(text, {
      apiKey,
      voiceId: cfg.tts_voice_id,
      modelId: cfg.tts_model,
      languageCode: 'pt',
      timeoutMs: 30_000,
    });
    await writeLog('info', 'tts', `Áudio sintetizado [${synth.model}/${synth.voiceId}] ${synth.buffer.length}B em ${Date.now() - ttsStart}ms (${synth.charsBilled} chars)`, {
      traceId, model: synth.model, voiceId: synth.voiceId, bytes: synth.buffer.length, latencyMs: Date.now() - ttsStart,
    });
  } catch (err) {
    await writeLog('error', 'tts', `Falha ao sintetizar áudio (caindo pra texto): ${String(err).slice(0, 240)}`, { traceId });
    await sendOutbound(conversationId, phoneE164, text, traceId, llmMeta);
    return false;
  }

  // Persiste mensagem outbound como áudio (transcrição = texto original).
  await db.from('messages').insert({
    conversation_id: conversationId,
    direction: 'out',
    sender_role: 'assistant',
    content_type: 'audio',
    content: text,
    transcript: text,
    media_mime: synth.mime,
    trace_id: traceId,
    llm_model: llmMeta.model ?? null,
    llm_tokens_in: llmMeta.tokensIn ?? null,
    llm_tokens_out: llmMeta.tokensOut ?? null,
    llm_latency_ms: llmMeta.latencyMs ?? null,
  });
  await db.from('conversations').update({ last_message_at: new Date().toISOString() }).eq('id', conversationId);

  // Em simulador não chama uazapi (mensagem já foi persistida pra aparecer no dashboard)
  if (isSimulatorMode()) return true;

  try {
    await sendAudio(SARA_INSTANCE, phoneE164, synth.buffer, { mime: synth.mime, ptv: true });
    return true;
  } catch (err) {
    await writeLog('error', 'outbound', `Falha ao enviar áudio uazapi (já persistido em messages): ${String(err).slice(0, 200)}`, { traceId, phoneE164 });
    // Áudio falhou no envio — manda texto também pra usuário não ficar mudo
    try { await sendText(SARA_INSTANCE, phoneE164, text); } catch { /* ignore */ }
    return false;
  }
}
