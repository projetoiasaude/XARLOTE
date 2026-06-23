/**
 * Fila de envio WhatsApp com RATE-LIMIT (F0.7).
 *
 * Por quê: enviar direto via uazapi sem limite = risco de ban (1 número só).
 * Regra do projeto (CLAUDE.md #5): nada de WhatsApp fora da fila outbound.
 *
 * Desenho:
 *   - Uma fila POR NÚMERO (sara e agent são números distintos → limiters
 *     independentes). Cada uma tem seu Worker com `limiter`.
 *   - Produtores chamam `dispatchOutbound(job)`: enfileira; se a fila/Redis
 *     estiver fora, cai pra envio DIRETO (degrada, nunca deixa a Xarlote muda).
 *   - Retry exponencial + backoff pra erros transitórios (429/rede).
 *
 * NÃO passa por aqui: mensagens de emergência (red-flag sendMenu / aviso ao
 * contato), que são enviadas diretamente pra ter prioridade/imediatismo.
 */
import { Queue, Worker, type Job } from 'bullmq';
import { sendText, sendAudio, sendMenu } from '@iasaude/whatsapp';
import { writeLog } from '@iasaude/db';
import { AGENT_INSTANCE, QUEUE_NAMES } from '@iasaude/shared';
import { getRedisConnection } from '../queue-config.js';

export interface OutboundJob {
  kind: 'text' | 'audio' | 'menu';
  instance: string;       // SARA_INSTANCE | AGENT_INSTANCE
  phoneE164: string;
  text?: string;          // texto (kind=text) ou fallback (kind=audio)
  audioBase64?: string;   // buffer de áudio em base64 (kind=audio)
  mime?: string;
  ptv?: boolean;
  buttons?: string[];     // kind=menu
  footerText?: string;
  ticketId?: number | string; // kind=menu no zpro/WABA (botões exigem ticket)
  traceId?: string;
}

const connection = getRedisConnection();

function queueNameFor(instance: string): string {
  return instance === AGENT_INSTANCE ? QUEUE_NAMES.OUTBOUND_AGENT : QUEUE_NAMES.OUTBOUND_SARA;
}

const queues = new Map<string, Queue>();
const outboundWorkers: Worker[] = [];
function queueFor(instance: string): Queue {
  const name = queueNameFor(instance);
  let q = queues.get(name);
  if (!q) {
    q = new Queue(name, {
      connection,
      defaultJobOptions: {
        attempts: 5,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: 1000,
        removeOnFail: 5000,
      },
    });
    queues.set(name, q);
  }
  return q;
}

/** Executa o envio real na uazapi. Áudio cai pra texto se falhar. */
async function rawSend(job: OutboundJob): Promise<void> {
  if (job.kind === 'text') {
    await sendText(job.instance, job.phoneE164, job.text ?? '');
    return;
  }
  if (job.kind === 'menu') {
    await sendMenu(job.instance, job.phoneE164, job.text ?? '', job.buttons ?? [], {
      type: 'button',
      footerText: job.footerText,
      ticketId: job.ticketId,
    });
    return;
  }
  // kind === 'audio'
  try {
    const buf = Buffer.from(job.audioBase64 ?? '', 'base64');
    await sendAudio(job.instance, job.phoneE164, buf, { mime: job.mime ?? 'audio/mpeg', ptv: job.ptv ?? true });
  } catch (err) {
    // Áudio falhou — manda o texto pra não deixar o usuário mudo.
    if (job.text) {
      await sendText(job.instance, job.phoneE164, job.text);
      return; // degradou pra texto com sucesso
    }
    throw err;
  }
}

/**
 * Enfileira um envio. Se a fila estiver indisponível, envia direto (fallback)
 * pra nunca deixar a Xarlote muda por causa de um Redis fora do ar.
 */
export async function dispatchOutbound(job: OutboundJob): Promise<void> {
  try {
    // FAIL-FAST: se o Redis estiver fora, o BullMQ (maxRetriesPerRequest:null)
    // deixa o queue.add() pendurado pra sempre em vez de errar — e o fallback de
    // envio direto nunca dispararia, deixando a Xarlote MUDA. Corremos contra um
    // timeout curto pra garantir o failover pro envio direto.
    await Promise.race([
      queueFor(job.instance).add('send', job),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('queue.add timeout (Redis indisponível?)')), 2000),
      ),
    ]);
  } catch (err) {
    await writeLog('warn', 'outbound', `Fila indisponível — enviando direto (fallback): ${String(err).slice(0, 160)}`, {
      traceId: job.traceId, instance: job.instance, kind: job.kind,
    });
    try {
      await rawSend(job);
    } catch (e2) {
      await writeLog('error', 'outbound', `Envio direto (fallback) falhou: ${String(e2).slice(0, 200)}`, {
        traceId: job.traceId, instance: job.instance,
      });
    }
  }
}

let started = false;

/** Sobe um Worker por número, cada um com seu rate-limiter. */
export function startOutboundWorkers(): void {
  if (started) return;
  started = true;

  // Conservador por padrão: ~1 msg a cada 1.2s por número (≈50/min). Ajustável.
  const max = Number(process.env['WA_RATE_MAX'] ?? 1);
  const duration = Number(process.env['WA_RATE_DURATION_MS'] ?? 1200);

  for (const name of [QUEUE_NAMES.OUTBOUND_SARA, QUEUE_NAMES.OUTBOUND_AGENT]) {
    const worker = new Worker(
      name,
      async (job: Job<OutboundJob>) => { await rawSend(job.data); },
      { connection, concurrency: 1, limiter: { max, duration } },
    );
    worker.on('failed', (job, err) => {
      void writeLog('error', 'outbound', `Job ${name} falhou (tentativa ${job?.attemptsMade ?? '?'}): ${String(err).slice(0, 200)}`, {
        traceId: (job?.data as OutboundJob | undefined)?.traceId,
      });
    });
    outboundWorkers.push(worker);
  }
}

/** Fecha workers e filas outbound graciosamente (graceful shutdown F1.A5). */
export async function closeOutbound(): Promise<void> {
  await Promise.allSettled(outboundWorkers.map((w) => w.close()));
  await Promise.allSettled([...queues.values()].map((q) => q.close()));
}
