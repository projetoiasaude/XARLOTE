/**
 * Fila das mensagens do app.
 *
 * O motivo de existir é um teto de throughput real: o `POST /app/inbound` legado
 * chamava `processInboundUser` DENTRO do request, então a conexão HTTP ficava aberta
 * os 5 a 15 segundos do turno da LLM. Com 26 pacientes passa; com centenas, os
 * workers HTTP acabam e o app inteiro fica lento — inclusive pra quem só quer ler.
 *
 * Agora o request só enfileira e responde 202. O turno acontece no worker, e o
 * paciente vê a resposta chegar pelo SSE.
 *
 * `jobId = clientId` é o que dá idempotência: o BullMQ recusa job repetido com o
 * mesmo id, então toque duplo no botão não vira dois turnos da LLM (nem duas
 * cobranças de token). O índice único do banco é o segundo cinto, pro caso de a fila
 * ser reprocessada depois de um restart.
 */
import { Queue } from 'bullmq';
import { QUEUE_NAMES } from '@iasaude/shared';
import { writeLog } from '@iasaude/db';
import { getRedisConnection } from '../queue-config.js';

export interface AppInboundJob {
  userId: string;
  /** Telefone CANÔNICO do usuário existente (a rota já resolveu o 9º dígito). */
  phoneE164: string;
  clientId: string;
  text: string;
  sentAtMs: number;
}

let queue: Queue<AppInboundJob> | null = null;

function getQueue(): Queue<AppInboundJob> {
  if (!queue) {
    queue = new Queue<AppInboundJob>(QUEUE_NAMES.APP_INBOUND, {
      connection: getRedisConnection(),
      defaultJobOptions: {
        // 3 tentativas com backoff: falha de rede na LLM é comum e transitória.
        attempts: 3,
        backoff: { type: 'exponential', delay: 2_000 },
        // Mantém o histórico curto — o job carrega texto do paciente (dado clínico),
        // e fila não é lugar de arquivo. O que precisa durar vive em `messages`.
        removeOnComplete: { age: 3_600, count: 200 },
        removeOnFail: { age: 24 * 3_600, count: 200 },
      },
    });
  }
  return queue;
}

export type EnqueueResult = 'enqueued' | 'unavailable';

/**
 * Enfileira. Só dois desfechos, e o que NÃO existe aqui é intencional:
 *
 *   `enqueued`    → 202. Cobre também o reenvio com o MESMO clientId: o BullMQ
 *                   devolve o job que já existe, em silêncio, sem criar um segundo.
 *                   Isso é o comportamento certo e não precisa de aviso — a mensagem
 *                   está a caminho de qualquer jeito. Se respondêssemos erro, o app
 *                   marcaria como falha algo que vai ser entregue, e o paciente
 *                   reenviaria com um clientId NOVO — aí sim duplicando de verdade.
 *   `unavailable` → 503. Redis fora, nada foi aceito; o app guarda pra tentar depois.
 */
export async function enqueueAppInbound(job: AppInboundJob): Promise<EnqueueResult> {
  try {
    await getQueue().add('app-inbound', job, { jobId: job.clientId });
    return 'enqueued';
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Sem PII: o telefone e o texto do paciente NUNCA entram no log.
    await writeLog('error', 'app-inbound', `enfileiramento falhou: ${msg.slice(0, 120)}`, {});
    return 'unavailable';
  }
}

export async function closeAppInboundQueue(): Promise<void> {
  if (queue) {
    await queue.close();
    queue = null;
  }
}
