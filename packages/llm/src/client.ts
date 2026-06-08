// OpenRouter client — OpenAI-compatible API
// Base URL: https://openrouter.ai/api/v1
// Models: https://openrouter.ai/models

import { z } from 'zod';
import { getBreaker, CircuitOpenError } from '@iasaude/shared';

/**
 * Conteúdo multimodal — protocolo OpenAI Chat Completions.
 * `text` é texto puro; `image_url` é uma imagem (data URL ou http URL).
 * Modelos vision-capable (gpt-4.1-mini, gpt-4o, etc) entendem nativamente.
 */
export type ChatContent =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: 'auto' | 'low' | 'high' } };

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | ChatContent[];
}

/**
 * Helper pra montar `content` de uma mensagem do usuário com texto + imagem(ns).
 * Use base64 (`data:${mime};base64,${b64}`) ou URL pública.
 */
export function userContentWithImage(text: string, imageDataUrls: string[]): ChatContent[] {
  const parts: ChatContent[] = [];
  if (text) parts.push({ type: 'text', text });
  for (const url of imageDataUrls) {
    parts.push({ type: 'image_url', image_url: { url } });
  }
  return parts;
}

export function dataUrl(base64: string, mime = 'image/jpeg'): string {
  // Aceita base64 cru ou já com prefix
  if (base64.startsWith('data:')) return base64;
  return `data:${mime};base64,${base64}`;
}

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
}

export interface ChatResponse {
  text: string;
  toolCalls: ToolCall[];
  tokensIn: number;
  tokensOut: number;
  latencyMs: number;
  model: string;
}

export interface ChatOptions {
  model?: string;
  apiKey?: string;
  systemInstruction?: string;
  history?: ChatMessage[];
  tools?: ToolDefinition[];
  temperature?: number;
  maxOutputTokens?: number;
  timeoutMs?: number;
}

const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';
const DEFAULT_MODEL = 'openai/gpt-4.1-mini';

// Modelos de fallback usados pelo OpenRouter quando o primário fica indisponível
// (rate-limit upstream, provider down, etc). OpenRouter tenta na ordem.
// Doc: https://openrouter.ai/docs/features/model-routing
const FALLBACK_MODELS = ['openai/gpt-4.1-mini', 'openai/gpt-4o-mini'];

// Schema da resposta do OpenRouter (CLAUDE.md/F1.C6: validar resposta da LLM
// com Zod). Lenient (.passthrough + campos opcionais) pra não rejeitar
// variações válidas; só barra resposta genuinamente malformada.
const OpenRouterResponseSchema = z
  .object({
    choices: z
      .array(
        z.object({
          message: z.object({
            content: z.string().nullish(),
            tool_calls: z
              .array(z.object({ function: z.object({ name: z.string(), arguments: z.string() }) }))
              .nullish(),
          }),
        }),
      )
      .min(1),
    usage: z
      .object({ prompt_tokens: z.number().nullish(), completion_tokens: z.number().nullish() })
      .nullish(),
  })
  .passthrough();

function getApiKey(override?: string): string {
  const key = override ?? process.env['OPENROUTER_API_KEY'] ?? process.env['GOOGLE_GENAI_API_KEY'] ?? '';
  if (!key) throw new Error('No LLM API key configured. Set OPENROUTER_API_KEY or configure in the Prompts dashboard.');
  return key;
}

async function callOpenRouter(
  apiKey: string,
  modelName: string,
  messages: ChatMessage[],
  tools: ToolDefinition[] | undefined,
  temperature: number,
  maxTokens: number,
  timeoutMs: number
): Promise<ChatResponse> {
  const start = Date.now();

  // Fallback chain: se o modelo primário ficar indisponível (429 upstream, etc),
  // OpenRouter automaticamente tenta os modelos listados em `models` na ordem.
  // Filtramos pra não duplicar o primário caso ele já seja um dos fallbacks.
  const fallbacks = FALLBACK_MODELS.filter((m) => m !== modelName);

  const body: Record<string, unknown> = {
    model: modelName,
    models: [modelName, ...fallbacks],
    messages,
    temperature,
    max_tokens: maxTokens,
  };
  if (tools?.length) {
    body['tools'] = tools;
    body['tool_choice'] = 'auto';
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res: Response;
  try {
    res = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://iadasaude.com',
        'X-Title': 'IA da Saúde',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`[${res.status} ${res.statusText}] ${text}`);
  }

  const rawJson = await res.json();
  const parsed = OpenRouterResponseSchema.safeParse(rawJson);
  if (!parsed.success) {
    const where = parsed.error.issues.map((i) => i.path.join('.') || '(root)').join(', ');
    throw new Error(`Resposta da LLM em formato inesperado (campos: ${where})`);
  }
  const data = parsed.data;

  const choice = data.choices[0];
  if (!choice) throw new Error('No choices in OpenRouter response');

  const toolCalls: ToolCall[] = (choice.message.tool_calls ?? []).map((tc) => ({
    name: tc.function.name,
    args: (() => { try { return JSON.parse(tc.function.arguments); } catch { return {}; } })(),
  }));

  return {
    text: choice.message.content ?? '',
    toolCalls,
    tokensIn: data.usage?.prompt_tokens ?? 0,
    tokensOut: data.usage?.completion_tokens ?? 0,
    latencyMs: Date.now() - start,
    model: modelName,
  };
}

export async function chat(
  userMessage: string | ChatContent[],
  opts: ChatOptions = {}
): Promise<ChatResponse> {
  const modelName = opts.model ?? process.env['OPENROUTER_MODEL'] ?? DEFAULT_MODEL;
  const apiKey = getApiKey(opts.apiKey);
  const temperature = opts.temperature ?? 0.4;
  const maxTokens = opts.maxOutputTokens ?? 1024;
  const timeoutMs = opts.timeoutMs ?? 30_000;

  const messages: ChatMessage[] = [];
  if (opts.systemInstruction) {
    messages.push({ role: 'system', content: opts.systemInstruction });
  }
  if (opts.history?.length) {
    messages.push(...opts.history);
  }
  messages.push({ role: 'user', content: userMessage });

  // F2.F5: breaker do OpenRouter. Envolve CADA tentativa (não só o chat inteiro),
  // então o circuito abre RÁPIDO numa queda sustentada (~5 tentativas falhas) e as
  // chamadas seguintes falham na hora (CircuitOpenError) em vez de gastar ~13s+ de
  // retries cada — a Xarlote degrada imediatamente. Cooldown de 30s, depois testa 1.
  const breaker = getBreaker('openrouter', { failureThreshold: 5, cooldownMs: 30_000 });

  let attempt = 0;
  const maxAttempts = 3;

  while (true) {
    try {
      return await breaker.execute(() =>
        callOpenRouter(apiKey, modelName, messages, opts.tools, temperature, maxTokens, timeoutMs),
      );
    } catch (err) {
      // Circuito aberto: não adianta retentar — propaga já pro caller degradar.
      if (err instanceof CircuitOpenError) throw err;
      const errMsg = String(err);
      const isTransient = errMsg.includes('503') || errMsg.includes('502') || errMsg.includes('529');
      const isRateLimit = errMsg.includes('429') || errMsg.includes('quota') || errMsg.includes('RESOURCE_EXHAUSTED');
      attempt++;
      if (attempt >= maxAttempts) throw err;
      // Backoff agressivo em 429/transient (rate-limit upstream demora pra liberar);
      // Como já temos fallback de modelos, normalmente o OpenRouter resolve antes do retry.
      const delay = isRateLimit ? 8000 * attempt : isTransient ? 5000 * attempt : 1000 * 2 ** (attempt - 1);
      await sleep(delay);
    }
  }
}

export async function chatWithTools(
  messages: Array<{ role: 'user' | 'model'; text: string }>,
  tools: ToolDefinition[],
  systemInstruction: string,
  model?: string,
  apiKey?: string
): Promise<ChatResponse> {
  const history: ChatMessage[] = messages.slice(0, -1).map((m) => ({
    role: m.role === 'model' ? ('assistant' as const) : ('user' as const),
    content: m.text,
  }));
  const last = messages.at(-1);
  if (!last) throw new Error('No messages');

  return chat(last.text, {
    model,
    apiKey,
    systemInstruction,
    history,
    tools,
    temperature: 0.35,
    maxOutputTokens: 1024,
  });
}

export async function extractStructured<T>(
  prompt: string,
  imageBase64?: string,
  imageMime = 'image/jpeg',
  model?: string,
  apiKey?: string
): Promise<T> {
  const modelName = model ?? process.env['OPENROUTER_VISION_MODEL'] ?? 'openai/gpt-4.1-mini';
  const key = getApiKey(apiKey);

  const messages: ChatMessage[] = [];

  if (imageBase64) {
    // Multimodal vision: passa a imagem pelo canal `image_url` do protocolo OpenAI
    // (em vez de embutir base64 em string como antes — workaround ineficiente).
    messages.push({
      role: 'user',
      content: userContentWithImage(prompt, [dataUrl(imageBase64, imageMime)]),
    });
  } else {
    messages.push({ role: 'user', content: prompt });
  }

  let attempt = 0;
  while (true) {
    try {
      const result = await callOpenRouter(key, modelName, messages, undefined, 0.1, 4096, 45_000);
      const text = result.text;
      const jsonMatch = text.match(/```json\s*([\s\S]*?)\s*```/) ?? text.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
      if (!jsonMatch?.[1]) throw new Error('No JSON in LLM response');
      return JSON.parse(jsonMatch[1]) as T;
    } catch (err) {
      attempt++;
      if (attempt >= 3) throw err;
      await sleep(3000);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
