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

/**
 * Rede de segurança LOCAL da trava de envio único.
 *
 * Incidente 30/07: o Redis piscou 3× e cada piscada derrubou as DUAS proteções de envio ao
 * mesmo tempo — a trava anti-duplicata (aqui) e o rate-limit da fila (ver dispatchOutbound).
 * Ficar sem as duas justo quando a infra está instável é o pior momento possível.
 *
 * Este Set cobre a re-execução dentro do MESMO processo, que é de onde vem a duplicata real
 * (retry do BullMQ, job stalled reentregue, fallback direto logo após timeout). Não substitui
 * o Redis entre instâncias — e não pretende: é a segunda linha, não a primeira.
 * Capado em MAX_LOCAL_KEYS com descarte FIFO pra nunca virar vazamento de memória.
 */
const localSentKeys = new Set<string>();
const MAX_LOCAL_KEYS = 5_000;

export function claimLocal(key: string): boolean {
  if (localSentKeys.has(key)) return false;
  localSentKeys.add(key);
  if (localSentKeys.size > MAX_LOCAL_KEYS) {
    // Set preserva ordem de inserção: o primeiro é o mais antigo.
    const oldest = localSentKeys.values().next().value;
    if (oldest !== undefined) localSentKeys.delete(oldest);
  }
  return true;
}

/**
 * Devolve a reivindicação quando o envio FALHOU de verdade.
 *
 * Sem isto a trava viraria uma armadilha: a chave é criada ANTES do envio e vive 15 min,
 * enquanto o back-off do BullMQ inteiro (2s→4s→8s→16s) cabe dentro desse TTL. Um 500 do
 * zpro na 1ª tentativa deixava a chave de pé, TODAS as retentativas eram barradas e o
 * lembrete de remédio nunca saía — carimbado como entregue (phantom-delivered de 21/07
 * por outra porta). Duplicata só se previne contra envio que DEU CERTO.
 */
export function releaseLocal(key: string): void {
  localSentKeys.delete(key);
}

async function releaseSend(job: OutboundJob): Promise<void> {
  const key = sendDedupKey(job);
  if (!key) return;
  releaseLocal(key);
  try {
    await getRedisClient().del(key);
  } catch { /* Redis fora: a chave expira sozinha em SEND_DEDUP_TTL_S */ }
}

async function claimSend(job: OutboundJob): Promise<boolean> {
  const key = sendDedupKey(job);
  if (!key) return true;
  // A marca local é registrada SEMPRE (não só no fallback) pra que a segunda linha esteja
  // pronta quando o Redis cair no meio de uma sequência. Ela só DECIDE dentro do catch —
  // com o Redis vivo, quem manda é o SET NX, que é a trava correta entre instâncias.
  const freshLocally = claimLocal(key);
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
    // Redis fora: a trava distribuída caiu, mas a LOCAL continua de pé. Fail-open só pra
    // quem nunca saiu daqui (perder lembrete de remédio é pior que arriscar duplicata);
    // repetição do mesmo envio neste processo continua barrada.
    if (!freshLocally) {
      await writeLog('warn', 'outbound', `🚫 Envio DUPLICADO barrado pela trava LOCAL (Redis fora, key=${key.slice(-12)})`, {
        traceId: job.traceId, instance: job.instance, kind: job.kind, messageId: job.messageId,
      });
      return false;
    }
    await writeLog('error', 'outbound', `Trava de envio único (Redis) INDISPONÍVEL: ${String(err).slice(0, 140)} — seguindo só com a trava local deste processo`, {
      traceId: job.traceId, instance: job.instance,
    });
    return true;
  }
}

/** Executa o envio real na uazapi. Áudio cai pra texto se falhar. */
/**
 * Desfecho do envio — três estados, porque colapsá-los mente no espelho `messages`:
 *  - `sent`      → saiu de fato; carimba 'delivered'.
 *  - `duplicate` → barrado pela trava; o envio ORIGINAL já carimbou. Não tocar no carimbo
 *                  (marcar 'failed' aqui viraria um lembrete ENTREGUE contado como falho,
 *                  envenenando o alerta de remédio não entregue, o cap e o back-off).
 *  - `not-sent`  → nada saiu e nada vai sair (número placeholder, imagem sem URL) → 'failed'.
 */
type SendOutcome = 'sent' | 'duplicate' | 'not-sent';

async function rawSend(job: OutboundJob): Promise<SendOutcome> {
  // 🛑 TRAVA DE SEGURANÇA (incidente 2026-07-01): NUNCA enviar pra número sintético/
  // placeholder (+555500000<id>) ou inválido. Fornecedor/clínica sem telefone real
  // gerava um número fake e o envio caía em número aleatório (spam/ban). Barra aqui,
  // no ponto de envio, pegando qualquer job (enfileirado ou fallback direto).
  if (isPlaceholderPhone(job.phoneE164)) {
    await writeLog('error', 'outbound', `Envio BLOQUEADO — número placeholder/inválido (${job.phoneE164}). Estabelecimento sem telefone real; nada enviado.`, {
      traceId: job.traceId, instance: job.instance, kind: job.kind, phone: job.phoneE164,
    });
    return 'not-sent';
  }
  // Envio único: barra a re-execução do MESMO job (stalled/retry) — ver claimSend.
  // `false` NÃO é sucesso: quem chama não pode carimbar 'delivered' em cima disso (a
  // entrega verdadeira, se houve, já foi carimbada pelo envio original).
  if (!(await claimSend(job))) return 'duplicate';
  try {
    await sendClaimed(job);
    return 'sent';
  } catch (err) {
    // Só devolve a reivindicação quando o erro PROVA que nada saiu (ver provesNothingWasSent).
    // Um timeout NÃO prova: é o clássico "entregou e a resposta HTTP não voltou" — soltar a
    // trava ali faria o BullMQ (attempts:5) reenviar e o paciente receber 2×, reabrindo
    // justamente o incidente de 27/07 que a trava existe pra impedir.
    if (provesNothingWasSent(err)) await releaseSend(job);
    throw err;
  }
}

/**
 * O erro prova que a mensagem NÃO saiu?
 *
 * `zproCall` formata "zpro <path> HTTP <status>: <corpo>" quando o provedor RESPONDEU, e
 * repropaga o erro cru quando não houve resposta (timeout/DNS/conexão). Só o 4xx é prova:
 * o provedor recebeu, entendeu e RECUSOU — nada foi entregue, e a retentativa precisa da
 * trava livre. 5xx e ausência de resposta ficam ambíguos e mantêm a trava (não duplicar
 * vale mais que retentar, e o job vai pra 'failed' com carimbo — falha visível, não silenciosa).
 */
function provesNothingWasSent(err: unknown): boolean {
  const m = String((err as Error)?.message ?? err);
  // zpro: "zpro /url HTTP 400: …" · uazapi (axios cru): "Request failed with status code 400"
  if (/\bHTTP 4\d\d\b/.test(m) || /status code 4\d\d/i.test(m)) return true;
  // zpro responde 200 com {success:false} quando RECUSA (ex.: ERR_CHANNEL_NOT_SUPPORTED no
  // /voice). É recusa explícita do provedor: nada saiu, e a retentativa precisa da trava livre.
  if (/success=false/.test(m)) return true;
  return false;
}

/** O envio propriamente dito, já com a reivindicação em mãos. */
async function sendClaimed(job: OutboundJob): Promise<void> {
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
      // `false` = NADA saiu. Devolver `true` aqui carimbaria 'delivered' numa carteirinha
      // que a clínica nunca recebeu — phantom-delivered de 21/07 reencarnado na mídia.
      await writeLog('error', 'outbound', 'envio de imagem SEM imageUrl — nada enviado', { traceId: job.traceId, instance: job.instance });
      throw new Error('imagem sem imageUrl — HTTP 400 (nada enviado)');
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
  return;
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

/** Espaçamento mínimo entre envios diretos, POR INSTÂNCIA (espelha o limiter da fila). */
const lastDirectSendAt = new Map<string, number>();
/** Teto de espera POR CHAMADA — o turno do paciente não pode ficar preso atrás de uma rajada. */
function maxPaceWaitMs(): number {
  const v = Number(process.env['WA_FALLBACK_MAX_WAIT_MS']);
  return Number.isFinite(v) && v > 0 ? v : 3_000;
}

export function directSendIntervalMs(): number {
  const max = Math.max(1, Number(process.env['WA_RATE_MAX'] ?? 1));
  const duration = Math.max(0, Number(process.env['WA_RATE_DURATION_MS'] ?? 1200));
  const ms = Math.round(duration / max);
  return Number.isFinite(ms) && ms > 0 ? ms : 1200;
}

/**
 * Segura o envio direto pelo tempo que falta pro espaçamento mínimo. Serializa por
 * instância: cada chamada reserva seu slot ANTES de esperar, então N chamadas paralelas
 * saem espaçadas em vez de todas juntas ao fim de um único sleep.
 */
export async function pacePerInstance(instance: string): Promise<void> {
  const interval = directSendIntervalMs();
  const now = Date.now();
  const slot = Math.max(now, (lastDirectSendAt.get(instance) ?? 0) + interval);
  lastDirectSendAt.set(instance, slot);
  // ⏱️ TETO POR CHAMADA. Sem ele, uma queda de Redis durante um tick de 200 lembretes
  // empurraria o slot pra +4min e QUALQUER envio seguinte — inclusive uma resposta de
  // emergência — ficaria atrás da fila inteira; pior, o turno do paciente aguarda este
  // await e estouraria o orçamento de 75s. Sob rajada extrema o espaçamento degrada
  // (mensagens se agrupam) em vez de travar: é a troca certa, e fica no log.
  const teto = maxPaceWaitMs();
  const waitMs = Math.min(slot - now, teto);
  if (slot - now > teto) {
    // Observabilidade NUNCA derruba o envio (regra do projeto): sem await, sem propagação.
    void writeLog('warn', 'outbound', `Fallback congestionado (${Math.round((slot - now) / 1000)}s de fila) — espaçamento limitado a ${teto}ms`, { instance })
      .catch(() => { /* best-effort */ });
  }
  if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));
}

/** `queue.add` com timeout curto e UMA nova tentativa — piscada de Redis não vira fallback. */
async function withQueueRetry<T>(fn: () => Promise<T>): Promise<T> {
  const attempt = () => Promise.race([
    fn(),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('queue.add timeout (Redis indisponível?)')), 2000),
    ),
  ]);
  try {
    return await attempt();
  } catch {
    await new Promise((r) => setTimeout(r, 400));
    return await attempt();
  }
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
    //
    // 30/07: o Redis piscou 3× e cada piscada mandou o envio direto pro fallback,
    // que não tem rate-limit. Mas as 3 piscadas foram TRANSITÓRIAS (segundos) — uma
    // 2ª tentativa cobre a maioria delas e mantém o envio dentro da fila, que é onde
    // mora a proteção anti-ban. Só o que falha DUAS vezes vira envio direto.
    await withQueueRetry(() => queueFor(job.instance).add('send', job));
  } catch (err) {
    await writeLog('warn', 'outbound', `Fila indisponível — enviando direto (fallback): ${String(err).slice(0, 160)}`, {
      traceId: job.traceId, instance: job.instance, kind: job.kind,
    });
    // Sem a fila não há limiter: o espaçamento mínimo passa a ser responsabilidade daqui,
    // senão uma rajada (ex.: tick de lembretes) sai toda de uma vez pro WhatsApp — que é
    // exatamente o padrão que gera ban de número.
    await pacePerInstance(job.instance);
    try {
      // O carimbo segue o desfecho REAL: 'duplicate' não mexe (o envio original já
      // carimbou), 'not-sent' é falha, só 'sent' é entrega.
      const outcome = await rawSend(job);
      if (outcome === 'sent') await stampDelivery(job.messageId, 'delivered');
      else if (outcome === 'not-sent') await stampDelivery(job.messageId, 'failed');
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
      async (job: Job<OutboundJob>) => {
        const outcome = await rawSend(job.data);
        if (outcome === 'sent') await stampDelivery(job.data.messageId, 'delivered');
        else if (outcome === 'not-sent') await stampDelivery(job.data.messageId, 'failed');
      },
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
