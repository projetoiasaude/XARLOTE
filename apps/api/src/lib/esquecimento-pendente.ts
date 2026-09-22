/**
 * A marca de "esta pessoa pediu pra ser esquecida", com prazo.
 *
 * ## Por que Redis e não banco
 *
 * É estado de 15 minutos que existe pra tornar o apagamento um ato de DOIS passos. Não
 * é dado do paciente (some sozinho), não é auditoria (a auditoria é `audit_log`), e num
 * JSONB de `users.metadata` entraria na fila dos seis escritores que se sobrescrevem
 * (achado P1-29 da mesma auditoria). `SET … EX` resolve com uma linha e expira sozinho.
 *
 * ## A direção da falha
 *
 * Redis fora → `consumir` devolve `null` → a decisão vira "pergunta de novo", nunca
 * "apaga". Perder um pedido custa uma repetição; apagar por engano não tem volta.
 *
 * `GETDEL` torna a confirmação de uso único: duas mensagens "CONFIRMO APAGAR" seguidas
 * não disparam dois apagamentos concorrentes disputando as mesmas linhas.
 */
import { JANELA_DE_CONFIRMACAO_MS } from '@iasaude/shared';
import { getRedisClient } from '../queue-config.js';

const TTL_S = Math.ceil(JANELA_DE_CONFIRMACAO_MS / 1000);

function chave(userId: string): string {
  return `lgpd:esquecimento:pendente:${userId}`;
}

/** Registra o pedido. Falha de Redis é logada por quem chama — aqui só não explode. */
export async function marcarPedidoDeEsquecimento(userId: string): Promise<boolean> {
  try {
    await getRedisClient().set(chave(userId), String(Date.now()), 'EX', TTL_S);
    return true;
  } catch {
    return false;
  }
}

/**
 * Lê E CONSOME o pedido (uso único). Devolve o instante em que foi feito, ou `null`
 * quando não há pedido — inclusive quando o Redis está fora.
 */
export async function consumirPedidoDeEsquecimento(userId: string): Promise<number | null> {
  const k = chave(userId);
  try {
    const redis = getRedisClient();
    let cru: string | null;
    try {
      cru = await redis.getdel(k);
    } catch {
      // Redis < 6.2 não tem GETDEL. A janela entre GET e DEL é estreita e o custo dela é
      // baixo: dois "CONFIRMO APAGAR" no mesmo instante caem no mesmo `jobId` da fila, que
      // colapsa os dois num apagamento só.
      cru = await redis.get(k);
      if (cru !== null) await redis.del(k);
    }
    if (cru === null) return null;
    const ms = Number(cru);
    return Number.isFinite(ms) ? ms : null;
  } catch {
    return null;
  }
}
