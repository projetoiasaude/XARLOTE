/**
 * Lock de cron distribuído (F1.A2) — garante que cada janela de um cron roda em
 * UMA réplica só, mesmo com N processos worker. Sem isto, escalar o service
 * worker pra 2+ réplicas dispararia reminder/red-flag/compactor/dispatcher EM
 * DOBRO (mensagens duplicadas, escalonamento de emergência repetido, etc).
 *
 * Implementação: chave por JANELA de tempo (wall-clock) + Redis `SET NX PX`.
 *   key = cron:lock:<name>:<floor(now/interval)>   TTL = interval
 * Todas as réplicas calculam o MESMO índice de janela para um dado instante, então
 * a primeira a chegar naquela janela adquire e roda; as outras (mesma janela)
 * pulam. A janela seguinte tem outra chave — sem carry-over flaky entre o run
 * inicial (boot) e o primeiro tick do setInterval. A chave expira sozinha no fim
 * da janela (TTL), então não há release manual nem risco de lock preso.
 *
 * NÃO usa pg advisory lock: o acesso ao banco é via PostgREST (supabase-js) e
 * advisory locks são por-SESSÃO — não sobrevivem ao pool do PostgREST. O Redis já
 * está no stack (filas/rate-limit) → custo zero.
 *
 * Fail-open: se o Redis estiver fora, RODA assim mesmo (não trava o cron num
 * deploy single-replica) — mesma filosofia do rate-limit. Double-run só é possível
 * com Redis-down E múltiplas réplicas (degradado/raro), e os scans são
 * majoritariamente idempotentes. Perder no máx. um tick após um crash é
 * explicitamente tolerado pelo design (scans re-rodam na próxima janela).
 *
 * Consumers de fila BullMQ (profile-enricher, outbound) NÃO precisam disto — o
 * BullMQ já entrega cada job a um worker só; N réplicas apenas competem.
 */
import { randomUUID } from 'crypto';
import { writeLog } from '@iasaude/db';
import { getRedisClient } from '../queue-config.js';

// Id deste processo — gravado como valor do lock só pra debug (quem pegou a janela).
const HOLDER = randomUUID();

/**
 * Roda `fn` só se for o dono da janela atual de `name` (janela = intervalMs).
 * Se outra réplica já pegou esta janela, retorna sem rodar.
 */
export async function withCronLock(name: string, intervalMs: number, fn: () => Promise<void>): Promise<void> {
  const interval = Math.max(1000, Math.floor(intervalMs));
  const windowIdx = Math.floor(Date.now() / interval);
  const key = `cron:lock:${name}:${windowIdx}`;
  let acquired = false;
  try {
    // ioredis: set(key, val, 'PX', ms, 'NX') → 'OK' se adquiriu, null se já existe.
    const res = await getRedisClient().set(key, HOLDER, 'PX', interval, 'NX');
    acquired = res === 'OK';
  } catch (err) {
    // Redis indisponível → fail-open: roda pra não parar o cron (single-replica ok).
    await writeLog('warn', 'cron', `lock indisponível p/ "${name}" — rodando sem lock: ${String(err).slice(0, 120)}`);
    await fn();
    return;
  }
  if (!acquired) return; // outra réplica já pegou esta janela — skip silencioso
  await fn();
}
