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
import { createHash, randomUUID } from 'node:crypto';
import { Queue, Worker, type Job } from 'bullmq';
import { sendText, sendAudio, sendMenu, sendTemplate, sendImage } from '@iasaude/whatsapp';
import { writeLog, db } from '@iasaude/db';
import { AGENT_INSTANCE, QUEUE_NAMES, isPlaceholderPhone } from '@iasaude/shared';
import { getRedisConnection, getRedisClient } from '../queue-config.js';

export interface OutboundJob {
  kind: 'text' | 'audio' | 'menu' | 'template' | 'image';
  instance: string;       // SARA_INSTANCE | AGENT_INSTANCE
  phoneE164: string;
  text?: string;          // texto (kind=text) ou FALLBACK (kind=audio | kind=template)
  audioBase64?: string;   // buffer de áudio em base64 (kind=audio, via uazapi /base64)
  audioUrl?: string;      // URL pública do áudio (kind=audio, via zpro /voice = PTT)
  /** kind=image — URL PÚBLICA da imagem (o zpro envia foto por URL). `text` vira legenda. */
  imageUrl?: string;
  mime?: string;
  ptv?: boolean;
  buttons?: string[];     // kind=menu
  footerText?: string;
  ticketId?: number | string; // kind=menu no zpro/WABA (botões exigem ticket)
  // kind=template (HSM/WABA — abertura fria oficial). text = fallback humanizado.
  templateName?: string;
  templateLanguage?: string;
  templateVariables?: string[];
  /**
   * Token único do ENFILEIRAMENTO (idempotência de envio — ver sendDedupKey). Preenchido
   * automaticamente pelo `dispatchOutbound`; os callers não passam.
   */
  sendToken?: string;
  traceId?: string;
  /** Linha em `messages` a carimbar com o veredito REAL do canal (ver 0022). */
  messageId?: string;
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

/**
 * 🔒 TRAVA DE ENVIO ÚNICO (incidente Hiago 27/07: o MESMO lembrete de água chegou 2× no
 * WhatsApp, ambos às 10:00 — enquanto o banco tinha 1 lembrete, 1 espelho e 1 evento).
 *
 * Causa: a fila outbound tem DOIS consumidores (o service `api` roda com ROLE=all, que
 * sobe os workers, e o service `worker` também). Isso é normal em BullMQ — cada job vai
 * pra um worker só — EXCETO quando um job "stalled" (o worker não renovou o lock a tempo,
 * ex.: event loop travado ou envio lento) é reentregue ao outro worker. Aí o mesmo job
 * executa duas vezes e o paciente recebe a mensagem em duplicidade.
 *
 * `attempts: 5` piora: um envio que CHEGA mas cuja resposta HTTP falha é retentado.
 *
 * A trava é um claim atômico no Redis (SET NX EX) ANTES do envio real. O primeiro a
 * reivindicar envia; qualquer repetição do mesmo conteúdo, pro mesmo número, na mesma
 * janela, é descartada. Fica no `rawSend` (não no processor) porque este é o ÚNICO ponto
 * por onde todo envio passa — incluindo o fallback direto fora da fila.
 *
 * Fail-open deliberado: se o Redis estiver fora, ENVIA (perder um lembrete de remédio é
 * pior que arriscar uma duplicata rara).
 */
const SEND_DEDUP_TTL_S = 900; // 15min cobre stalled-job + os 5 retries com backoff exponencial

/**
 * Chave de idempotência do envio. Identifica o ENFILEIRAMENTO, não o conteúdo.
 *
 * Isto é essencial: deduplicar por TEXTO suprimiria repetição legítima (o paciente
 * pergunta a mesma coisa duas vezes e a resposta certa é a mesma). O `sendToken` é
 * sorteado UMA vez, no `dispatchOutbound`, e viaja dentro do job — então uma
 * RE-EXECUÇÃO do mesmo job (stalled/retry) carrega o mesmo token e é barrada, enquanto
 * dois envios distintos com texto idêntico têm tokens diferentes e ambos passam.
 *
 * Sem token (envio direto fora da fila) → devolve null e o envio segue sem trava: esse
 * caminho não é re-executado por worker nenhum.
 */
export function sendDedupKey(job: OutboundJob): string | null {
  // PREFERE `messageId` (id da linha-espelho em `messages`): ele é estável e único por
  // MENSAGEM LÓGICA, então cobre também o caso de dois `dispatchOutbound` distintos para
  // o mesmo lembrete — que o sendToken (único por enfileiramento) deixaria passar.
  // Dois envios para a mesma linha-espelho são SEMPRE duplicata.
  const basis = job.messageId ? `msg:${job.messageId}` : job.sendToken ? `tok:${job.sendToken}` : null;
  if (!basis) return null;
  return `outb:sent:${createHash('sha1').update(basis).digest('hex')}`;
}

async function claimSend(job: OutboundJob): Promise<boolean> {
  const key = sendDedupKey(job);
  if (!key) return true;
  try {
    // ioredis: set(k, v, 'EX', s, 'NX') → 'OK' se reivindicou, null se já existia.
    const ok = await getRedisClient().set(key, '1', 'EX', SEND_DEDUP_TTL_S, 'NX');
    if (ok === null) {
      await writeLog('warn', 'outbound', `🚫 Envio DUPLICADO barrado — esta mensagem já saiu (key=${key.slice(-12)})`, {
        traceId: job.traceId, instance: job.instance, kind: job.kind, messageId: job.messageId,
      });
      return false;
    }
    return true;
  } catch (err) {
    // Fail-open (perder lembrete de remédio é pior que arriscar duplicata) — mas NUNCA
    // em silêncio: se o Redis estiver falhando, a trava está desligada e precisamos saber.
    await writeLog('error', 'outbound', `Trava de envio único INDISPONÍVEL (Redis): ${String(err).slice(0, 140)} — enviando sem proteção`, {
      traceId: job.traceId, instance: job.instance,
    });
    return true;
  }
}

/** Executa o envio real na uazapi. Áudio cai pra texto se falhar. */
async function rawSend(job: OutboundJob): Promise<void> {
  // 🛑 TRAVA DE SEGURANÇA (incidente 2026-07-01): NUNCA enviar pra número sintético/
  // placeholder (+555500000<id>) ou inválido. Fornecedor/clínica sem telefone real
  // gerava um número fake e o envio caía em número aleatório (spam/ban). Barra aqui,
  // no ponto de envio, pegando qualquer job (enfileirado ou fallback direto).
  if (isPlaceholderPhone(job.phoneE164)) {
    await writeLog('error', 'outbound', `Envio BLOQUEADO — número placeholder/inválido (${job.phoneE164}). Estabelecimento sem telefone real; nada enviado.`, {
      traceId: job.traceId, instance: job.instance, kind: job.kind, phone: job.phoneE164,
    });
    return;
  }
  // Envio único: barra a re-execução do MESMO job (stalled/retry) — ver claimSend.
  if (!(await claimSend(job))) return;
  if (job.kind === 'text') {
    const res = await sendText(job.instance, job.phoneE164, job.text ?? '');
    // 🔬 INSTRUMENTAÇÃO DA DUPLICATA (caso Hiago 27/07, reincidente às 16h).
    // O banco mostra 1 lembrete / 1 espelho / 1 evento e a trava nunca disparou — ou seja,
    // do nosso lado houve UMA chamada. Este log fecha o cerco na próxima ocorrência:
    //   • 2 linhas com o MESMO wa_key  → o job re-executou e a trava falhou (Redis)
    //   • 2 linhas com wa_key DIFERENTE → dois envios distintos (bug acima da fila)
    //   • 1 linha só                    → nós enviamos 1×; a duplicação é do zpro/Meta
    // O `providerMessageId` é a prova do lado de lá (2 wamids = 2 mensagens de verdade).
    await writeLog('info', 'outbound', `📤 envio text pid=${process.pid} wa_key=${(sendDedupKey(job) ?? 'none').slice(-12)} providerMessageId=${res.messageId || '(vazio)'}`, {
      traceId: job.traceId, instance: job.instance, messageId: job.messageId,
    });
    if (job.messageId && res.messageId) {
      // Guarda o id do provider: sem ele somos cegos pra entrega dupla (external_id
      // do outbound estava sempre null).
      await db.from('messages').update({ external_id: res.messageId }).eq('id', job.messageId).then(() => {}, () => {});
    }
    return;
  }
  if (job.kind === 'image') {
    // Encaminhar documento (carteirinha, pedido médico, receita) a clínica/farmácia.
    // Exige URL pública — por isso a mídia recebida é re-hospedada (ver media-host.ts).
    if (!job.imageUrl) {
      await writeLog('error', 'outbound', 'envio de imagem SEM imageUrl — nada enviado', { traceId: job.traceId, instance: job.instance });
      return;
    }
    const res = await sendImage(job.instance, job.phoneE164, job.imageUrl, job.text || undefined);
    await writeLog('info', 'outbound', `📎 imagem enviada pid=${process.pid} providerMessageId=${res.messageId || '(vazio)'}`, {
      traceId: job.traceId, instance: job.instance, messageId: job.messageId,
    });
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
  if (job.kind === 'template') {
    // Abertura fria oficial (WABA): manda o TEMPLATE aprovado.
    try {
      await sendTemplate(job.instance, job.phoneE164, {
        name: job.templateName ?? '',
        language: job.templateLanguage ?? 'pt_BR',
        variables: job.templateVariables ?? [],
      });
      // Loga o SUCESSO também (não só a falha) — senão o admin via só erros e fica
      // sem saber se a abertura fria REALMENTE saiu (visibilidade assimétrica).
      await writeLog('info', 'outbound', `Abertura por template enviada (template=${job.templateName})`, {
        traceId: job.traceId, instance: job.instance, template: job.templateName,
      });
    } catch (err) {
      // ⚠️ Numa ABERTURA FRIA o fallback de texto NÃO entrega (a Meta rejeita texto
      // livre fora de janela). Então isto é ERRO ACIONÁVEL (anomaly-detector pega),
      // não um warn silencioso: o estabelecimento ficou sem receber a abertura. Ainda
      // tentamos o texto (se por acaso houver janela aberta, entrega; senão, já logamos).
      await writeLog('error', 'outbound', `Abertura por template FALHOU (template=${job.templateName}) — estabelecimento pode não ter recebido: ${String(err).slice(0, 300)}`, {
        traceId: job.traceId, instance: job.instance, template: job.templateName,
      });
      // Se por acaso houver janela de 24h aberta, o texto livre entrega. Se ele
      // também falhar, RELANÇA o erro do template pra o BullMQ retentar (attempts:5
      // + backoff) — antes o `.catch(()=>{})` + return engolia a falha e o job
      // "completava" sem nunca entregar (uma queda transitória do zpro = abertura
      // fria perdida em silêncio).
      if (job.text) {
        try {
          await sendText(job.instance, job.phoneE164, job.text);
          return;
        } catch { /* texto frio também falhou — cai no throw abaixo pra retentar */ }
      }
      throw err;
    }
    return;
  }
  // kind === 'audio'
  try {
    if (job.audioUrl) {
      // zpro/WABA: voice note (PTT) por URL via /voice.
      await sendAudio(job.instance, job.phoneE164, job.audioUrl, { mime: job.mime ?? 'audio/ogg', ptv: job.ptv ?? true });
    } else {
      const buf = Buffer.from(job.audioBase64 ?? '', 'base64');
      await sendAudio(job.instance, job.phoneE164, buf, { mime: job.mime ?? 'audio/mpeg', ptv: job.ptv ?? true });
    }
  } catch (err) {
    // Áudio falhou — LOGA o motivo (antes era engolido) e manda o texto pra não
    // deixar o usuário mudo. O log revela por que o /voice (zpro/WABA) recusou.
    await writeLog('warn', 'outbound', `Áudio falhou (caindo pra texto): ${String(err).slice(0, 450)}`, {
      traceId: job.traceId,
      instance: job.instance,
      via: job.audioUrl ? 'voice-url' : 'base64',
    });
    if (job.text) {
      await sendText(job.instance, job.phoneE164, job.text);
      return; // degradou pra texto com sucesso
    }
    throw err;
  }
}

/**
 * Carimba no espelho (`messages`) o veredito REAL do canal. Só o WORKER sabe se o envio
 * deu certo: `dispatchOutbound` NUNCA lança (engole exceção e cai no fallback), então
 * carimbar "delivered" ali seria afirmar entrega que pode não ter acontecido — a mesma
 * classe do incidente dos 30 lembretes, só que com uma mentira POSITIVA (review).
 */
async function stampDelivery(messageId: string | undefined, status: 'delivered' | 'failed'): Promise<void> {
  if (!messageId) return;
  try {
    await db.from('messages').update({
      delivered_at: status === 'delivered' ? new Date().toISOString() : null,
      delivery_status: status,
    }).eq('id', messageId);
  } catch { /* carimbo é observabilidade — nunca derruba o envio */ }
}

/**
 * Enfileira um envio. Se a fila estiver indisponível, envia direto (fallback)
 * pra nunca deixar a Xarlote muda por causa de um Redis fora do ar.
 */
export async function dispatchOutbound(job: OutboundJob): Promise<void> {
  // Carimba o token de idempotência UMA vez, aqui: ele viaja no job e é o que permite
  // distinguir "o mesmo job rodando de novo" de "um segundo envio legítimo e igual".
  job = { ...job, sendToken: job.sendToken ?? randomUUID() };
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
      await stampDelivery(job.messageId, 'delivered');
    } catch (e2) {
      await stampDelivery(job.messageId, 'failed');
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
      async (job: Job<OutboundJob>) => { await rawSend(job.data); await stampDelivery(job.data.messageId, 'delivered'); },
      { connection, concurrency: 1, limiter: { max, duration } },
    );
    worker.on('failed', (job, err) => {
      // BullMQ emite 'failed' em CADA tentativa. Só a TERMINAL conta como 'error'
      // (e alimenta o alerta de "possível ban"); tentativas intermediárias viram
      // 'warn' — senão UM número morto gera 5 erros e dispara alarme falso.
      const terminal = (job?.attemptsMade ?? 0) >= (job?.opts?.attempts ?? 1);
      if (terminal) void stampDelivery((job?.data as OutboundJob | undefined)?.messageId, 'failed');
      void writeLog(terminal ? 'error' : 'warn', 'outbound', `Job ${name} ${terminal ? 'FALHOU (final)' : 'falhou'} (tentativa ${job?.attemptsMade ?? '?'}/${job?.opts?.attempts ?? '?'}): ${String(err).slice(0, 500)}`, {
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
