/**
 * Mutex por-usuário (escala-segura, Fase 2) — Redis `SET NX PX`.
 *
 * Por quê: o profile-enricher faz check-then-insert (SELECT … then INSERT se não
 * existe) em user_allergies / conditions / medications / addresses. Com o worker
 * em `concurrency > 1` e/ou N réplicas, DOIS jobs do MESMO usuário (janelas de
 * turno sobrepostas) podem passar pela checagem ao mesmo tempo e inserir o mesmo
 * fato em DOBRO. Serializar a fase de escrita por usuário mata essa corrida sem
 * depender de constraint de schema (que exigiria dedup + lower()-index arriscados
 * num banco vivo).
 *
 * Reusa o mesmo padrão do cron-lock (SET NX PX): a 1ª chamada adquire; as demais
 * esperam (poll curto) até liberar, dentro de uma janela. Fail-open: se o Redis
 * estiver fora, roda sem lock (degradado, mas nunca trava o enricher). Release
 * só se ainda formos o dono (não derruba lock de outro após o TTL expirar).
 */
import { randomUUID } from 'crypto';
import { writeLog } from '@iasaude/db';
import { getRedisClient } from '../queue-config.js';

interface UserLockOpts {
  /** TTL do lock (auto-libera mesmo se o processo morrer). Default 45s. */
  ttlMs?: number;
  /** Quanto tempo esperar o lock liberar antes de desistir. Default 8s. */
  waitMs?: number;
  /** Namespace do lock (permite locks distintos por finalidade). Default 'user'. */
  scope?: string;
}

/**
 * Roda `fn` com exclusão mútua por `userId`. Retorna o resultado de `fn`, ou
 * `null` se o lock estava ocupado e não liberou dentro de `waitMs` (a rodada é
 * pulada — o próximo turno re-tenta).
 */
export async function withUserLock<T>(
  userId: string,
  fn: () => Promise<T>,
  opts: UserLockOpts = {},
): Promise<T | null> {
  const ttl = Math.max(1000, opts.ttlMs ?? 45_000);
  const maxWait = Math.max(0, opts.waitMs ?? 8_000);
  const key = `lock:${opts.scope ?? 'user'}:${userId}`;
  const holder = randomUUID();
  const deadline = Date.now() + maxWait;
  let acquired = false;

  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const res = await getRedisClient().set(key, holder, 'PX', ttl, 'NX');
      if (res === 'OK') { acquired = true; break; }
      if (Date.now() >= deadline) break;
      // backoff curto + jitter pra não martelar o Redis nem sincronizar waiters
      await new Promise((r) => setTimeout(r, 150 + Math.floor(Math.random() * 120)));
    }
  } catch (err) {
    // Redis indisponível → fail-open (mesma filosofia do cron-lock / rate-limit).
    await writeLog('warn', 'lock', `user-lock indisponível (${key}) — rodando sem lock: ${String(err).slice(0, 120)}`);
    return fn();
  }

  if (!acquired) {
    await writeLog('info', 'lock', `user-lock ocupado (${key}) — pulando esta rodada (re-tenta no próximo turno)`);
    return null;
  }

  try {
    return await fn();
  } finally {
    // Release ATÔMICO (compare-and-delete via Lua): só apaga se ainda formos o dono.
    // GET+DEL separados teriam um TOCTOU — entre o GET e o DEL o TTL podia expirar e
    // outro processo adquirir, e aí o DEL apagaria o lock DELE. O EVAL faz os dois
    // num passo só. (Se falhar, o TTL limpa sozinho.)
    try {
      await getRedisClient().eval(
        "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
        1,
        key,
        holder,
      );
    } catch { /* TTL cuida disso */ }
  }
}
