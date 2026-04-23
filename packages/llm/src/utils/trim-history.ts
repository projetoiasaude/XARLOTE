import type { ChatMessage } from '../client.js';
import type { Message } from '@iasaude/shared';

export function messagesToHistory(messages: Message[]): ChatMessage[] {
  return messages
    .filter((m) => m.content_type === 'text' && m.content)
    .map((m) => ({
      role: m.direction === 'in' ? ('user' as const) : ('assistant' as const),
      content: m.content ?? '',
    }));
}

export function trimHistory(history: ChatMessage[], maxTurns = 20): ChatMessage[] {
  if (history.length <= maxTurns * 2) return history;
  return history.slice(-maxTurns * 2);
}
