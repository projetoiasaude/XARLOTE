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

/** Tool call na forma do provider (OpenAI/OpenRouter) — usada pra ECOAR de volta no histórico. */
export interface RawToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  /**
   * `'tool'` fecha o LOOP AGÊNTICO (ReAct): devolve ao modelo o RESULTADO da ferramenta
   * que ele pediu. Antes de 26/07 este papel não existia — o modelo emitia tool calls e
   * NUNCA via o que aconteceu, então escrevia a resposta ao paciente descrevendo o que
   * IMAGINAVA ("já falei com a farmácia" sem ter falado). Era a raiz da "burrice".
   */
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | ChatContent[] | null;
  /** Só em `role:'assistant'` — as tool calls que o modelo emitiu naquele passo. */
  tool_calls?: RawToolCall[];
  /** Só em `role:'tool'` — id da tool call que este resultado responde. */
  tool_call_id?: string;
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
  /**
   * id do provider — necessário pro round-trip do loop agêntico (o `tool_call_id` da
   * mensagem de resultado precisa casar com este id). Opcional porque tool calls
   * FORÇADAS por backstop determinístico são sintetizadas localmente.
   */
  id?: string;
  name: string;
  args: Record<string, unknown>;
}

export interface ChatResponse {
  text: string;
  toolCalls: ToolCall[];
  /** As tool calls na forma CRUA do provider — pra ecoar no histórico do loop ReAct. */
  rawToolCalls: RawToolCall[];
  tokensIn: number;
  tokensOut: number;
  /** Tokens de input servidos do CACHE do provider (F2.G3). 0 = sem cache hit. */
  cachedTokens: number;
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
  /**
   * Transcrição do LOOP AGÊNTICO já percorrida neste turno: pares
   * assistant(tool_calls) → tool(resultado). Anexada DEPOIS da mensagem do usuário, então
   * o modelo re-decide já ENXERGANDO o que suas ferramentas devolveram.
   */
  priorMessages?: ChatMessage[];
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
              .array(z.object({
                // id do provider — obrigatório pro round-trip do loop ReAct (o resultado
                // volta com `tool_call_id` igual). Nullish por robustez: se o provider
                // omitir, sintetizamos um id local abaixo.
                id: z.string().nullish(),
                function: z.object({ name: z.string(), arguments: z.string() }),
              }))
              .nullish(),
          }),
        }),
      )
      .min(1),
    usage: z
      .object({
        prompt_tokens: z.number().nullish(),
        completion_tokens: z.number().nullish(),
        // F2.G3: OpenAI/OpenRouter reportam tokens de input servidos do cache aqui.
        prompt_tokens_details: z.object({ cached_tokens: z.number().nullish() }).nullish(),
      })
      .nullish(),
  })
  .passthrough();

/** Distância de edição (Levenshtein). Puro, O(m·n) com 2 linhas. */
function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  let cur = new Array<number>(n + 1).fill(0);
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[n]!;
}

/**
 * RESILIÊNCIA A TYPO DE TOOL DO MODELO (incidente Vadivino 22/07): o LLM chamou
 * `request_cllarification` (L dobrado) → o dispatcher tratou como "tool desconhecida" e ENGOLIU a
 * chamada em silêncio (5× num dia) → o relay ao paciente nunca saía e a consulta travava. Em vez de
 * caçar cada typo, resolvemos o nome cru pro nome VÁLIDO mais próximo — UMA vez, no client, então
 * TODOS os agentes (paciente, clínica, farmácia) ganham a blindagem de graça. Conservador de
 * propósito: só corrige quando tem certeza; na dúvida devolve o cru (o handler loga "desconhecida").
 *   1. exato → 2. case-insensitive → 3. normalizado (colapsa letras repetidas, tira separadores)
 *   → 4. distância de edição ≤ limiar E inequívoco (o mais próximo tem que ser ÚNICO).
 */
export function resolveToolName(raw: string, validNames: string[]): string {
  if (!raw || !validNames.length) return raw;
  if (validNames.includes(raw)) return raw;
  const lower = raw.toLowerCase();
  const ci = validNames.find((n) => n.toLowerCase() === lower);
  if (ci) return ci;
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '').replace(/(.)\1+/g, '$1');
  const nr = norm(raw);
  const normHits = validNames.filter((n) => norm(n) === nr);
  if (normHits.length === 1) return normHits[0]!;
  const scored = validNames
    .map((n) => ({ n, d: levenshtein(lower, n.toLowerCase()) }))
    .sort((a, b) => a.d - b.d);
  const best = scored[0];
  const second = scored[1];
  const maxD = Math.min(3, Math.max(2, Math.floor(raw.length * 0.25)));
  if (best && best.d <= maxD && (!second || second.d > best.d)) return best.n;
  return raw;
}

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
    // F2.G3: pede o accounting de uso (inclui prompt_tokens_details.cached_tokens).
    // O CACHE de prefixo é server-side/automático em modelos OpenAI-family e z-ai/GLM
    // (o system prompt grande da Xarlote vem 1º e cacheia ~99% do input a partir do 2º
    // turno) — este flag só garante que a economia apareça nas métricas de custo.
    usage: { include: true },
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

  const validToolNames = (tools ?? []).map((t) => t.function.name);
  const rawToolCalls: RawToolCall[] = [];
  const toolCalls: ToolCall[] = (choice.message.tool_calls ?? []).map((tc, i) => {
    const resolved = resolveToolName(tc.function.name, validToolNames);
    if (resolved !== tc.function.name) {
      // Observável no Railway sem dependência de db: corrigimos um typo de tool do modelo.
      console.warn(`[llm] tool-name corrigido: "${tc.function.name}" → "${resolved}"`);
    }
    // id estável pro round-trip. Se o provider omitir, sintetiza — o que importa é que o
    // `tool_call_id` do resultado case com o id ecoado na mensagem do assistant.
    // ⚠️ `??` NÃO trata string vazia como nulo — e um provider que devolva `id: ""` faria
    // duas tool calls compartilharem o mesmo tool_call_id vazio, o que a API rejeita com 400
    // (e queimaria 3 retries + o breaker global do OpenRouter). Testa o conteúdo, não o nulo.
    const id = tc.id && tc.id.trim() ? tc.id : `call_${i}_${Date.now().toString(36)}`;
    // Ecoa com o nome JÁ CORRIGIDO: senão o histórico do loop levaria o typo de volta
    // ao modelo e ele repetiria o erro na rodada seguinte.
    rawToolCalls.push({ id, type: 'function', function: { name: resolved, arguments: tc.function.arguments } });
    return {
      id,
      name: resolved,
      args: (() => { try { return JSON.parse(tc.function.arguments); } catch { return {}; } })(),
    };
  });

  return {
    text: choice.message.content ?? '',
    toolCalls,
    rawToolCalls,
    tokensIn: data.usage?.prompt_tokens ?? 0,
    tokensOut: data.usage?.completion_tokens ?? 0,
    cachedTokens: data.usage?.prompt_tokens_details?.cached_tokens ?? 0,
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
  // Transcrição do loop agêntico deste turno (assistant→tool→assistant→…). Vem DEPOIS da
  // mensagem do usuário: é o que o modelo já tentou e o que as ferramentas responderam.
  if (opts.priorMessages?.length) {
    messages.push(...opts.priorMessages);
  }

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
