/**
 * Idempotência de envio (incidente Hiago 27/07).
 *
 * O MESMO lembrete de água chegou 2× no WhatsApp, ambos às 10:00, enquanto o banco tinha
 * 1 lembrete, 1 espelho e 1 evento `reminder.dispatched`. Causa: a fila outbound tem DOIS
 * consumidores (o service `api` roda ROLE=all, que sobe os workers, e o service `worker`
 * também) — um job "stalled" é reentregue ao outro worker e executa duas vezes.
 *
 * A trava identifica o ENFILEIRAMENTO (sendToken), não o conteúdo. Estes testes existem
 * pra garantir que ela barra a re-execução SEM barrar repetição legítima — suprimir uma
 * resposta válida seria pior que a duplicata que estamos consertando.
 */
import { describe, expect, it } from 'vitest';
import { sendDedupKey } from '../apps/api/src/queues/outbound.queue.js';

const base = { kind: 'text' as const, instance: 'sara', phoneE164: '+5562999999999', text: 'Hora de beber água 💧' };

describe('sendDedupKey — barra re-execução, não repetição legítima', () => {
  it('MESMO job re-executado (stalled/retry) → MESMA chave (é barrado)', () => {
    const job = { ...base, sendToken: 'tok-abc' };
    expect(sendDedupKey(job)).toBe(sendDedupKey({ ...job }));
  });

  it('DOIS envios distintos com TEXTO IDÊNTICO → chaves diferentes (ambos passam)', () => {
    // O caso que uma dedup por conteúdo quebraria: o paciente pergunta a mesma coisa 2×
    // e a resposta certa é a mesma nas duas.
    const a = sendDedupKey({ ...base, sendToken: 'tok-1' });
    const b = sendDedupKey({ ...base, sendToken: 'tok-2' });
    expect(a).not.toBe(b);
  });

  it('os 4 lembretes de água do Hiago (mesmo texto, horários diferentes) NÃO colidem', () => {
    const keys = ['10h', '13h', '16h', '19h'].map((t) => sendDedupKey({ ...base, sendToken: `agua-${t}` }));
    expect(new Set(keys).size).toBe(4);
  });

  it('sem sendToken → null (envio direto fora da fila segue sem trava)', () => {
    expect(sendDedupKey(base)).toBeNull();
  });

  it('a chave é namespaced e estável (não vaza o token cru)', () => {
    const k = sendDedupKey({ ...base, sendToken: 'tok-abc' })!;
    expect(k.startsWith('outb:sent:')).toBe(true);
    expect(k).not.toContain('tok-abc');
  });
});
