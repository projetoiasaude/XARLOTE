/**
 * A data que o médico lê na página do resumo.
 *
 * Estes casos não são hipotéticos: em 18/08/2026, com um paciente sintético, a página em
 * produção mostrou `31/07/2026` para um exame de `2026-08-01` e `31/03/2019` para uma
 * condição iniciada em `2019-04-01`. Toda data aparecia um dia antes. O teste existe para
 * que a próxima pessoa que mexer no formatador descubra isso aqui, e não num consultório.
 */
import { describe, it, expect } from 'vitest';
import { dataBr } from '../apps/web/lib/br-data.js';

describe('dataBr — coluna DATE não tem fuso para converter', () => {
  it('mantém o dia primeiro do mês (o caso que quebrava)', () => {
    expect(dataBr('2026-08-01')).toBe('01/08/2026');
    expect(dataBr('2019-04-01')).toBe('01/04/2019');
  });

  it('mantém qualquer data pura, inclusive virada de ano', () => {
    expect(dataBr('2026-07-12')).toBe('12/07/2026');
    expect(dataBr('2021-09-15')).toBe('15/09/2021');
    expect(dataBr('2025-01-01')).toBe('01/01/2025');
    expect(dataBr('2024-12-31')).toBe('31/12/2024');
  });

  it('data pura de 29 de fevereiro sobrevive', () => {
    expect(dataBr('2024-02-29')).toBe('29/02/2024');
  });
});

describe('dataBr — instante COM hora vira horário de Brasília', () => {
  it('converte de UTC para BRT', () => {
    // 01/08 às 02:00 UTC ainda é 31/07 às 23:00 no Brasil.
    expect(dataBr('2026-08-01T02:00:00Z')).toBe('31/07/2026');
    // 01/08 às 03:00 UTC já é meia-noite do dia 1º no Brasil.
    expect(dataBr('2026-08-01T03:00:00Z')).toBe('01/08/2026');
  });

  it('não depende do fuso da máquina que roda o teste', () => {
    // Se o formatador usasse hora local, este valor mudaria conforme o TZ do processo.
    const tz = process.env.TZ;
    process.env.TZ = 'Asia/Tokyo';
    expect(dataBr('2026-08-01')).toBe('01/08/2026');
    expect(dataBr('2026-08-01T12:00:00Z')).toBe('01/08/2026');
    process.env.TZ = tz;
  });
});

describe('dataBr — entrada ruim não vira data inventada', () => {
  it('vazio, nulo e lixo viram string vazia', () => {
    expect(dataBr(null)).toBe('');
    expect(dataBr(undefined)).toBe('');
    expect(dataBr('')).toBe('');
    expect(dataBr('nao é data')).toBe('');
  });
});
