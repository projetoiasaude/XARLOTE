/**
 * A fusão entre o que o servidor sabe e o que o aparelho acabou de escrever.
 *
 * É a função mais perigosa do chat, e é pura de propósito. O paciente digita, a bolha
 * aparece NA HORA (antes de qualquer resposta do servidor), e segundos depois a mesma
 * mensagem volta por três caminhos possíveis: o eco do SSE, o refetch da lista, ou a
 * reabertura da tela. Se a fusão errar, o resultado é sempre um destes dois — e os
 * dois são visíveis e vergonhosos:
 *
 *   • a mensagem aparece DUAS vezes (a otimista nunca foi retirada), ou
 *   • a bolha fica em "enviando…" pra sempre (a otimista não foi casada com a real).
 *
 * A chave que casa as duas pontas é o `clientId` — o mesmo uuid que vira
 * `external_id = app-<clientId>` no banco e `jobId` na fila. Uma chave só para as
 * três coisas é o que torna isto simples.
 */

export type MessageStatus = 'pending' | 'sent' | 'failed';

/** Como o `GET /app/messages` e o SSE entregam. */
export interface ServerMessage {
  id: string;
  direction: 'in' | 'out';
  senderRole?: string | null;
  contentType: string;
  text: string | null;
  mediaMime?: string | null;
  /**
   * Id da linha em `app_media` — o que abre a URL assinada (`GET /app/media/:id/url`).
   *
   * **Opcional porque o servidor AINDA não manda.** O `select` do `GET /app/messages`
   * traz `media_mime` e para aí; `messages` guarda `media_storage_path`, que a rota de
   * URL não aceita. O campo existe aqui porque é o contrato que falta, e porque o app
   * PREENCHE ele sozinho pelo caminho local (ver `midiaPorClientId` abaixo) — então a
   * exibição de mídia não é código morto esperando servidor: ela roda hoje, para o que
   * o próprio aparelho acabou de mandar.
   */
  mediaId?: string | null;
  createdAt: string;
  /** Presente só quando a mensagem nasceu NESTE app. */
  clientId?: string | null;
}

/** O que o aparelho guarda enquanto o servidor não confirma. */
export interface PendingMessage {
  clientId: string;
  text: string;
  createdAt: string;
  status: Extract<MessageStatus, 'pending' | 'failed'>;
  /**
   * `POST /app/media` já respondeu e o arquivo está no bucket; falta a mensagem. Com
   * isto a bolha otimista de uma foto mostra **a foto**, não a palavra "imagem".
   */
  mediaId?: string;
}

/** O que a tela desenha. */
export interface ChatItem {
  /** Id estável pra lista: o do servidor quando existe, senão `local-<clientId>`. */
  key: string;
  id: string | null;
  clientId: string | null;
  direction: 'in' | 'out';
  contentType: string;
  text: string | null;
  mediaMime: string | null;
  mediaId: string | null;
  createdAt: string;
  status: MessageStatus;
}

/** `clientId` → `mediaId` das mídias que ESTE aparelho subiu nesta sessão. */
export type MidiaPorClientId = ReadonlyMap<string, string>;

const SEM_MIDIA: MidiaPorClientId = new Map();

function fromServer(m: ServerMessage, midias: MidiaPorClientId): ChatItem {
  return {
    // A chave é o id do SERVIDOR mesmo quando há clientId. Usar `local-<clientId>`
    // aqui faria a lista trocar a chave do item quando a confirmação chega, e a
    // FlashList remontaria a linha — pisca visível no meio da conversa.
    key: m.id,
    id: m.id,
    clientId: m.clientId ?? null,
    direction: m.direction,
    contentType: m.contentType,
    text: m.text,
    mediaMime: m.mediaMime ?? null,
    // O do servidor manda quando existir; senão, o que o app sabe do próprio envio.
    // É isto que faz a foto CONTINUAR visível depois de a bolha otimista ser trocada
    // pela linha canônica — sem isso a imagem apareceria e desapareceria em segundos.
    mediaId: m.mediaId ?? (m.clientId ? midias.get(m.clientId) ?? null : null),
    createdAt: m.createdAt,
    status: 'sent',
  };
}

function fromPending(p: PendingMessage): ChatItem {
  return {
    key: `local-${p.clientId}`,
    id: null,
    clientId: p.clientId,
    // `'in'` e NÃO `'out'`: no banco, `in` é o que ENTRA (o paciente falando) e `out`
    // é a Xarlote respondendo. A bolha otimista é do paciente, então tem que nascer
    // com a mesma direção que ela vai ter quando voltar do servidor — senão ela
    // aparece do lado da Xarlote e SALTA de lado ao confirmar.
    direction: 'in',
    // `media` e não `image`/`audio`: o aparelho ainda não sabe qual dos dois é. O tipo
    // vem do mime que a URL assinada devolve — o veredicto sai dos BYTES no servidor,
    // e repetir o palpite aqui seria uma segunda fonte de verdade pra mesma coisa.
    contentType: p.mediaId ? 'media' : 'text',
    text: p.text,
    mediaMime: null,
    mediaId: p.mediaId ?? null,
    createdAt: p.createdAt,
    status: p.status,
  };
}

/**
 * Ordena por tempo e desempata pelo id — o MESMO critério do keyset no servidor
 * (`created_at desc, id desc`), pra que a ordem na tela não discorde da ordem da
 * paginação. Se discordasse, rolar pra cima traria mensagem "fora de lugar".
 *
 * A pendente sem id fica DEPOIS da confirmada de mesmo instante: ela é a mais nova
 * por construção (acabou de ser digitada).
 */
function comparar(a: ChatItem, b: ChatItem): number {
  const ta = Date.parse(a.createdAt);
  const tb = Date.parse(b.createdAt);
  if (ta !== tb) return ta - tb;
  if (a.id && b.id) return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  if (!a.id && b.id) return 1;
  if (a.id && !b.id) return -1;
  return 0;
}

/**
 * @param server páginas do servidor já achatadas, em qualquer ordem
 * @param pending envios locais ainda não confirmados
 * @param midias `clientId` → `mediaId` do que este aparelho subiu (ver ServerMessage.mediaId)
 */
export function mergeMessages(
  server: readonly ServerMessage[],
  pending: readonly PendingMessage[],
  midias: MidiaPorClientId = SEM_MIDIA,
): ChatItem[] {
  // Dedup do servidor por id: a mesma mensagem pode chegar pela página E pelo evento
  // do SSE. Sem isto, cada mensagem da Xarlote apareceria em dobro.
  const porId = new Map<string, ServerMessage>();
  for (const m of server) porId.set(m.id, m);

  // Quais clientIds o servidor JÁ confirmou. É isto que retira a bolha otimista.
  const confirmados = new Set<string>();
  for (const m of porId.values()) if (m.clientId) confirmados.add(m.clientId);

  const itens = [...porId.values()].map((m) => fromServer(m, midias));

  for (const p of pending) {
    // Já confirmada pelo servidor → a otimista morre aqui. Manter as duas é o bug
    // da mensagem duplicada; e o `failed` também sai, porque uma tentativa que
    // aparentemente falhou mas CHEGOU não deve seguir mostrando erro ao paciente.
    if (confirmados.has(p.clientId)) continue;
    itens.push(fromPending(p));
  }

  return itens.sort(comparar);
}

/**
 * A pendente ainda faz sentido, ou o servidor já a confirmou?
 *
 * Usado quando o evento do SSE chega: se o `clientId` dele casa com uma pendente,
 * ela sai da lista local. Separado do merge porque o chamador precisa MUTAR o estado
 * local, e o merge é puro.
 */
export function dropConfirmed(
  pending: readonly PendingMessage[],
  clientIds: readonly string[],
): PendingMessage[] {
  if (clientIds.length === 0) return pending as PendingMessage[];
  const fora = new Set(clientIds);
  return pending.filter((p) => !fora.has(p.clientId));
}

/**
 * Quanto tempo uma pendente pode ficar "enviando…" antes de virar falha.
 *
 * O envio é assíncrono: o 202 só diz que entrou na fila. Se o worker cair, ninguém
 * avisa o app — então sem este limite a bolha giraria pra sempre e o paciente não
 * saberia se a Xarlote leu ou não. 90s cobre com folga um turno de LLM lento
 * (5-15s típico) mais uma retentativa da fila.
 */
export const PENDING_TIMEOUT_MS = 90_000;

export function expirePending(
  pending: readonly PendingMessage[],
  nowMs: number,
): PendingMessage[] {
  let mudou = false;
  const próximo = pending.map((p) => {
    if (p.status !== 'pending') return p;
    if (nowMs - Date.parse(p.createdAt) < PENDING_TIMEOUT_MS) return p;
    mudou = true;
    return { ...p, status: 'failed' as const };
  });
  // Devolve o MESMO array quando nada muda — evita re-render a cada tique do timer.
  return mudou ? próximo : (pending as PendingMessage[]);
}
