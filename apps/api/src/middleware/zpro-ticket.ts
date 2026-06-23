// Cache do ticketId do zpro por número (janela WABA de 24h).
//
// Os botões interativos do zpro (/sendButtonWABA) usam o ticketId do ticket
// aberto pro contato. Quando o botão é RESPOSTA a uma mensagem, o ticketId vem
// no próprio webhook (NormalizedInbound.providerTicketId). Mas pra botões
// PROATIVOS (red-flag/emergência, lembretes) não há um inbound fresco — então
// guardamos o último ticketId visto de cada número aqui, com TTL de 24h (a
// própria janela de atendimento do WhatsApp). Fail-open: erro de Redis nunca
// bloqueia o envio (o sendMenu já cai pra texto se o botão falhar).
import { getRedisClient } from '../queue-config.js';

const TTL_S = 24 * 60 * 60;
const keyFor = (phoneE164: string) => `zpro:ticket:${phoneE164}`;

export async function setZproTicket(
  phoneE164: string,
  ticketId: number | string | undefined | null,
): Promise<void> {
  if (ticketId === undefined || ticketId === null || ticketId === '') return;
  try {
    await getRedisClient().set(keyFor(phoneE164), String(ticketId), 'EX', TTL_S);
  } catch {
    /* fail-open — não bloqueia o turno por causa de Redis */
  }
}

export async function getZproTicket(phoneE164: string): Promise<number | string | undefined> {
  try {
    const v = await getRedisClient().get(keyFor(phoneE164));
    if (!v) return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : v;
  } catch {
    return undefined;
  }
}
