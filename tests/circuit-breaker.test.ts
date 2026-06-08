import { describe, it, expect } from 'vitest';
import { CircuitBreaker, CircuitOpenError, getBreaker } from '../packages/shared/src/circuit-breaker.js';

// Clock controlável pra testar as transições temporais sem timers reais.
function fakeClock(start = 0) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

const fail = async () => { throw new Error('boom'); };
const ok = async () => 'ok';

describe('CircuitBreaker', () => {
  it('fica closed e executa normalmente em sucesso', async () => {
    const b = new CircuitBreaker('t', { now: () => 0 });
    await expect(b.execute(ok)).resolves.toBe('ok');
    expect(b.getState()).toBe('closed');
  });

  it('abre após failureThreshold falhas consecutivas', async () => {
    const b = new CircuitBreaker('t', { failureThreshold: 3, now: () => 0 });
    for (let i = 0; i < 3; i++) {
      await expect(b.execute(fail)).rejects.toThrow('boom');
    }
    expect(b.getState()).toBe('open');
  });

  it('quando aberto, falha rápido com CircuitOpenError SEM chamar fn', async () => {
    const clock = fakeClock();
    const b = new CircuitBreaker('t', { failureThreshold: 2, cooldownMs: 1000, now: clock.now });
    await expect(b.execute(fail)).rejects.toThrow('boom');
    await expect(b.execute(fail)).rejects.toThrow('boom'); // abre aqui
    expect(b.getState()).toBe('open');

    let called = false;
    const spy = async () => { called = true; return 'x'; };
    await expect(b.execute(spy)).rejects.toBeInstanceOf(CircuitOpenError);
    expect(called).toBe(false); // não chamou fn
  });

  it('um sucesso zera a contagem de falhas (não abre)', async () => {
    const b = new CircuitBreaker('t', { failureThreshold: 3, now: () => 0 });
    await expect(b.execute(fail)).rejects.toThrow();
    await expect(b.execute(fail)).rejects.toThrow();
    await expect(b.execute(ok)).resolves.toBe('ok'); // zera
    await expect(b.execute(fail)).rejects.toThrow();
    await expect(b.execute(fail)).rejects.toThrow();
    expect(b.getState()).toBe('closed'); // só 2 falhas após o reset
  });

  it('após cooldown vai pra half-open; sucesso fecha', async () => {
    const clock = fakeClock();
    const b = new CircuitBreaker('t', { failureThreshold: 1, cooldownMs: 1000, successThreshold: 1, now: clock.now });
    await expect(b.execute(fail)).rejects.toThrow(); // abre
    expect(b.getState()).toBe('open');
    clock.advance(1000); // passa o cooldown
    expect(b.getState()).toBe('half-open');
    await expect(b.execute(ok)).resolves.toBe('ok'); // sucesso de teste → fecha
    expect(b.getState()).toBe('closed');
  });

  it('falha em half-open reabre o circuito', async () => {
    const clock = fakeClock();
    const b = new CircuitBreaker('t', { failureThreshold: 1, cooldownMs: 1000, now: clock.now });
    await expect(b.execute(fail)).rejects.toThrow(); // abre
    clock.advance(1000);
    expect(b.getState()).toBe('half-open');
    await expect(b.execute(fail)).rejects.toThrow('boom'); // teste falhou → reabre
    expect(b.getState()).toBe('open');
  });

  it('getBreaker retorna a MESMA instância pro mesmo nome', () => {
    const a = getBreaker('dep-x');
    const b = getBreaker('dep-x');
    expect(a).toBe(b);
    expect(getBreaker('dep-y')).not.toBe(a);
  });
});
