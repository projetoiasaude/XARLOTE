import { describe, it, expect } from 'vitest';
import { generateOtpCode, hashOtp, evaluateOtpAttempt, OTP_TTL_MS, OTP_MAX_ATTEMPTS } from '../apps/api/src/lib/otp.js';

/**
 * Blinda o OTP de login do app (código de 6 dígitos via WhatsApp).
 *
 * É a porta de entrada do prontuário — os invariantes aqui são de segurança:
 * TTL de 5min, 3 tentativas, hash com pepper+salt (dump do banco não forja código),
 * e ordem de veredito que não vaza sinal (consumido/vencido nunca dizem "mismatch").
 */

const PEPPER = 'pepper-de-teste';
const AGORA = Date.parse('2026-08-06T12:00:00Z');

function row(code: string, over: Partial<Parameters<typeof evaluateOtpAttempt>[0]> = {}) {
  const salt = 'salt-fixo';
  return {
    code_hash: hashOtp(code, salt, PEPPER),
    salt,
    attempts: 1, // o chamador SEMPRE incrementa antes de avaliar
    max_attempts: OTP_MAX_ATTEMPTS,
    expires_at: new Date(AGORA + OTP_TTL_MS).toISOString(),
    consumed_at: null,
    ...over,
  };
}

describe('generateOtpCode', () => {
  it('sempre 6 dígitos, com zeros à esquerda preservados', () => {
    expect(generateOtpCode(() => 7)).toBe('000007');
    expect(generateOtpCode(() => 123456)).toBe('123456');
    expect(generateOtpCode(() => 999999)).toBe('999999');
    expect(generateOtpCode(() => 0)).toBe('000000');
  });
});

describe('hashOtp', () => {
  it('mesmo código com salts diferentes → hashes diferentes', () => {
    expect(hashOtp('123456', 'a', PEPPER)).not.toBe(hashOtp('123456', 'b', PEPPER));
  });
  it('mesmo código+salt com pepper diferente → hash diferente (dump do banco não basta)', () => {
    expect(hashOtp('123456', 'a', PEPPER)).not.toBe(hashOtp('123456', 'a', 'outro'));
  });
});

describe('evaluateOtpAttempt', () => {
  it('código certo dentro do prazo → ok', () => {
    expect(evaluateOtpAttempt(row('123456'), { code: '123456', pepper: PEPPER, nowMs: AGORA })).toBe('ok');
  });

  it('código errado → mismatch', () => {
    expect(evaluateOtpAttempt(row('123456'), { code: '654321', pepper: PEPPER, nowMs: AGORA })).toBe('mismatch');
  });

  it('🔴 TTL de 5min é exato: 1ms após vencer → expired, mesmo com o código CERTO', () => {
    const r = row('123456');
    const vencido = Date.parse(r.expires_at);
    expect(evaluateOtpAttempt(r, { code: '123456', pepper: PEPPER, nowMs: vencido })).toBe('expired');
    expect(evaluateOtpAttempt(r, { code: '123456', pepper: PEPPER, nowMs: vencido - 1 })).toBe('ok');
  });

  it('🔴 4ª tentativa (attempts=4 > max 3) → exhausted, mesmo com o código certo', () => {
    expect(evaluateOtpAttempt(row('123456', { attempts: OTP_MAX_ATTEMPTS + 1 }), { code: '123456', pepper: PEPPER, nowMs: AGORA })).toBe('exhausted');
  });

  it('3ª tentativa (attempts=3 = max) ainda vale — o teto é DEPOIS dela', () => {
    expect(evaluateOtpAttempt(row('123456', { attempts: OTP_MAX_ATTEMPTS }), { code: '123456', pepper: PEPPER, nowMs: AGORA })).toBe('ok');
  });

  it('código já consumido → consumed (nunca reutilizável, nem com tudo certo)', () => {
    expect(evaluateOtpAttempt(row('123456', { consumed_at: new Date(AGORA - 1000).toISOString() }), { code: '123456', pepper: PEPPER, nowMs: AGORA })).toBe('consumed');
  });

  it('🔴 ordem de veredito não vaza sinal: vencido+errado → expired (não mismatch)', () => {
    const r = row('123456', { expires_at: new Date(AGORA - 1).toISOString() });
    expect(evaluateOtpAttempt(r, { code: '000000', pepper: PEPPER, nowMs: AGORA })).toBe('expired');
  });
});
