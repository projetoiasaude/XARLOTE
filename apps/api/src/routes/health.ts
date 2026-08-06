import type { FastifyInstance } from 'fastify';
import { isPushConfigured } from '@iasaude/integrations';
import { db } from '@iasaude/db';
import { providerFor } from '@iasaude/whatsapp';
import { SARA_INSTANCE, AGENT_INSTANCE } from '@iasaude/shared';
import { getRedisClient } from '../queue-config.js';
import { loadPrompts } from '../config/prompts.js';

const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';

// Cache do ping LLM — não custar latência a cada probe de readiness.
let llmCache: { ok: boolean; detail: string; at: number } | null = null;
const LLM_CACHE_MS = 5 * 60_000;

async function withTimeout<T>(p: PromiseLike<T>, ms: number, label = 'op'): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, rej) => {
    timer = setTimeout(() => rej(new Error(`${label} timeout ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([Promise.resolve(p), timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

async function checkDb(): Promise<{ ok: boolean; detail?: string }> {
  try {
    const { error } = await withTimeout(db.from('users').select('id').limit(1), 3000, 'db');
    return error ? { ok: false, detail: error.message } : { ok: true };
  } catch (e) {
    return { ok: false, detail: String(e).slice(0, 120) };
  }
}

async function checkRedis(): Promise<{ ok: boolean; detail?: string }> {
  try {
    const pong = await withTimeout(getRedisClient().ping(), 2000, 'redis');
    return pong === 'PONG' ? { ok: true } : { ok: false, detail: `resp=${pong}` };
  } catch (e) {
    return { ok: false, detail: String(e).slice(0, 120) };
  }
}

/**
 * Ping leve à LLM (F0.1): GET /key valida a chave OpenRouter — detecta o 401
 * que deixaria a Xarlote muda — com CUSTO ZERO de tokens. Cacheado 5min.
 */
async function checkLlm(force = false): Promise<{ ok: boolean; detail?: string; cached?: boolean }> {
  if (!force && llmCache && Date.now() - llmCache.at < LLM_CACHE_MS) {
    return { ok: llmCache.ok, detail: llmCache.detail, cached: true };
  }
  let result: { ok: boolean; detail: string };
  try {
    const key = loadPrompts().llm_api_key || process.env['OPENROUTER_API_KEY'] || '';
    if (!key) {
      result = { ok: false, detail: 'sem API key' };
    } else {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 5000);
      try {
        const res = await fetch(`${OPENROUTER_BASE}/key`, {
          headers: { Authorization: `Bearer ${key}` },
          signal: ctrl.signal,
        });
        result = { ok: res.ok, detail: `HTTP ${res.status}` };
      } finally {
        clearTimeout(t);
      }
    }
  } catch (e) {
    result = { ok: false, detail: String(e).slice(0, 120) };
  }
  llmCache = { ...result, at: Date.now() };
  return result;
}

export async function healthRoute(app: FastifyInstance) {
  // Liveness — barato, sempre 200 se o processo está vivo. É o healthcheck do
  // Railway (railway.toml healthcheckPath=/health): só reinicia se o processo
  // morrer, não em blip transitório de dependência.
  app.get('/health', async (_req, reply) => {
    return reply.send({
      ok: true,
      whatsapp_mode: process.env['WHATSAPP_MODE'] ?? 'live',
      wa_provider_sara: providerFor(SARA_INSTANCE),
      wa_provider_agent: providerFor(AGENT_INSTANCE),
      // Push silenciosamente morto era INVISÍVEL (auditoria 05/08: isPushConfigured
      // existia e ninguém chamava) — agora o /health conta a verdade.
      push_configured: isPushConfigured(),
      uptime_s: Math.round(process.uptime()),
      ts: new Date().toISOString(),
    });
  });

  // Readiness (F1.B5) — verifica dependências. 503 se DB ou Redis (críticos
  // pra servir) caírem. O ping LLM é INFORMATIVO (não derruba readiness, pois
  // há fallback chain) e cacheado 5min; force a revalidação com ?llm=1.
  app.get('/ready', async (req, reply) => {
    const forceLlm = (req.query as { llm?: string } | undefined)?.llm === '1';
    const [dbR, redisR, llmR] = await Promise.all([checkDb(), checkRedis(), checkLlm(forceLlm)]);
    const critical = dbR.ok && redisR.ok;
    return reply.code(critical ? 200 : 503).send({
      ok: critical,
      checks: { db: dbR, redis: redisR, llm: llmR },
      ts: new Date().toISOString(),
    });
  });
}
