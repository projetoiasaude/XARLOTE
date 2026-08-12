/**
 * Os dois workers de LGPD: apagar a conta e gerar o export.
 *
 * ## `concurrency: 1` no apagamento, de propósito
 *
 * O apagamento faz leitura-decisão-escrita sobre ~30 tabelas e, no passo dos fios
 * compartilhados, DECIDE com base em quantos outros pacientes restam num fio. Dois
 * apagamentos concorrentes que compartilhem um fio de farmácia podem ler o mesmo estado e
 * cada um concluir que o outro "não está lá" — apagando mensagens que o outro ainda
 * contava. Serializar custa alguns segundos por conta e elimina a classe inteira.
 *
 * ## Falha aqui é INCIDENTE, não erro de rotina
 *
 * Um apagamento que esgotou as 5 tentativas significa dado de um titular que pediu
 * exclusão continuando no banco, com o paciente já avisado de que sumiu. O log final é
 * `error` (o anomaly-detector pega) e o job NÃO é removido — alguém precisa olhar.
 */
import { Worker } from 'bullmq';
import { QUEUE_NAMES } from '@iasaude/shared';
import { db, writeLog } from '@iasaude/db';
import { getRedisConnection } from '../queue-config.js';
import { executeForgetMe } from '../handlers/forget-me.js';
import { buildExport } from '../lib/app-export.js';
import type { AccountForgetJob, DataExportJob } from '../queues/lgpd.queue.js';

let workerApagar: Worker<AccountForgetJob> | null = null;
let workerExportar: Worker<DataExportJob> | null = null;

export function startAccountForgetWorker(): void {
  if (workerApagar) return;

  workerApagar = new Worker<AccountForgetJob>(
    QUEUE_NAMES.ACCOUNT_FORGET,
    async (job) => {
      const relatorio = await executeForgetMe(job.data.userId, {
        traceId: job.data.traceId,
        canal: job.data.canal,
        ...(job.data.conversationId ? { conversationId: job.data.conversationId } : {}),
      });
      // Sem PII: contagens. O relatório completo já foi ao audit_log pelo executor.
      await writeLog('info', 'lgpd', 'apagamento concluído e verificado', {
        userId: job.data.userId,
        traceId: job.data.traceId,
        tabelas: Object.keys(relatorio.tabelas).length,
        mensagens: relatorio.mensagensApagadas,
        fiosRedigidos: relatorio.fiosCompartilhadosRedigidos,
      });
    },
    // Ver o cabeçalho: 1 é a decisão, não um valor conservador por falta de ideia.
    { connection: getRedisConnection(), concurrency: 1 },
  );

  workerApagar.on('failed', (job, err) => {
    const ultima = (job?.attemptsMade ?? 0) >= (job?.opts.attempts ?? 5);
    void writeLog(
      'error',
      'lgpd',
      ultima
        ? `APAGAMENTO NÃO CONCLUÍDO depois de todas as tentativas: ${err.message.slice(0, 200)}`
        : `apagamento falhou (tentativa ${job?.attemptsMade ?? 0}), vai tentar de novo: ${err.message.slice(0, 160)}`,
      { userId: job?.data.userId, traceId: job?.data.traceId },
    );
  });
}

export function startDataExportWorker(): void {
  if (workerExportar) return;

  workerExportar = new Worker<DataExportJob>(
    QUEUE_NAMES.DATA_EXPORT,
    async (job) => {
      const { userId, exportId } = job.data;
      const agoraIso = new Date().toISOString();
      const { conteudo, bytes, mensagens, truncado } = await buildExport(userId, agoraIso);

      // Caminho com o userId no prefixo: o bucket é privado e a leitura é só por signed
      // URL emitida pela API a quem é dono, mas o prefixo torna a limpeza do apagamento
      // trivial e uma política de bucket possível depois, se precisar.
      const caminho = `${userId}/xarlote-dados-${agoraIso.slice(0, 10)}-${exportId.slice(0, 8)}.json`;

      const { error: errUpload } = await db.storage
        .from('xarlote-exports')
        .upload(caminho, Buffer.from(conteudo, 'utf8'), {
          contentType: 'application/json; charset=utf-8',
          upsert: true,
        });
      if (errUpload) throw new Error(`upload do export falhou: ${errUpload.message}`);

      const { error: errUpdate } = await db
        .from('app_exports')
        .update({ status: 'ready', storage_path: caminho, completed_at: new Date().toISOString() })
        .eq('id', exportId);
      // Arquivo no Storage e linha em `pending` = export invisível pro paciente. Relança
      // pro retry; o upload é `upsert`, então repetir não duplica arquivo.
      if (errUpdate) throw new Error(`marcar export como pronto falhou: ${errUpdate.message}`);

      await writeLog('info', 'lgpd', 'export de dados gerado', {
        userId,
        traceId: job.data.traceId,
        bytes,
        mensagens,
        truncado,
      });
    },
    { connection: getRedisConnection(), concurrency: 2 },
  );

  workerExportar.on('failed', (job, err) => {
    const ultima = (job?.attemptsMade ?? 0) >= (job?.opts.attempts ?? 3);
    if (ultima && job?.data.exportId) {
      // Marca `failed` no banco: sem isto a tela do paciente mostraria "preparando" pra
      // sempre — um estado que nunca resolve e não explica nada.
      void db
        .from('app_exports')
        .update({ status: 'failed', error: err.message.slice(0, 300) })
        .eq('id', job.data.exportId);
    }
    void writeLog('error', 'lgpd', `export falhou (tentativa ${job?.attemptsMade ?? 0}): ${err.message.slice(0, 160)}`, {
      userId: job?.data.userId,
      traceId: job?.data.traceId,
    });
  });
}

export async function stopLgpdWorkers(): Promise<void> {
  await workerApagar?.close();
  await workerExportar?.close();
  workerApagar = null;
  workerExportar = null;
}
