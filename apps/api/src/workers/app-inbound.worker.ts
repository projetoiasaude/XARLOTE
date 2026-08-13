/**
 * Worker das mensagens do app — o turno da LLM que saiu de dentro do request HTTP.
 *
 * Ele é deliberadamente FINO: monta o `NormalizedInbound` e chama
 * `processInboundUser`, o mesmo caminho do WhatsApp, sem nenhum desvio. Todo o
 * comportamento da Xarlote (memória, ferramentas, guardas clínicas, red flags) vem de
 * graça e continua tendo UMA implementação só. Um pipeline paralelo pro app seria a
 * receita para as duas pernas divergirem — e divergência aqui significa a Xarlote se
 * comportando diferente conforme o canal, que é o pior tipo de bug pra depurar.
 *
 * `concurrency` maior que 1 é seguro porque o inbound é por paciente e o
 * `processInboundUser` já é reentrante; o que serializa por usuário é o lock do
 * enricher, mais adiante no fluxo.
 */
import { Worker } from 'bullmq';
import { QUEUE_NAMES } from '@iasaude/shared';
import { writeLog } from '@iasaude/db';
import { getRedisConnection } from '../queue-config.js';
import { processInboundUser } from '../handlers/inbound-user.js';
import { buildAppInbound } from '../lib/app-inbound.js';
import type { AppInboundJob } from '../queues/app-inbound.queue.js';

let worker: Worker<AppInboundJob> | null = null;

export function startAppInboundWorker(): void {
  if (worker) return;

  worker = new Worker<AppInboundJob>(
    QUEUE_NAMES.APP_INBOUND,
    async (job) => {
      const { phoneE164, clientId, text, sentAtMs, media } = job.data;
      const inbound = buildAppInbound({ phoneE164, clientId, text, sentAtMs, ...(media ? { media } : {}) });
      await processInboundUser(inbound);
    },
    { connection: getRedisConnection(), concurrency: 4 },
  );

  worker.on('failed', (job, err) => {
    // Sem texto e sem telefone no log: é conteúdo clínico. O clientId basta pra
    // correlacionar com a linha em `messages` (external_id = app-<clientId>).
    void writeLog(
      'error',
      'app-inbound',
      `turno do app falhou (tentativa ${job?.attemptsMade ?? 0}): ${err.message.slice(0, 140)}`,
      { clientId: job?.data.clientId },
    );
  });
}

export async function stopAppInboundWorker(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
  }
}
