/**
 * Transcrição de áudio do WhatsApp.
 *
 * Providers suportados (via prefixo/sufixo do `model`):
 *   - `openai/gpt-4o-audio-preview` → OpenRouter chat-with-audio (input_audio na content array)
 *     [DEFAULT — funciona com a key OpenRouter existente]
 *   - `openai/whisper-1`             → OpenRouter `/audio/transcriptions` (NÃO funciona —
 *     OpenRouter não expõe esse endpoint hoje. Mantido por compat se mudar.)
 *   - `whisper/whisper-1`           → OpenAI direto (precisa OPENAI_API_KEY)
 *   - `gemini/gemini-2.0-flash`     → Google Generative Language API (inlineData)
 *
 * O caller escolhe via settings UI. Audio do WhatsApp normalmente vem em
 * `audio/ogg` (Opus) ou `audio/mpeg` — gpt-4o-audio aceita os dois.
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
  const model = opts.model || 'openai/gpt-4o-audio-preview';
  const timeoutMs = opts.timeoutMs ?? 45_000;

  if (model.startsWith('gemini/')) {
    return transcribeWithGemini(audio, mime, model.replace(/^gemini\//, ''), opts.geminiKey, timeoutMs);
  }
  if (model.startsWith('whisper/')) {
    return transcribeWithOpenAIWhisper(audio, mime, model.replace(/^whisper\//, ''), timeoutMs);
  }
  // Modelos de áudio multimodal (gpt-4o-audio-preview etc) — chat completion com input_audio
  if (model.includes('audio') && (model.includes('gpt-4o') || model.includes('audio-preview'))) {
    return transcribeWithChatAudio(audio, mime, model, opts.openRouterKey, timeoutMs);
  }
  // Caminho legado /audio/transcriptions — OpenRouter não suporta (deixa por compat)
  return transcribeWithOpenRouter(audio, mime, model, opts.openRouterKey, timeoutMs);
}

/**
 * Transcreve via chat completions multimodal — modelo recebe áudio como
 * `input_audio` no content array. Funciona via OpenRouter pra
 * `openai/gpt-4o-audio-preview`. É o caminho padrão hoje porque OpenRouter
 * NÃO expõe o endpoint /audio/transcriptions.
 */
async function transcribeWithChatAudio(
  audio: Buffer,
  mime: string,
  model: string,
  apiKeyOverride: string | undefined,
  timeoutMs: number
): Promise<TranscribeResult> {
  const apiKey = apiKeyOverride ?? process.env['OPENROUTER_API_KEY'] ?? '';
  if (!apiKey) throw new Error('No OPENROUTER_API_KEY for chat-audio transcription.');

  // Detecta o formato declarado pra `input_audio` — OpenAI aceita 'mp3' ou 'wav' oficialmente,
  // mas vimos casos com 'opus'/'ogg' funcionando via gpt-4o-audio-preview.
  const format = mime.includes('mpeg') || mime.includes('mp3') ? 'mp3'
    : mime.includes('wav') ? 'wav'
    : mime.includes('ogg') || mime.includes('opus') ? 'ogg'
    : mime.includes('webm') ? 'webm'
    : mime.includes('mp4') || mime.includes('m4a') ? 'mp4'
    : 'mp3';

  const body = {
    model,
    modalities: ['text'],
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'Transcreva fielmente o áudio em português brasileiro. Devolva apenas o texto transcrito, sem comentários, sem explicações, sem aspas. Se o áudio estiver vazio ou ininteligível, devolva exatamente: [vazio].',
          },
          {
            type: 'input_audio',
            input_audio: { data: audio.toString('base64'), format },
          },
        ],
      },
    ],
    temperature: 0,
    max_tokens: 800,
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://iadasaude.com',
        'X-Title': 'IA da Saúde',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText);
      throw new Error(`[transcribe chat-audio ${res.status}] ${text.slice(0, 240)}`);
    }
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    let text = (data.choices?.[0]?.message?.content ?? '').trim();
    if (text === '[vazio]') text = '';
    return { text, provider: 'openrouter', model };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Whisper via API direta da OpenAI (precisa OPENAI_API_KEY separada — não OpenRouter).
 * Endpoint /v1/audio/transcriptions, multipart com file + model.
 */
async function transcribeWithOpenAIWhisper(
  audio: Buffer,
  mime: string,
  model: string,
  timeoutMs: number
): Promise<TranscribeResult> {
  const apiKey = process.env['OPENAI_API_KEY'] ?? '';
  if (!apiKey) throw new Error('Whisper direto precisa OPENAI_API_KEY (não usa OpenRouter).');

  const filename = guessFilename(mime);
  const form = new FormData();
  form.append('file', new Blob([audio], { type: mime }), filename);
  form.append('model', model);
  form.append('response_format', 'verbose_json');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => res.statusText);
      throw new Error(`[transcribe openai-whisper ${res.status}] ${body.slice(0, 240)}`);
    }
    const data = (await res.json()) as { text?: string; language?: string; duration?: number };
    return {
      text: (data.text ?? '').trim(),
      lang: data.language,
      durationSeconds: data.duration,
      provider: 'openrouter', // mantém shape; é OpenAI direta mas a flag não importa pra caller
      model: `whisper/${model}`,
    };
  } finally {
    clearTimeout(timer);
  }
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
