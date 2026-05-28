import type { ChatMessage } from '../client.js';
import type { Message } from '@iasaude/shared';

/**
 * Converte mensagens do banco no formato de histórico que o LLM consome.
 *
 * IMPORTANTE: inclui TODOS os tipos que carregam texto útil — não só 'text'.
 *   - text     → usa content
 *   - audio    → usa transcript (transcrição do áudio); fallback content
 *   - image    → usa content (caption), se houver
 *   - location → usa content ("[Localização compartilhada…]")
 *
 * Bug histórico (corrigido): antes filtrava `content_type === 'text'`, o que
 * APAGAVA do histórico a saudação inicial da Xarlote (enviada como ÁUDIO) e
 * qualquer áudio do paciente. Resultado: a Xarlote "esquecia" que já tinha
 * cumprimentado e repetia a saudação no turno seguinte (e ignorava o que o
 * paciente pediu por áudio). Agora áudio entra no histórico via transcript.
 */
export function messagesToHistory(messages: Message[]): ChatMessage[] {
  return messages
    .map((m) => {
      // Prioriza transcrição (áudio) sobre content; cai pra content (texto/caption/location)
      const text =
        (m.transcript && m.transcript.trim()) ||
        (m.content && m.content.trim()) ||
        '';
      return {
        role: m.direction === 'in' ? ('user' as const) : ('assistant' as const),
        content: text,
      };
    })
    .filter((m) => m.content.length > 0);
}

export function trimHistory(history: ChatMessage[], maxTurns = 20): ChatMessage[] {
  if (history.length <= maxTurns * 2) return history;
  return history.slice(-maxTurns * 2);
}
