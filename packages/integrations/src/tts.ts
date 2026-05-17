/**
 * Text-to-speech via ElevenLabs.
 *
 * Usado pra que a Xarlote responda em ÁUDIO em momentos pontuais (hoje:
 * só a primeira saudação chamando o nome do usuário). Mantemos o universo
 * de envio bem pequeno por dois motivos:
 *   1. Quota ElevenLabs é finita (~$5/mês no Starter = ~30k chars).
 *   2. Áudio TTS perde a graça se virar default; rareza = surpresa = humanização.
 *
 * Modelo default: `eleven_flash_v2_5` — latência ~75ms first byte, ~70%
 * mais barato que o Multilingual v2, qualidade ótima pra PT-BR.
 *
 * Voice ID default: Sarah (`EXAVITQu4vr4xnSDxMaL`) — premade feminina suave,
 * funciona bem com PT via Flash v2.5. Configurável em /prompts.
 *
 * Saída: MP3 44.1kHz 128kbps por padrão (formato bem aceito por uazapi /send/media).
 */
import axios from 'axios';

const ELEVENLABS_BASE = 'https://api.elevenlabs.io/v1';

export interface TtsOptions {
  apiKey: string;
  voiceId?: string;
  modelId?: string;
  /** 0-1, default 0.5. Menor = mais expressivo/variável. */
  stability?: number;
  /** 0-1, default 0.75. Maior = mais fiel ao timbre original. */
  similarityBoost?: number;
  /** 0-1, default 0.5. Maior = mais dramático. */
  style?: number;
  /** Boost de clareza/presença. Default true. */
  useSpeakerBoost?: number | boolean;
  /** Código de idioma — só usado por modelos Turbo v2.5/Flash v2.5. */
  languageCode?: string;
  /** mp3 default; pode usar `mp3_22050_32`, `pcm_16000`, `opus_48000_*`. */
  outputFormat?: string;
  timeoutMs?: number;
}

export interface TtsResult {
  buffer: Buffer;
  mime: string;
  model: string;
  voiceId: string;
  charsBilled: number;
}

const DEFAULT_VOICE = 'EXAVITQu4vr4xnSDxMaL'; // Sarah — premade feminina
const DEFAULT_MODEL = 'eleven_flash_v2_5';
const DEFAULT_FORMAT = 'mp3_44100_128';

export async function synthesizeSpeech(
  text: string,
  opts: TtsOptions
): Promise<TtsResult> {
  if (!opts.apiKey) {
    throw new Error('ElevenLabs apiKey ausente');
  }
  const trimmed = text.trim();
  if (!trimmed) throw new Error('Texto vazio pra TTS');

  const voiceId = opts.voiceId || DEFAULT_VOICE;
  const modelId = opts.modelId || DEFAULT_MODEL;
  const outputFormat = opts.outputFormat || DEFAULT_FORMAT;

  const body: Record<string, unknown> = {
    text: trimmed,
    model_id: modelId,
    voice_settings: {
      stability: opts.stability ?? 0.45,
      similarity_boost: opts.similarityBoost ?? 0.8,
      style: opts.style ?? 0.35,
      use_speaker_boost:
        typeof opts.useSpeakerBoost === 'boolean'
          ? opts.useSpeakerBoost
          : (opts.useSpeakerBoost ?? 1) > 0,
    },
  };
  // Flash/Turbo v2.5 aceita language_code; Multilingual v2 não.
  if (opts.languageCode || modelId.includes('flash') || modelId.includes('turbo')) {
    body['language_code'] = opts.languageCode || 'pt';
  }

  const url = `${ELEVENLABS_BASE}/text-to-speech/${voiceId}?output_format=${encodeURIComponent(outputFormat)}`;

  const res = await axios.post<ArrayBuffer>(url, body, {
    headers: {
      'xi-api-key': opts.apiKey,
      'Content-Type': 'application/json',
      Accept: 'audio/mpeg',
    },
    responseType: 'arraybuffer',
    timeout: opts.timeoutMs ?? 30_000,
    validateStatus: () => true,
  });

  if (res.status >= 400) {
    // ElevenLabs devolve JSON de erro com a mesma key — tenta parse
    let errText: string;
    try {
      errText = Buffer.from(res.data).toString('utf-8');
    } catch {
      errText = `status ${res.status}`;
    }
    throw new Error(`ElevenLabs ${res.status}: ${errText.slice(0, 240)}`);
  }

  const buffer = Buffer.from(res.data);
  const mime = outputFormat.startsWith('mp3')
    ? 'audio/mpeg'
    : outputFormat.startsWith('opus')
      ? 'audio/ogg'
      : outputFormat.startsWith('pcm')
        ? 'audio/wav'
        : 'audio/mpeg';

  return {
    buffer,
    mime,
    model: modelId,
    voiceId,
    charsBilled: trimmed.length,
  };
}

/**
 * Lista vozes disponíveis na conta — útil pro dashboard montar dropdown.
 * Retorna `[]` em falha (não bloqueia UI).
 */
export interface VoiceSummary {
  voice_id: string;
  name: string;
  category?: string;
  labels?: Record<string, string>;
  preview_url?: string;
}

export async function listVoices(apiKey: string, timeoutMs = 8_000): Promise<VoiceSummary[]> {
  if (!apiKey) return [];
  try {
    const res = await axios.get<{ voices: VoiceSummary[] }>(`${ELEVENLABS_BASE}/voices`, {
      headers: { 'xi-api-key': apiKey },
      timeout: timeoutMs,
    });
    return Array.isArray(res.data?.voices) ? res.data.voices : [];
  } catch {
    return [];
  }
}
