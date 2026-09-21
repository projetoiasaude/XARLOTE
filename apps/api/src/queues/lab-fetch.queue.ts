/**
 * Fila de busca de exames no portal do laboratório.
 *
 * v2 (21/09/2026): o job NÃO carrega credencial. O acesso fica cifrado na linha de
 * `lab_fetches` (lib/lab-vault.ts) enquanto a busca está pendente; o worker lê, usa uma vez e
 * apaga. O job é só "qual linha" e "o que fazer" — reconhecer o portal ou buscar.
 *   • `attempts: 1` — retry aqui é tentar a senha de novo num portal que já recusou.
 *   • `jobId` determinístico por (linha, kind): a fila deduplica.
 */
import { Queue } from 'bullmq';
import { QUEUE_NAMES } from '@iasaude/shared';
import { getRedisConnection } from '../queue-config.js';

export interface LabFetchJob {
  /** 'reconhecer' = provar que dá pra entrar (sem digitar) antes de prometer a data; 'buscar' = a busca. */
  kind: 'reconhecer' | 'buscar';
  /** A linha de `lab_fetches`. */
  fetchId: string;
  traceId: string;
}

let fila: Queue<LabFetchJob> | null = null;

function getFila(): Queue<LabFetchJob> {
  if (!fila) {
    fila = new Queue<LabFetchJob>(QUEUE_NAMES.LAB_FETCH, {
      connection: getRedisConnection(),
      defaultJobOptions: { attempts: 1, removeOnComplete: true, removeOnFail: true },
    });
  }
  return fila;
}

export async function enqueueLabFetch(job: LabFetchJob): Promise<void> {
  await getFila().add(job.kind, job, { jobId: `lab-${job.kind}-${job.fetchId}` });
}

export async function closeLabFetchQueue(): Promise<void> {
  if (fila) { await fila.close(); fila = null; }
}
