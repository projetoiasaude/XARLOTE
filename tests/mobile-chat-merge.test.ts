import { describe, it, expect } from 'vitest';
import {
  PENDING_TIMEOUT_MS,
  dropConfirmed,
  expirePending,
  mergeMessages,
  type PendingMessage,
  type ServerMessage,
} from '../apps/mobile/src/features/chat/merge.js';

/**
 * A fusão otimista do chat.
 *
 * Os dois defeitos que este arquivo existe pra impedir são visíveis e vergonhosos:
 * a mensagem aparecer DUAS vezes, ou a bolha ficar em "enviando…" pra sempre. Ambos
 * já aconteceram na versão web do chat, e a causa nos dois casos foi a mesma —
 * casamento frouxo entre a bolha local e a que volta do servidor.
 */

const C1 = '11111111-1111-4111-8111-111111111111';
const C2 = '22222222-2222-4222-8222-222222222222';

const srv = (over: Partial<ServerMessage> & { id: string; createdAt: string }): ServerMessage => ({
  direction: 'in', contentType: 'text', text: 'x', ...over,
});
const pend = (clientId: string, createdAt: string, status: PendingMessage['status'] = 'pending'): PendingMessage =>
  ({ clientId, text: 'oi', createdAt, status });

describe('a bolha otimista sai quando o servidor confirma', () => {
  it('mesma mensagem NÃO aparece duas vezes', () => {
    const r = mergeMessages(
      [srv({ id: 'm1', createdAt: '2026-08-10T12:00:00.000Z', clientId: C1, direction: 'out', text: 'oi' })],
      [pend(C1, '2026-08-10T12:00:00.000Z')],
    );
    expect(r).toHaveLength(1);
    expect(r[0]!.id).toBe('m1');
    expect(r[0]!.status).toBe('sent');
  });

  it('a chave do item é a do SERVIDOR — trocar a chave faria a linha piscar', () => {
    const r = mergeMessages(
      [srv({ id: 'm1', createdAt: '2026-08-10T12:00:00.000Z', clientId: C1, direction: 'out' })],
      [],
    );
    expect(r[0]!.key).toBe('m1');
    expect(r[0]!.key).not.toContain('local-');
  });

  it('pendente que o servidor AINDA não confirmou continua na tela', () => {
    const r = mergeMessages([], [pend(C1, '2026-08-10T12:00:00.000Z')]);
    expect(r).toHaveLength(1);
    expect(r[0]!.status).toBe('pending');
    expect(r[0]!.key).toBe(`local-${C1}`);
  });

  it('a bolha otimista nasce com a MESMA direção que terá confirmada', () => {
    // No banco `in` = paciente falando, `out` = Xarlote respondendo. Se a pendente
    // nascesse como `out`, ela apareceria do lado da Xarlote e SALTARIA de lado
    // quando a confirmação chegasse — defeito visível em toda mensagem enviada.
    const otimista = mergeMessages([], [pend(C1, '2026-08-10T12:00:00.000Z')])[0]!;
    const confirmada = mergeMessages(
      [srv({ id: 'm1', createdAt: '2026-08-10T12:00:00.000Z', clientId: C1, direction: 'in' })],
      [],
    )[0]!;
    expect(otimista.direction).toBe('in');
    expect(otimista.direction).toBe(confirmada.direction);
  });

  it('uma pendente FALHADA que na verdade chegou para de mostrar erro', () => {
    // Caso real: o 202 não voltou (rede caiu na resposta), mas a fila processou.
    // Seguir mostrando "falhou" faria o paciente reenviar algo já entregue.
    const r = mergeMessages(
      [srv({ id: 'm1', createdAt: '2026-08-10T12:00:00.000Z', clientId: C1, direction: 'out' })],
      [pend(C1, '2026-08-10T12:00:00.000Z', 'failed')],
    );
    expect(r).toHaveLength(1);
    expect(r[0]!.status).toBe('sent');
  });
});

describe('dedup do servidor', () => {
  it('a mesma mensagem pela página E pelo SSE conta uma vez', () => {
    // Sem isto, TODA resposta da Xarlote apareceria em dobro.
    const m = srv({ id: 'm1', createdAt: '2026-08-10T12:00:00.000Z', text: 'resposta' });
    expect(mergeMessages([m, m], [])).toHaveLength(1);
  });

  it('a versão MAIS RECENTE do mesmo id vence', () => {
    const r = mergeMessages(
      [
        srv({ id: 'm1', createdAt: '2026-08-10T12:00:00.000Z', text: 'antigo' }),
        srv({ id: 'm1', createdAt: '2026-08-10T12:00:00.000Z', text: 'corrigido' }),
      ],
      [],
    );
    expect(r).toHaveLength(1);
    expect(r[0]!.text).toBe('corrigido');
  });
});

describe('ordem', () => {
  it('cronológica ascendente — é como a tela desenha', () => {
    const r = mergeMessages(
      [
        srv({ id: 'b', createdAt: '2026-08-10T12:00:02.000Z' }),
        srv({ id: 'a', createdAt: '2026-08-10T12:00:01.000Z' }),
        srv({ id: 'c', createdAt: '2026-08-10T12:00:03.000Z' }),
      ],
      [],
    );
    expect(r.map((i) => i.id)).toEqual(['a', 'b', 'c']);
  });

  it('desempata pelo ID no mesmo instante — igual ao keyset do servidor', () => {
    // O servidor pagina por `(created_at desc, id desc)`. Se a tela ordenasse por
    // outro critério, rolar pra cima traria mensagem fora de lugar.
    const r = mergeMessages(
      [
        srv({ id: 'm2', createdAt: '2026-08-10T12:00:00.000Z' }),
        srv({ id: 'm1', createdAt: '2026-08-10T12:00:00.000Z' }),
      ],
      [],
    );
    expect(r.map((i) => i.id)).toEqual(['m1', 'm2']);
  });

  it('a pendente do mesmo instante fica por ÚLTIMO (acabou de ser digitada)', () => {
    const r = mergeMessages(
      [srv({ id: 'm1', createdAt: '2026-08-10T12:00:00.000Z' })],
      [pend(C1, '2026-08-10T12:00:00.000Z')],
    );
    expect(r.map((i) => i.key)).toEqual(['m1', `local-${C1}`]);
  });

  it('duas pendentes mantêm a ordem em que foram digitadas', () => {
    const r = mergeMessages([], [
      pend(C2, '2026-08-10T12:00:05.000Z'),
      pend(C1, '2026-08-10T12:00:01.000Z'),
    ]);
    expect(r.map((i) => i.clientId)).toEqual([C1, C2]);
  });
});

describe('casos de borda que não podem quebrar a tela', () => {
  it('tudo vazio devolve vazio', () => {
    expect(mergeMessages([], [])).toEqual([]);
  });

  it('mensagem sem texto (áudio/imagem) sobrevive', () => {
    const r = mergeMessages(
      [srv({ id: 'm1', createdAt: '2026-08-10T12:00:00.000Z', text: null, contentType: 'audio', mediaMime: 'audio/mpeg' })],
      [],
    );
    expect(r[0]!.text).toBeNull();
    expect(r[0]!.mediaMime).toBe('audio/mpeg');
  });

  it('clientId nulo (mensagem que veio do WhatsApp) não casa com pendente nenhuma', () => {
    const r = mergeMessages(
      [srv({ id: 'm1', createdAt: '2026-08-10T12:00:00.000Z', clientId: null, direction: 'out' })],
      [pend(C1, '2026-08-10T12:00:00.000Z')],
    );
    // As duas coexistem: são mensagens diferentes.
    expect(r).toHaveLength(2);
  });
});

describe('dropConfirmed', () => {
  it('remove só as confirmadas', () => {
    const r = dropConfirmed([pend(C1, '2026-08-10T12:00:00.000Z'), pend(C2, '2026-08-10T12:00:01.000Z')], [C1]);
    expect(r.map((p) => p.clientId)).toEqual([C2]);
  });

  it('sem nada a remover devolve o MESMO array (não re-renderiza à toa)', () => {
    const orig = [pend(C1, '2026-08-10T12:00:00.000Z')];
    expect(dropConfirmed(orig, [])).toBe(orig);
  });
});

describe('expirePending — bolha não gira pra sempre', () => {
  const T0 = '2026-08-10T12:00:00.000Z';
  const base = Date.parse(T0);

  it('antes do prazo continua pendente', () => {
    const r = expirePending([pend(C1, T0)], base + PENDING_TIMEOUT_MS - 1);
    expect(r[0]!.status).toBe('pending');
  });

  it('passado o prazo vira falha — o envio é assíncrono e ninguém avisa se o worker cai', () => {
    const r = expirePending([pend(C1, T0)], base + PENDING_TIMEOUT_MS + 1);
    expect(r[0]!.status).toBe('failed');
  });

  it('o prazo cobre um turno de LLM lento com folga', () => {
    // Turno típico é 5-15s; o limite tem que ser bem acima, senão marca falha em
    // mensagem que estava só demorando.
    expect(PENDING_TIMEOUT_MS).toBeGreaterThanOrEqual(60_000);
  });

  it('nada a expirar devolve o MESMO array (evita re-render a cada tique)', () => {
    const orig = [pend(C1, T0)];
    expect(expirePending(orig, base + 1000)).toBe(orig);
  });

  it('não mexe em quem já falhou', () => {
    const r = expirePending([pend(C1, T0, 'failed')], base + PENDING_TIMEOUT_MS + 1);
    expect(r[0]!.status).toBe('failed');
  });
});
