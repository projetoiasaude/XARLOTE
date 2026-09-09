/**
 * Fila de busca de exames no portal do laboratório.
 *
 * O que a diferencia das outras filas: **o payload carrega credencial** (cifrada — ver
 * `lib/lab-vault.ts`). Por isso:
 *   • `removeOnComplete: true` e `removeOnFail: true` — nada de guardar o job por 30 dias
 *     como o apagamento LGPD faz. Terminou, sumiu.
 *   • `attempts: 1` — retry aqui é tentar a senha de novo num portal que já recusou, e isso
 *     é caminho de bloqueio de conta. Se falhou, a pessoa é avisada e decide.
 *   • um único job por (pessoa) por vez: `jobId` determinístico com a linha de `lab_fetches`.
 */
import { Queue } from 'bullmq';
import { QUEUE_NAMES } from '@iasaude/shared';
import { getRedisConnection } from '../queue-config.js';

export interface LabFetchJob {
  /** A linha de `lab_fetches` que o worker vai preencher. */
  fetchId: string;
  userId: string;
  conversationId: string;
  phoneE164: string;
  traceId: string;
  laboratorio: string | null;
  portalUrl: string | null;
  /** `cifrar(JSON.stringify(CredenciaisLab))` — só o worker abre. */
  credenciaisCifradas: string;
}

let fila: Queue<LabFetchJob> | null = null;

function getFila(): Queue<LabFetchJob> {
  if (!fila) {
    fila = new Queue<LabFetchJob>(QUEUE_NAMES.LAB_FETCH, {
      connection: getRedisConnection(),
      defaultJobOptions: {
        attempts: 1,
        removeOnComplete: true,
        removeOnFail: true,
      },
    });
  }
  return fila;
}

export async function enqueueLabFetch(job: LabFetchJob): Promise<void> {
  await getFila().add('lab-fetch', job, { jobId: `lab-fetch-${job.fetchId}` });
}

export async function closeLabFetchQueue(): Promise<void> {
  if (fila) { await fila.close(); fila = null; }
}
