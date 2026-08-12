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
    await getFilaApagar().add('account-forget', job, { jobId: `forget-${job.userId}` });
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
