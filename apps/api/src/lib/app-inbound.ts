/**
 * A mensagem do app virando um `NormalizedInbound` — PURO, e a razão de ser pura é
 * que o `external_id` que sai daqui é a chave de idempotência de todo o fluxo.
 *
 * O caminho é: app gera um `clientId` (uuid do aparelho) → `POST /app/messages`
 * responde 202 na hora → a fila carrega o job com `jobId = clientId` → o worker monta
 * este inbound com `external_id = app-<clientId>` → `processInboundUser` (INTOCADO).
 *
 * Três coisas dependem desse mesmo `clientId`:
 *   1. **Dedup na fila** — o BullMQ recusa job repetido com o mesmo `jobId`, então
 *      toque duplo no botão de enviar não gera dois turnos da LLM (nem duas cobranças).
 *   2. **Dedup no banco** — o índice único parcial `messages(external_id) where
 *      external_id like 'app-%'` (migration 0025) impede a segunda inserção mesmo se
 *      a fila for reprocessada depois de um restart.
 *   3. **Eco do envio otimista** — o app já desenhou a bolha antes da resposta chegar;
 *      quando o evento de tempo real volta com este id, ele troca "enviando…" pela
 *      definitiva em vez de mostrar a mensagem duas vezes.
 *
 * Por isso o prefixo `app-` é literal e casado com o índice do banco. Mudar um sem o
 * outro tira a idempotência sem que nada quebre visivelmente — só volta a duplicar.
 */
import type { NormalizedInbound } from '@iasaude/shared';
import { SARA_INSTANCE } from '@iasaude/shared';

export const APP_EXTERNAL_PREFIX = 'app-';

/** `app-<clientId>`. O mesmo valor que o índice único parcial da 0025 vigia. */
export function appExternalId(clientId: string): string {
  return `${APP_EXTERNAL_PREFIX}${clientId}`;
}

/**
 * `clientId` aceitável: uuid v4 do aparelho. Restrito de propósito — ele entra num
 * `external_id` indexado e num `jobId` do Redis, então texto livre aqui seria uma
 * chave de dedup que o cliente controla (dá pra colidir com a de outro paciente de
 * propósito) e um vetor de poluição de chave no Redis.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidClientId(raw: string): boolean {
  return UUID_RE.test(raw);
}

/**
 * O caminho de volta: `app-<clientId>` → `clientId`. Devolve null pra qualquer
 * `external_id` que não seja do app (WhatsApp real, simulador, ou nulo).
 *
 * Serve pra publicar o eco do envio otimista sem que o `processInboundUser` — que é
 * agnóstico de canal — precise saber que o app existe.
 */
export function extractAppClientId(externalId: string | null | undefined): string | null {
  if (!externalId?.startsWith(APP_EXTERNAL_PREFIX)) return null;
  const id = externalId.slice(APP_EXTERNAL_PREFIX.length);
  return isValidClientId(id) ? id : null;
}

export interface AppInboundInput {
  phoneE164: string;
  clientId: string;
  /** Texto do paciente. Numa mídia, é a legenda (pode ser vazio). */
  text: string;
  /** Quando o APARELHO diz que a mensagem foi criada — não quando o servidor pegou. */
  sentAtMs: number;
  /**
   * Mídia já guardada por `POST /app/media`, quando houver.
   *
   * A URL é ASSINADA e curta: o worker a consome em segundos (visão ou transcrição) e
   * ela morre. Guardar URL pública no job seria deixar um link de exame vivo dentro da
   * fila, que é justamente onde ninguém olha.
   */
  media?: { url: string; mime: string; contentType: 'image' | 'audio' };
}

/**
 * O jid é derivado do telefone canônico do usuário JÁ EXISTENTE (quem canonicaliza é
 * a rota, contra as variantes do 9º dígito BR). Se derivássemos do que o app mandou,
 * uma variante criaria uma conversa PARALELA e o histórico do paciente se partiria em
 * duas — foi exatamente o bug do 9º dígito de 01/07, em outra roupa.
 */
export function buildAppInbound(input: AppInboundInput): NormalizedInbound {
  const digits = input.phoneE164.replace(/\D/g, '');
  return {
    instance: SARA_INSTANCE,
    externalId: appExternalId(input.clientId),
    from: { jid: `${digits}@s.whatsapp.net`, phoneE164: input.phoneE164 },
    fromMe: false,
    // Carimbo do APARELHO: numa fila com atraso, usar `now()` do worker embaralharia
    // a ordem das bolhas que o paciente já viu na tela dele.
    timestamp: new Date(input.sentAtMs),
    // O contentType decide o PIPELINE: 'image' vai pra visão, 'audio' pra transcrição.
    // Os dois caminhos já existem e são os MESMOS do WhatsApp — nada aqui é paralelo.
    contentType: input.media?.contentType ?? 'text',
    text: input.text,
    ...(input.media ? { mediaUrl: input.media.url, mediaMime: input.media.mime } : {}),
    raw: { channel: 'xarlote_app', clientId: input.clientId },
  };
}
