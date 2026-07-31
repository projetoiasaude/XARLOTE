/**
 * Rede de segurança quando o REDIS PISCA (incidente 30/07, 3 vezes no mesmo dia).
 *
 * Cada piscada derrubava as DUAS proteções de envio ao mesmo tempo: a trava anti-duplicata
 * (Redis SET NX) e o rate-limit da fila — justo quando a infra está instável. Estes testes
 * blindam a segunda linha: uma trava LOCAL do processo e o espaçamento do envio direto.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { claimLocal, releaseLocal, directSendIntervalMs, pacePerInstance } from '../apps/api/src/queues/outbound.queue.js';

describe('claimLocal — trava de envio único que sobrevive ao Redis fora', () => {
  it('primeira vez reivindica, repetição do MESMO envio é barrada', () => {
    const key = `outb:sent:teste-${Math.random()}`;
    expect(claimLocal(key)).toBe(true);
    expect(claimLocal(key)).toBe(false);
    expect(claimLocal(key)).toBe(false);
  });

  it('envios DISTINTOS passam (não deduplica por conteúdo, e sim por enfileiramento)', () => {
    const a = `outb:sent:a-${Math.random()}`;
    const b = `outb:sent:b-${Math.random()}`;
    expect(claimLocal(a)).toBe(true);
    expect(claimLocal(b)).toBe(true);
  });

  it('não vira vazamento de memória: descarta o mais antigo passado do teto', () => {
    const first = `outb:sent:fifo-${Math.random()}`;
    claimLocal(first);
    for (let i = 0; i < 5_100; i++) claimLocal(`outb:sent:enche-${i}-${Math.random()}`);
    // O antigo saiu do Set — reivindicável de novo (o TTL do Redis cobre a janela real).
    expect(claimLocal(first)).toBe(true);
  });
});

describe('claimLocal + releaseLocal — retry legítimo NÃO pode ficar barrado pra sempre', () => {
  it('🔴 falha REAL de envio devolve a reivindicação e a retentativa passa', () => {
    // Achado da revisão adversarial: a chave nasce ANTES do envio e vive 15 min, enquanto
    // TODO o back-off do BullMQ (2s→4s→8s→16s) cabe dentro dela. Um 500 do zpro na 1ª
    // tentativa deixava a chave de pé, as 4 retentativas eram barradas, e o lembrete de
    // remédio nunca saía — ainda por cima carimbado como entregue.
    const key = `outb:sent:retry-${Math.random()}`;
    expect(claimLocal(key)).toBe(true);    // 1ª tentativa reivindica
    releaseLocal(key);                      // …o envio falhou de verdade → devolve
    expect(claimLocal(key)).toBe(true);     // retentativa PODE enviar
  });

  it('envio que DEU CERTO não devolve nada — duplicata segue barrada', () => {
    const key = `outb:sent:ok-${Math.random()}`;
    expect(claimLocal(key)).toBe(true);
    expect(claimLocal(key)).toBe(false);
  });
});

describe('directSendIntervalMs — o espaçamento do fallback espelha o limiter da fila', () => {
  const saved = { max: process.env['WA_RATE_MAX'], dur: process.env['WA_RATE_DURATION_MS'] };
  beforeEach(() => { delete process.env['WA_RATE_MAX']; delete process.env['WA_RATE_DURATION_MS']; });
  afterEach(() => {
    if (saved.max === undefined) delete process.env['WA_RATE_MAX']; else process.env['WA_RATE_MAX'] = saved.max;
    if (saved.dur === undefined) delete process.env['WA_RATE_DURATION_MS']; else process.env['WA_RATE_DURATION_MS'] = saved.dur;
  });

  it('default = 1 msg / 1200ms', () => {
    expect(directSendIntervalMs()).toBe(1200);
  });

  it('respeita a config (2 msgs por 1000ms → 500ms entre envios)', () => {
    process.env['WA_RATE_MAX'] = '2';
    process.env['WA_RATE_DURATION_MS'] = '1000';
    expect(directSendIntervalMs()).toBe(500);
  });

  it('env inválido NÃO desliga o espaçamento (NaN/0 cairiam em rajada = ban)', () => {
    process.env['WA_RATE_MAX'] = 'abc';
    process.env['WA_RATE_DURATION_MS'] = 'xyz';
    expect(directSendIntervalMs()).toBe(1200);
    process.env['WA_RATE_DURATION_MS'] = '0';
    expect(directSendIntervalMs()).toBe(1200);
  });
});

describe('pacePerInstance — rajada vira fila, mesmo sem o limiter da fila', () => {
  it('envios concorrentes na MESMA instância saem espaçados', async () => {
    process.env['WA_RATE_MAX'] = '1';
    process.env['WA_RATE_DURATION_MS'] = '40';
    const inst = `teste-${Math.random()}`;
    const t0 = Date.now();
    // Três disparos simultâneos (o padrão de um tick de lembretes).
    await Promise.all([pacePerInstance(inst), pacePerInstance(inst), pacePerInstance(inst)]);
    // Cada um reserva seu slot ANTES de esperar → o 3º sai ~80ms depois, não junto.
    expect(Date.now() - t0).toBeGreaterThanOrEqual(70);
    delete process.env['WA_RATE_MAX'];
    delete process.env['WA_RATE_DURATION_MS'];
  });

  it('🔴 espera tem TETO — emergência não fica atrás de 200 lembretes', async () => {
    // Achado da revisão: sem teto, uma queda de Redis durante um tick de lembretes
    // empurrava o slot pra +4min; qualquer envio seguinte (inclusive resposta de
    // emergência) esperava tudo isso — e o turno do paciente, que aguarda este await,
    // estouraria o orçamento de 75s. Degrada o espaçamento, nunca trava.
    process.env['WA_RATE_MAX'] = '1';
    process.env['WA_RATE_DURATION_MS'] = '10000';   // 10s por mensagem: fila enorme
    process.env['WA_FALLBACK_MAX_WAIT_MS'] = '50';  // teto pequeno pro teste ser rápido
    const inst = `congestionado-${Math.random()}`;
    await pacePerInstance(inst);                    // reserva agora
    await pacePerInstance(inst);                    // reserva +10s
    const t0 = Date.now();
    await pacePerInstance(inst);                    // pegaria +20s sem o teto
    expect(Date.now() - t0).toBeLessThan(1_000);
    delete process.env['WA_RATE_MAX'];
    delete process.env['WA_RATE_DURATION_MS'];
    delete process.env['WA_FALLBACK_MAX_WAIT_MS'];
  });

  it('instâncias DIFERENTES não se atrapalham (sara e agent são números distintos)', async () => {
    process.env['WA_RATE_MAX'] = '1';
    process.env['WA_RATE_DURATION_MS'] = '200';
    const t0 = Date.now();
    await Promise.all([pacePerInstance(`sara-${Math.random()}`), pacePerInstance(`agent-${Math.random()}`)]);
    expect(Date.now() - t0).toBeLessThan(150);
    delete process.env['WA_RATE_MAX'];
    delete process.env['WA_RATE_DURATION_MS'];
  });
});
