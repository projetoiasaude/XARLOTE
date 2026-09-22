/**
 * O trabalho que o `app.close()` não esperava (auditoria 22/09, P0-6).
 *
 * O turno do paciente roda em `setImmediate` DEPOIS de o webhook responder 200. O
 * shutdown drenava só requests HTTP — e o request já tinha acabado. Todo `railway up`
 * matava turno no meio, sem reentrega (o zpro recebeu 200) e sem resposta ao paciente.
 */
import { describe, it, expect } from 'vitest';
import { acompanharEmVoo, quantosEmVoo, drenarEmVoo } from '../apps/api/src/lifecycle.js';

const daquiA = (ms: number, valor = 'ok') => new Promise((r) => setTimeout(() => r(valor), ms));

describe('acompanharEmVoo', () => {
  it('devolve a MESMA promessa (não pode mudar o valor de quem chamou)', async () => {
    const p = daquiA(1, 'valor');
    expect(await acompanharEmVoo(p)).toBe('valor');
  });

  it('conta enquanto roda e esquece quando termina', async () => {
    const base = quantosEmVoo();
    const p = acompanharEmVoo(daquiA(20));
    expect(quantosEmVoo()).toBe(base + 1);
    await p;
    // o `finally` roda num microtask depois da resolução
    await Promise.resolve();
    expect(quantosEmVoo()).toBe(base);
  });

  it('promessa REJEITADA também sai da conta, e a rejeição continua sendo de quem chamou', async () => {
    const base = quantosEmVoo();
    const p = acompanharEmVoo(Promise.reject(new Error('turno explodiu')));
    await expect(p).rejects.toThrow('turno explodiu');
    await Promise.resolve();
    expect(quantosEmVoo()).toBe(base);
  });
});

describe('drenarEmVoo', () => {
  it('sem nada em voo devolve 0 na hora', async () => {
    expect(await drenarEmVoo(50)).toBe(0);
  });

  it('espera o turno terminar e devolve 0', async () => {
    void acompanharEmVoo(daquiA(30));
    expect(await drenarEmVoo(500)).toBe(0);
  });

  it('devolve quantos NÃO terminaram no teto — o número que vira log de deploy', async () => {
    const lentos = [acompanharEmVoo(daquiA(400)), acompanharEmVoo(daquiA(400))];
    expect(await drenarEmVoo(40)).toBe(2);
    await Promise.all(lentos); // não deixa vazar pro próximo teste
  });

  it('um turno que falha não impede a drenagem dos outros', async () => {
    const ruim = acompanharEmVoo(Promise.reject(new Error('falhou')));
    ruim.catch(() => undefined); // o caller trata; aqui só não queremos unhandled
    void acompanharEmVoo(daquiA(10));
    expect(await drenarEmVoo(300)).toBe(0);
  });
});
