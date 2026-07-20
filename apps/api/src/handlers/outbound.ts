import { db, writeLog, writeEvent } from '@iasaude/db';
import { isSimulatorMode, providerFor } from '@iasaude/whatsapp';
import { synthesizeSpeech, humanizeForVoice } from '@iasaude/integrations';
import { SARA_INSTANCE } from '@iasaude/shared';
import { loadPrompts } from '../config/prompts.js';
import { dispatchOutbound } from '../queues/outbound.queue.js';
import { uploadPublicAudio } from './audio-host.js';

interface LlmMeta {
  model?: string;
  tokensIn?: number;
  tokensOut?: number;
  latencyMs?: number;
}

/** Janela de deduplicação de saída idêntica na mesma conversa (anti double-send). */
const DEDUP_WINDOW_MS = 30_000;

/**
 * A MESMA mensagem já saiu pra ESTA conversa nos últimos ~30s? (Fix #4)
 *
 * Causa real das duplicatas: NÃO há serialização por conversa — duas mensagens do
 * usuário em poucos segundos geram dois turnos concorrentes, ambos caindo no mesmo
 * fallback ("Prontinho, já cuidei!") ou repetindo a mesma pergunta. Como o 2º turno
 * termina ~2s após o 1º, ele enxerga a inserção do 1º e é barrado aqui. Conteúdo
 * idêntico na mesma conversa em <30s é praticamente sempre bug (nunca intenção).
 */
export async function isDuplicateRecentOutbound(
  conversationId: string,
  content: string,
  windowMs: number = DEDUP_WINDOW_MS,
): Promise<boolean> {
  if (!content || !content.trim()) return false;
  const cutoff = new Date(Date.now() - windowMs).toISOString();
  const { data } = await db
    .from('messages')
    .select('id')
    .eq('conversation_id', conversationId)
    .eq('direction', 'out')
    .eq('content', content)
    .gt('created_at', cutoff)
    .limit(1);
  return (data?.length ?? 0) > 0;
}

/**
 * Envia texto ao usuário. **Devolve `false` quando a mensagem NÃO saiu** (suprimida pelo
 * dedup) — o chamador precisa saber disso: um `say()` engolido deixava o turno MUDO e
 * destravava o narrador de follow-up, que então INVENTAVA a ação ("Falei com as 5 redes",
 * incidente Vadivino 17/07 — nenhuma mensagem tinha saído). Sinal = resultado, não intenção.
 */
export async function sendOutbound(
  conversationId: string,
  phoneE164: string,
  text: string,
  traceId: string,
  llmMeta: LlmMeta = {},
  opts: { dedup?: boolean; dedupWindowMs?: number } = {},
): Promise<boolean> {
  // Anti double-send OPT-IN (Fix #4): SÓ os call-sites que passam dedup:true deduplicam
  // (resposta conversacional da Xarlote e relays estabelecimento→usuário). Workers/lembretes
  // NÃO passam dedup (senão suprimiam notificação legítima). Janela default 12s (corrida de
  // turnos termina em <5s); relays de estabelecimento usam janela maior (mesma pergunta não
  // deve repetir em ~1min).
  if (opts.dedup && await isDuplicateRecentOutbound(conversationId, text, opts.dedupWindowMs ?? 12_000)) {
    await writeLog('warn', 'outbound', `Mensagem duplicada suprimida: "${(text ?? '').slice(0, 60)}"`, { traceId, conversationId });
    return false;
  }

  // Persist outbound message first (realtime will push to dashboard)
  const { data: inserted } = await db.from('messages').insert({
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
  }).select('id').single();

  // Update last_message_at
  await db.from('conversations').update({ last_message_at: new Date().toISOString() }).eq('id', conversationId);

  // In simulator mode, do not call uazapi
  if (isSimulatorMode()) {
    if (inserted?.id) await db.from('messages').update({ delivery_status: 'suppressed' }).eq('id', inserted.id);
    return true;
  }

  // 'queued' = entrou na fila; quem carimba 'delivered'/'failed' é o WORKER, que é o único
  // que sabe o resultado real (dispatchOutbound engole exceção e nunca lança — review).
  if (inserted?.id) await db.from('messages').update({ delivery_status: 'queued' }).eq('id', inserted.id);
  // F0.7: envio via fila com rate-limit (evita ban). Fallback direto se a fila cair.
  await dispatchOutbound({ kind: 'text', instance: SARA_INSTANCE, phoneE164, text, traceId, messageId: inserted?.id as string | undefined });
  return true;
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
export interface SendAudioContext {
  /** Nome preferido do usuário — usado pra corrigir pronúncia (H mudo, iniciais). */
  preferredName?: string | null;
}

export async function sendOutboundAudio(
  conversationId: string,
  phoneE164: string,
  text: string,
  traceId: string,
  llmMeta: LlmMeta = {},
  ctx: SendAudioContext = {}
): Promise<boolean> {
  const cfg = loadPrompts();
  const apiKey = cfg.tts_api_key || process.env['ELEVENLABS_API_KEY'] || '';

  if (!cfg.tts_enabled || !apiKey) {
    await writeLog('info', 'tts', `TTS desabilitado ou sem API key — caindo pra texto`, { traceId, enabled: cfg.tts_enabled, hasKey: !!apiKey });
    await sendOutbound(conversationId, phoneE164, text, traceId, llmMeta);
    return false;
  }

  // Humaniza o texto SÓ pra síntese (pausas, correção de nomes).
  // `text` original continua sendo o que vai pro DB/dashboard.
  const voiceScript = humanizeForVoice(text, { preferredName: ctx.preferredName });
  if (voiceScript !== text) {
    await writeLog('info', 'tts', `Voice script humanizado: "${voiceScript.slice(0, 120)}…"`, { traceId, original: text.slice(0, 120) });
  }

  // zpro/WABA: o áudio é hospedado e enviado por URL (/url). MP3 (audio/mpeg) é o
  // formato mais CONFIÁVEL de entrega na Cloud API do WhatsApp — opus exige
  // content-type 'audio/ogg; codecs=opus' + mono/16kHz e ainda assim só vira
  // PTT-waveform se o canal setar voice:true (o zpro não expõe isso). MP3 entrega
  // como áudio tocável, garantido. uazapi também usa mp3 (base64).
  const useZpro = providerFor(SARA_INSTANCE) === 'zpro';

  let synth: Awaited<ReturnType<typeof synthesizeSpeech>> | null = null;
  const ttsStart = Date.now();
  try {
    synth = await synthesizeSpeech(voiceScript, {
      apiKey,
      voiceId: cfg.tts_voice_id,
      modelId: cfg.tts_model,
      languageCode: 'pt',
      speed: cfg.tts_speed,
      timeoutMs: 30_000,
    });
    const ttsLatency = Date.now() - ttsStart;
    await writeLog('info', 'tts', `Áudio sintetizado [${synth.model}/${synth.voiceId}] ${synth.buffer.length}B em ${ttsLatency}ms (${synth.charsBilled} chars)`, {
      traceId, model: synth.model, voiceId: synth.voiceId, bytes: synth.buffer.length, latencyMs: ttsLatency,
    });
    await writeEvent({
      eventName: 'tts.synthesized',
      traceId, conversationId, durationMs: ttsLatency,
      payload: {
        model: synth.model, voice_id: synth.voiceId,
        chars_billed: synth.charsBilled, bytes: synth.buffer.length,
      },
    });
  } catch (err) {
    await writeLog('error', 'tts', `Falha ao sintetizar áudio (caindo pra texto): ${String(err).slice(0, 240)}`, { traceId });
    await writeEvent({
      eventName: 'tts.failed',
      severity: 'error',
      traceId, conversationId,
      payload: { error: String(err).slice(0, 240) },
    });
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

  // zpro/WABA: sobe o áudio e manda por URL (/voice = PTT). Se o upload falhar,
  // cai pro base64 (que no zpro provavelmente erra → fallback texto no worker).
  const audioUrl = useZpro ? await uploadPublicAudio(synth.buffer, synth.mime, traceId) : null;
  if (useZpro) {
    await writeLog('info', 'tts', `Voice note via ${audioUrl ? '/voice (URL hospedada)' : 'base64 (upload falhou)'}`, {
      traceId, hosted: !!audioUrl, mime: synth.mime,
    });
  }

  // F0.7: enfileira o áudio (com `text` de fallback embutido) com rate-limit.
  // O worker tenta o áudio e, se falhar, manda o texto pra não deixar o usuário mudo.
  await dispatchOutbound({
    kind: 'audio',
    instance: SARA_INSTANCE,
    phoneE164,
    ...(audioUrl ? { audioUrl } : { audioBase64: synth.buffer.toString('base64') }),
    mime: synth.mime,
    ptv: true,
    text,
    traceId,
  });
  return true;
}
