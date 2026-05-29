import type { ConnectionOptions } from 'bullmq';
import IORedis, { type Redis } from 'ioredis';

function redisUrl(): string {
  return process.env['REDIS_URL'] ?? 'redis://localhost:6379';
}

export function getRedisConnection(): ConnectionOptions {
  return { url: redisUrl() };
}

let sharedClient: Redis | null = null;

/**
 * Client Redis compartilhado (vivo) pra usos FORA de fila BullMQ: health-check
 * (/ready), rate-limit por usuário, etc. Lazy + singleton. Fechado no graceful
 * shutdown via closeRedisClient(). Erros são silenciados aqui — quem usa trata
 * a falha (health reporta, rate-limit faz fail-open).
 */
export function getRedisClient(): Redis {
  if (!sharedClient) {
    sharedClient = new IORedis(redisUrl(), {
      maxRetriesPerRequest: 2,
      lazyConnect: false,
    });
    // Sem listener de 'error', ioredis derruba o processo em queda do Redis.
    sharedClient.on('error', () => { /* tratado por quem consome */ });
  }
  return sharedClient;
}

export async function closeRedisClient(): Promise<void> {
  if (sharedClient) {
    try {
      await sharedClient.quit();
    } catch {
      /* ignore */
    }
    sharedClient = null;
  }
}
