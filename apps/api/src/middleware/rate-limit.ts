import { getRedisClient } from '../queue-config.js';

export interface RateLimitResult {
  allowed: boolean;
  count: number;
  limit: number;
}

/**
 * Rate-limit por usuário (F2.G5) — anti-flood/abuso. Janela fixa via Redis
 * (INCR + EXPIRE). Default generoso (25 msgs / 20s): humano normal nunca bate,
 * só pega flood/bot que estouraria custo de LLM e profundidade de fila.
 *
 * FAIL-OPEN: qualquer erro de Redis libera a mensagem — nunca derruba um
 * usuário legítimo por causa de infra. Desligável com USER_RATE_LIMIT_ENABLED=false.
 */
export async function checkUserRateLimit(key: string): Promise<RateLimitResult> {
  const limit = Number(process.env['USER_RATE_LIMIT_MAX'] ?? 25);
  const windowS = Number(process.env['USER_RATE_LIMIT_WINDOW_S'] ?? 20);

  if (process.env['USER_RATE_LIMIT_ENABLED'] === 'false') {
    return { allowed: true, count: 0, limit };
  }

  try {
    const redis = getRedisClient();
    const rk = `rl:user:${key}`;
    const count = await redis.incr(rk);
    if (count === 1) await redis.expire(rk, windowS);
    return { allowed: count <= limit, count, limit };
  } catch {
    return { allowed: true, count: 0, limit };
  }
}
