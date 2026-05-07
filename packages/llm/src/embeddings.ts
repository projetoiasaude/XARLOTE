/**
 * Wrapper de embedding via OpenRouter (proxy OpenAI).
 * Modelo padrão: text-embedding-3-small (1536-d, ~$0.02/1M tokens).
 *
 * Resiliente: timeout 15s, sem retry agressivo (chamado sempre em background
 * pelo profile enricher; melhor falhar e reagendar do que travar uma turn).
 */

const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';
const DEFAULT_EMBEDDING_MODEL = 'openai/text-embedding-3-small';
const EMBEDDING_DIM = 1536;

function getApiKey(override?: string): string {
  const key = override ?? process.env['OPENROUTER_API_KEY'] ?? '';
  if (!key) throw new Error('No OPENROUTER_API_KEY for embeddings.');
  return key;
}

export async function embed(
  text: string,
  opts: { model?: string; apiKey?: string; timeoutMs?: number } = {}
): Promise<number[]> {
  const model = opts.model ?? DEFAULT_EMBEDDING_MODEL;
  const apiKey = getApiKey(opts.apiKey);
  const timeoutMs = opts.timeoutMs ?? 15_000;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(`${OPENROUTER_BASE}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://iadasaude.com',
        'X-Title': 'IA da Saúde',
      },
      body: JSON.stringify({ model, input: text }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => res.statusText);
      throw new Error(`[embed ${res.status}] ${body.slice(0, 200)}`);
    }
    const data = (await res.json()) as { data: Array<{ embedding: number[] }> };
    const v = data.data?.[0]?.embedding;
    if (!Array.isArray(v) || v.length !== EMBEDDING_DIM) {
      throw new Error(`Embedding shape inválida (esperado ${EMBEDDING_DIM}, recebido ${v?.length})`);
    }
    return v;
  } finally {
    clearTimeout(timer);
  }
}

export const EMBEDDING_DIMENSION = EMBEDDING_DIM;
