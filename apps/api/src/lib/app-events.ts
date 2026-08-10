/**
 * O envelope dos eventos de tempo real do app, e o nome do canal — PUROS.
 *
 * O app não faz polling: ele abre um SSE e escuta. Quem alimenta o SSE é o Redis
 * pub/sub, e é isso que permite escalar horizontalmente sem reescrever nada — o
 * estado da conversa não vive no processo que atende a conexão, então QUALQUER nó
 * de API pode servir QUALQUER paciente.
 *
 * Duas regras que este arquivo existe pra garantir:
 *
 * 1. **PII nunca entra no envelope.** O evento diz "chegou mensagem nova na conversa
 *    X" e, no máximo, carrega o texto que o paciente já vai ver na tela dele. Nunca
 *    telefone, CPF, endereço ou lat/lng — o canal do Redis não é redigido como os
 *    logs são, e um `MONITOR` no Redis veria tudo.
 *
 * 2. **O canal é por CONVERSA, não por usuário.** Assim a autorização acontece uma
 *    vez, na abertura do SSE (o dono da conversa é conferido contra o JWT), e não a
 *    cada evento publicado.
 */

/** Tipos de evento. Fechado de propósito: cliente antigo tem que saber ignorar. */
export type AppEventType = 'message' | 'typing' | 'reminder' | 'activity';

export interface AppEvent {
  type: AppEventType;
  /** Momento da publicação em ms — o cliente descarta evento mais velho que o que já tem. */
  at: number;
  /**
   * Para `message`: o id da linha em `messages`. É o que deixa o cliente idempotente —
   * o mesmo evento entregue duas vezes (reconexão, dois nós) não duplica a bolha.
   */
  id?: string;
  direction?: 'in' | 'out';
  contentType?: string;
  text?: string;
  /**
   * Eco do envio otimista: o `clientId` que o app gerou. Ao receber, o app troca a
   * bolha "enviando…" pela definitiva em vez de mostrar a mensagem duas vezes.
   */
  clientId?: string;
}

const PREFIXO = 'app:conv:';

export function appConversationChannel(conversationId: string): string {
  return `${PREFIXO}${conversationId}`;
}

/**
 * Serializa. Nunca lança: publicar é best-effort — se falhar, o cliente ainda
 * recupera pelo refetch por cursor na reconexão. Tempo real que derruba o turno da
 * Xarlote seria um péssimo negócio.
 */
export function encodeAppEvent(ev: AppEvent): string {
  return JSON.stringify(ev);
}

/** Desserializa defensivamente: lixo no canal → null, e o chamador ignora. */
export function decodeAppEvent(raw: string): AppEvent | null {
  try {
    const p = JSON.parse(raw) as unknown;
    if (typeof p !== 'object' || p === null) return null;
    const ev = p as AppEvent;
    if (typeof ev.type !== 'string' || typeof ev.at !== 'number') return null;
    return ev;
  } catch {
    return null;
  }
}

/**
 * Monta o quadro SSE. O `id:` é o que o navegador/cliente usa em `Last-Event-ID`,
 * e o `retry:` diz de quanto em quanto tempo tentar de novo se a conexão cair.
 *
 * Detalhe que quebra em produção se esquecido: cada linha de `data:` não pode ter
 * `\n` dentro. JSON.stringify já escapa, mas se algum dia alguém mandar texto cru
 * aqui, o quadro parte em dois e o cliente recebe metade de um evento.
 */
export function sseFrame(ev: AppEvent): string {
  const linhas = [`event: ${ev.type}`, `data: ${encodeAppEvent(ev)}`];
  if (ev.id) linhas.unshift(`id: ${ev.id}`);
  return `${linhas.join('\n')}\n\n`;
}

/** Comentário SSE — mantém a conexão viva sem virar evento pro cliente. */
export const SSE_HEARTBEAT = ': keep-alive\n\n';
/** 25s: abaixo do timeout de proxy de 30s do Railway e de operadoras móveis. */
export const SSE_HEARTBEAT_MS = 25_000;
/** Quanto o cliente espera antes de reconectar (vai no quadro `retry:`). */
export const SSE_RETRY_MS = 3_000;
