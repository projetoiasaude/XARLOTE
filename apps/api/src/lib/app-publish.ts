/**
 * Publica evento de tempo real no Redis. A metade suja do `app-events.ts` puro.
 *
 * Regra de ouro deste arquivo: **publicar NUNCA pode derrubar quem chamou.** Ele é
 * chamado de dentro do `sendOutbound`, que é o caminho por onde a Xarlote fala com o
 * paciente. Se o Redis cair e este `publish` lançar, a Xarlote emudece no WhatsApp
 * por causa de uma feature de conforto do app — troca péssima. Por isso tudo aqui é
 * best-effort e engole o erro; quem perde o evento recupera no refetch por cursor da
 * reconexão, que é justamente por isso que o contrato do SSE não promete replay.
 */
import { writeLog } from '@iasaude/db';
import { getRedisClient } from '../queue-config.js';
import { appConversationChannel, encodeAppEvent, type AppEvent } from './app-events.js';

export async function publishAppEvent(conversationId: string, ev: AppEvent): Promise<void> {
  try {
    await getRedisClient().publish(appConversationChannel(conversationId), encodeAppEvent(ev));
  } catch (err) {
    // `debug`, não `error`: o SSE é conforto, e a recuperação por cursor é automática.
    // Alertar aqui viraria ruído a cada oscilação de Redis, e ruído esconde incidente.
    const msg = err instanceof Error ? err.message : String(err);
    void writeLog('debug', 'app-events', `publish falhou: ${msg.slice(0, 80)}`, { conversationId });
  }
}

/** Atalho pro caso mais comum: nasceu uma linha em `messages`. */
export function publishMessageEvent(
  conversationId: string,
  m: { id: string; direction: 'in' | 'out'; contentType: string; text: string | null; clientId?: string },
): void {
  void publishAppEvent(conversationId, {
    type: 'message',
    at: Date.now(),
    id: m.id,
    direction: m.direction,
    contentType: m.contentType,
    ...(m.text ? { text: m.text } : {}),
    ...(m.clientId ? { clientId: m.clientId } : {}),
  });
}
