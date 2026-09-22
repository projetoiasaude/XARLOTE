import type { ConnectionOptions } from 'bullmq';
import IORedis, { type Redis } from 'ioredis';

function redisUrl(): string {
  return process.env['REDIS_URL'] ?? 'redis://localhost:6379';
}

export function getRedisConnection(): ConnectionOptions {
  return { url: redisUrl() };
}

/**
 * Conexão para PRODUTOR de fila (`Queue.add`), com a offline-queue DESLIGADA.
 *
 * ⚠️ O ioredis, por padrão, ENFILEIRA em memória o comando enviado enquanto a conexão
 * está caída e o executa quando o Redis volta. Com isso, o `add` que "estourou o
 * timeout" de 2s do `withQueueRetry` não era cancelado (Promise.race não cancela o
 * perdedor): o fallback mandava a mensagem direto e, minutos depois, o `add` fantasma
 * criava o job — que saía de novo pelo worker, num processo onde a trava local não
 * existe e a chave do Redis nunca foi gravada. É o mecanismo mais plausível das
 * duplicatas de 27/07 e 30/07.
 *
 * Com `enableOfflineQueue: false` o `add` REJEITA na hora: o fallback direto acontece
 * uma vez e não há fantasma. Só vale para produtor — Worker precisa da fila offline
 * para os comandos bloqueantes.
 */
export function getProducerConnection(): ConnectionOptions {
  return { url: redisUrl(), enableOfflineQueue: false };
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
