/**
 * Transcrição de áudio do WhatsApp.
 *
 * Suporta dois "providers" via prefixo do `model`:
 *   - `openai/whisper-1`           → OpenRouter → Whisper (multipart upload)
 *   - `gemini/gemini-2.0-flash`    → Google Generative Language API (audio inlineData)
 *
 * O caller escolhe o modelo (settings UI). Default: openai/whisper-1.
 */

interface TranscribeResult {
  text: string;
  lang?: string;
  durationSeconds?: number;
  provider: 'openrouter' | 'gemini';
  model: string;
}

interface TranscribeOptions {
  model?: string;
  openRouterKey?: string;
  geminiKey?: string;
  timeoutMs?: number;
}

const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';

export async function transcribeAudio(
  audio: Buffer,
  mime: string,
  opts: TranscribeOptions = {}
): Promise<TranscribeResult> {
  const model = opts.model || 'openai/whisper-1';
  const timeoutMs = opts.timeoutMs ?? 30_000;

  if (model.startsWith('gemini/')) {
    return transcribeWithGemini(audio, mime, model.replace(/^gemini\//, ''), opts.geminiKey, timeoutMs);
  }
  // Default: OpenRouter (Whisper ou outro modelo de transcrição compatível)
  return transcribeWithOpenRouter(audio, mime, model, opts.openRouterKey, timeoutMs);
}

async function transcribeWithOpenRouter(
  audio: Buffer,
  mime: string,
  model: string,
  apiKeyOverride: string | undefined,
  timeoutMs: number
): Promise<TranscribeResult> {
  const apiKey = apiKeyOverride ?? process.env['OPENROUTER_API_KEY'] ?? '';
  if (!apiKey) throw new Error('No OPENROUTER_API_KEY for transcription.');

  // O endpoint /audio/transcriptions é compatível OpenAI — multipart com file + model.
  const filename = guessFilename(mime);
  const form = new FormData();
  form.append('file', new Blob([audio], { type: mime }), filename);
  form.append('model', model);
  form.append('response_format', 'verbose_json');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${OPENROUTER_BASE}/audio/transcriptions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://iadasaude.com',
        'X-Title': 'IA da Saúde',
      },
      body: form,
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => res.statusText);
      throw new Error(`[transcribe openrouter ${res.status}] ${body.slice(0, 240)}`);
    }
    const data = (await res.json()) as {
      text?: string;
      language?: string;
      duration?: number;
    };
    return {
      text: (data.text ?? '').trim(),
      lang: data.language,
      durationSeconds: data.duration,
      provider: 'openrouter',
      model,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function transcribeWithGemini(
  audio: Buffer,
  mime: string,
  model: string,
  apiKeyOverride: string | undefined,
  timeoutMs: number
): Promise<TranscribeResult> {
  const apiKey = apiKeyOverride ?? process.env['GOOGLE_GENAI_API_KEY'] ?? '';
  if (!apiKey) throw new Error('No GOOGLE_GENAI_API_KEY for Gemini transcription.');

  const inlineMime = mime || 'audio/ogg';
  const body = {
    contents: [
      {
        role: 'user',
        parts: [
          {
            text: 'Transcreva fielmente o áudio abaixo em português brasileiro. Apenas o texto transcrito, sem comentários.',
          },
          { inlineData: { mimeType: inlineMime, data: audio.toString('base64') } },
        ],
      },
    ],
    generationConfig: { temperature: 0, maxOutputTokens: 1024 },
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${GEMINI_BASE}/models/${model}:generateContent?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText);
      throw new Error(`[transcribe gemini ${res.status}] ${text.slice(0, 240)}`);
    }
    const data = (await res.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    const text = (data.candidates?.[0]?.content?.parts ?? [])
      .map((p) => p.text ?? '')
      .join(' ')
      .trim();
    return { text, provider: 'gemini', model };
  } finally {
    clearTimeout(timer);
  }
}

function guessFilename(mime: string): string {
  if (mime.includes('ogg')) return 'audio.ogg';
  if (mime.includes('mpeg') || mime.includes('mp3')) return 'audio.mp3';
  if (mime.includes('wav')) return 'audio.wav';
  if (mime.includes('m4a') || mime.includes('mp4')) return 'audio.m4a';
  if (mime.includes('webm')) return 'audio.webm';
  return 'audio.bin';
}
