/**
 * As duas filas de LGPD: apagar a conta e exportar os dados.
 *
 * ## Por que fila, e não inline no request
 *
 * O apagamento toca ~30 tabelas, três buckets de Storage e uma função SQL. O export lê
 * tudo isso e serializa. São segundos de trabalho — o suficiente para o request estourar
 * numa rede móvel, e o paciente ficar sem saber se aconteceu.
 *
 * **O que NÃO espera pela fila é o acesso.** A rota revoga sessões e aparelhos ANTES de
 * enfileirar: no instante em que o paciente confirma, ele deixa de ser alcançável, mesmo
 * que a fila leve um minuto. Fosse o contrário, a janela entre "confirmei" e "o worker
 * pegou" seria uma janela em que o prontuário segue aberto.
 *
 * ## Retry é obrigatório aqui, não zelo
 *
 * A versão anterior do apagamento não tinha retry: uma falha transitória de rede no meio
 * deixava dado para trás e o paciente era avisado que tudo havia sido apagado. Com
 * `attempts: 5` e o executor lançando quando sobra linha (`handlers/forget-me.ts`, passo
 * 9), a operação insiste até ficar completa — ou falha alto, o que é o segundo melhor.
 */
import { Queue } from 'bullmq';
import { QUEUE_NAMES } from '@iasaude/shared';
import { writeLog } from '@iasaude/db';
import { getRedisConnection } from '../queue-config.js';

export interface AccountForgetJob {
  userId: string;
  /** De onde veio o pedido — vai pro audit_log e pro consent_events. */
  canal: 'whatsapp' | 'app';
  traceId: string;
  conversationId?: string;
  /**
   * O telefone COMO ERA antes de qualquer escrita. O executor anonimiza `users` no
   * passo 8; sem isto, a retentativa lê `deleted-<id>` e perde a única chave que
   * alcança `webhook_events` (payload cru com o número dentro do JSON).
   */
  phoneE164?: string;
}

export interface DataExportJob {
  userId: string;
  /** A linha de `app_exports` que o worker vai preencher. */
  exportId: string;
  traceId: string;
}

let filaApagar: Queue<AccountForgetJob> | null = null;
let filaExportar: Queue<DataExportJob> | null = null;

function getFilaApagar(): Queue<AccountForgetJob> {
  if (!filaApagar) {
    filaApagar = new Queue<AccountForgetJob>(QUEUE_NAMES.ACCOUNT_FORGET, {
      connection: getRedisConnection(),
      defaultJobOptions: {
        // 5 tentativas, backoff longo: se o banco está instável, insistir de 2 em 2
        // segundos não ajuda. O que importa é chegar ao fim, não chegar rápido.
        attempts: 5,
        backoff: { type: 'exponential', delay: 10_000 },
        // O job fica MUITO mais tempo que os outros: um apagamento que falhou cinco
        // vezes é um incidente de compliance, e alguém vai querer olhar o job.
        removeOnComplete: { age: 30 * 24 * 3_600, count: 500 },
        removeOnFail: false,
      },
    });
  }
  return filaApagar;
}

function getFilaExportar(): Queue<DataExportJob> {
  if (!filaExportar) {
    filaExportar = new Queue<DataExportJob>(QUEUE_NAMES.DATA_EXPORT, {
      connection: getRedisConnection(),
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5_000 },
        removeOnComplete: { age: 7 * 24 * 3_600, count: 200 },
        removeOnFail: { age: 30 * 24 * 3_600, count: 200 },
      },
    });
  }
  return filaExportar;
}

/**
 * Enfileira o apagamento.
 *
 * `jobId = userId` dá idempotência: o paciente que toca duas vezes em "apagar" não gera
 * dois apagamentos concorrentes disputando as mesmas linhas.
 *
 * ⚠️ Devolve `false` quando o Redis está fora — e nesse caso quem chama **não pode
 * responder 202**. Dizer ao paciente que a conta será apagada sem ter nada enfileirado
 * seria a pior mentira que este sistema é capaz de contar.
 */
export async function enqueueAccountForget(job: AccountForgetJob): Promise<boolean> {
  try {
    const fila = getFilaApagar();
    const jobId = `forget-${job.userId}`;

    /**
     * ⚠️ `jobId` FIXO + `removeOnFail: false` = PORTA TRANCADA (auditoria 22/09).
     *
     * O BullMQ devolve o job existente em QUALQUER estado — inclusive `failed`. Como o
     * apagamento guarda os falhos para sempre (de propósito: é incidente de compliance),
     * um apagamento que falhou cinco vezes fazia todo pedido novo do mesmo paciente
     * virar no-op silencioso, com a rota respondendo 202 "vai ser apagado". O direito do
     * titular ficava preso num job morto que ninguém olhava.
     *
     * Um pedido novo em cima de um job falho é exatamente o caso de RETOMAR.
     */
    const existente = await fila.getJob(jobId);
    if (existente && (await existente.isFailed())) {
      await writeLog('warn', 'lgpd', 'pedido de apagamento reabriu um job que havia FALHADO — retomando', {
        userId: job.userId,
        traceId: job.traceId,
      });
      // `retry()` reaproveita a linha do job; os dados novos (traceId/telefone) só
      // importam se o job antigo não os tinha — por isso o update antes.
      await existente.updateData({ ...existente.data, ...job });
      await existente.retry();
      return true;
    }

    await fila.add('account-forget', job, { jobId });
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await writeLog('error', 'lgpd', `enfileiramento de apagamento falhou: ${msg.slice(0, 160)}`, {
      userId: job.userId,
      traceId: job.traceId,
    });
    return false;
  }
}

export async function enqueueDataExport(job: DataExportJob): Promise<boolean> {
  try {
    await getFilaExportar().add('data-export', job, { jobId: job.exportId });
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await writeLog('error', 'lgpd', `enfileiramento de export falhou: ${msg.slice(0, 160)}`, {
      userId: job.userId,
      traceId: job.traceId,
    });
    return false;
  }
}

export async function closeLgpdQueues(): Promise<void> {
  if (filaApagar) {
    await filaApagar.close();
    filaApagar = null;
  }
  if (filaExportar) {
    await filaExportar.close();
    filaExportar = null;
  }
}
