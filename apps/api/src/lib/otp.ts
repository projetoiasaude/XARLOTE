/**
 * otp — geração e validação do código de login do app (6 dígitos via WhatsApp).
 *
 * Decisões de segurança (e por quê):
 *   • O código NUNCA é guardado em claro: sha256(pepper + salt + code). O pepper vem
 *     de env (`OTP_PEPPER`) — um dump do banco sozinho não permite forjar códigos.
 *   • Salt aleatório POR LINHA: dois códigos iguais não produzem o mesmo hash.
 *   • `evaluateOtpAttempt` assume que o chamador INCREMENTOU `attempts` ANTES de
 *     comparar (update condicional no banco). Isso fecha a corrida de força bruta:
 *     dois requests paralelos não conseguem dois "attempts=1".
 *   • Comparação por hash com timingSafeEqual.
 *   • `nowMs` injetado; nenhuma leitura de relógio aqui dentro.
 */
import { createHash, timingSafeEqual } from 'crypto';

export const OTP_TTL_MS = 5 * 60_000;
export const OTP_MAX_ATTEMPTS = 3;
export const OTP_LENGTH = 6;

/** Gera o código com RNG injetado (testável). `randomInt(min, maxExclusive)`. */
export function generateOtpCode(randomInt: (min: number, maxExclusive: number) => number): string {
  return String(randomInt(0, 1_000_000)).padStart(OTP_LENGTH, '0');
}

export function hashOtp(code: string, salt: string, pepper: string): string {
  return createHash('sha256').update(`${pepper}:${salt}:${code}`).digest('hex');
}

export interface OtpRow {
  code_hash: string;
  salt: string;
  /** JÁ incrementado pelo chamador antes de avaliar. */
  attempts: number;
  max_attempts: number;
  expires_at: string;
  consumed_at: string | null;
}

export type OtpVerdict = 'ok' | 'expired' | 'exhausted' | 'consumed' | 'mismatch';

export function evaluateOtpAttempt(
  row: OtpRow,
  input: { code: string; pepper: string; nowMs: number },
): OtpVerdict {
  // Ordem importa: um código já usado ou vencido NUNCA diz "mismatch" (não dá
  // sinal de força bruta sobre um alvo morto).
  if (row.consumed_at) return 'consumed';
  if (Date.parse(row.expires_at) <= input.nowMs) return 'expired';
  if (row.attempts > row.max_attempts) return 'exhausted';

  const expected = Buffer.from(row.code_hash, 'hex');
  const provided = Buffer.from(hashOtp(input.code, row.salt, input.pepper), 'hex');
  if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
    return 'mismatch';
  }
  return 'ok';
}
