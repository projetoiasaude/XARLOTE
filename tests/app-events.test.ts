import { describe, it, expect } from 'vitest';
import {
  SSE_HEARTBEAT,
  SSE_HEARTBEAT_MS,
  appConversationChannel,
  decodeAppEvent,
  encodeAppEvent,
  sseFrame,
  type AppEvent,
} from '../apps/api/src/lib/app-events.js';

/**
 * O envelope do tempo real.
 *
 * O defeito que este arquivo existe pra impedir: um `\n` solto dentro de `data:`
 * PARTE o quadro SSE em dois, e o cliente recebe metade de um evento. Como
 * `JSON.stringify` escapa a quebra, o quadro sobrevive — mas isso é uma propriedade
 * que precisa de teste, não de fé, porque um dia alguém vai querer mandar texto cru.
 */

const CONV = '9c1d7f4a-3b21-4e88-9a0f-77c5e2d1b430';

describe('canal', () => {
  it('é por CONVERSA — a autorização acontece uma vez, na abertura do SSE', () => {
    expect(appConversationChannel(CONV)).toBe(`app:conv:${CONV}`);
  });

  it('conversas diferentes nunca compartilham canal', () => {
    expect(appConversationChannel('a')).not.toBe(appConversationChannel('b'));
  });
});

describe('quadro SSE', () => {
  it('termina em linha em branco dupla — senão o cliente não fecha o evento', () => {
    const frame = sseFrame({ type: 'message', at: 1, id: 'x', text: 'oi' });
    expect(frame.endsWith('\n\n')).toBe(true);
  });

  it('texto com QUEBRA DE LINHA não parte o quadro', () => {
    // O caso real: a Xarlote responde em 2-3 linhas (ritmo WhatsApp).
    const ev: AppEvent = { type: 'message', at: 1, id: 'x', text: 'Oi!\nTudo bem?\n\nMe conta.' };
    const frame = sseFrame(ev);
    const corpo = frame.split('\n\n')[0]!;
    // Um `data:` só. Se a quebra vazasse, haveria linhas sem prefixo de campo.
    const linhasData = corpo.split('\n').filter((l) => l.startsWith('data: '));
    expect(linhasData).toHaveLength(1);
    // E o texto volta inteiro do outro lado.
    expect(decodeAppEvent(linhasData[0]!.slice(6))!.text).toBe('Oi!\nTudo bem?\n\nMe conta.');
  });

  it('inclui id quando há — é o Last-Event-ID da reconexão', () => {
    expect(sseFrame({ type: 'message', at: 1, id: 'abc' })).toContain('id: abc');
  });

  it('omite a linha de id quando não há (typing não tem)', () => {
    expect(sseFrame({ type: 'typing', at: 1 })).not.toContain('id:');
  });

  it('o event: casa com o type — é por ele que o cliente despacha', () => {
    expect(sseFrame({ type: 'typing', at: 1 })).toContain('event: typing');
    expect(sseFrame({ type: 'reminder', at: 1 })).toContain('event: reminder');
  });
});

describe('decode é defensivo — o canal do Redis não é território confiável', () => {
  it('lixo devolve null em vez de lançar', () => {
    expect(decodeAppEvent('não é json')).toBeNull();
    expect(decodeAppEvent('')).toBeNull();
    expect(decodeAppEvent('null')).toBeNull();
    expect(decodeAppEvent('[]')).toBeNull();
    expect(decodeAppEvent('123')).toBeNull();
  });

  it('objeto sem os campos obrigatórios devolve null', () => {
    expect(decodeAppEvent('{"type":"message"}')).toBeNull();
    expect(decodeAppEvent('{"at":123}')).toBeNull();
    expect(decodeAppEvent('{"type":1,"at":123}')).toBeNull();
  });

  it('ida e volta preserva o essencial', () => {
    const ev: AppEvent = {
      type: 'message', at: 1_800_000_000_000, id: 'm1',
      direction: 'out', contentType: 'text', text: 'oi', clientId: 'c1',
    };
    expect(decodeAppEvent(encodeAppEvent(ev))).toEqual(ev);
  });
});

describe('heartbeat', () => {
  it('é COMENTÁRIO SSE — não pode chegar ao cliente como evento', () => {
    expect(SSE_HEARTBEAT.startsWith(':')).toBe(true);
    expect(SSE_HEARTBEAT).not.toContain('event:');
    expect(SSE_HEARTBEAT).not.toContain('data:');
  });

  it('cabe dentro do timeout de proxy de 30s', () => {
    // Railway e operadora móvel matam conexão ociosa em ~30-60s. Acima de 30s aqui,
    // o app "perde o tempo real" sem nenhum erro visível — parece bug de app.
    expect(SSE_HEARTBEAT_MS).toBeLessThan(30_000);
  });
});
