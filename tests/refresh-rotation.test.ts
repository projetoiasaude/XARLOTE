import { describe, it, expect } from 'vitest';
import { randomBytes } from 'crypto';
import {
  newRefreshToken,
  hashRefreshToken,
  decideRefresh,
  REFRESH_GRACE_MS,
  REFRESH_MAX_AGE_DAYS,
} from '../apps/api/src/lib/refresh-token.js';

/**
 * Blinda a rotação do refresh token — a peça que dá revogação DE VERDADE à sessão.
 *
 * Os dois comportamentos que não podem regredir:
 *   1. GRAÇA de 60s pro token anterior: rede móvel repete requests; o retry legítimo
 *      do MESMO refresh não pode derrubar a sessão do paciente.
 *   2. Reuso FORA da graça = token vazou → 'reuse' → o chamador REVOGA a sessão.
 *      Detectar roubo custa a sessão, nunca a conta.
 */

const AGORA = Date.parse('2026-08-06T12:00:00Z');

const atual = hashRefreshToken('token-atual');
const anterior = hashRefreshToken('token-anterior');

function sessao(over: Partial<Parameters<typeof decideRefresh>[0]> = {}) {
  return {
    refresh_hash: atual,
    prev_refresh_hash: anterior,
    prev_valid_until: new Date(AGORA + REFRESH_GRACE_MS).toISOString(),
    revoked_at: null,
    created_at: new Date(AGORA - 30 * 86_400_000).toISOString(), // sessão de 30 dias
    ...over,
  };
}

describe('newRefreshToken / hashRefreshToken', () => {
  it('token tem entropia de 256 bits e sai em base64url', () => {
    const t = newRefreshToken(randomBytes);
    expect(t.length).toBeGreaterThanOrEqual(42);
    expect(t).toMatch(/^[A-Za-z0-9_-]+$/);
  });
  it('dois tokens nunca coincidem', () => {
    expect(newRefreshToken(randomBytes)).not.toBe(newRefreshToken(randomBytes));
  });
});

describe('decideRefresh', () => {
  it('token vigente → rotate', () => {
    expect(decideRefresh(sessao(), atual, AGORA)).toBe('rotate');
  });

  it('🔴 token ANTERIOR dentro da graça → grace (retry de rede móvel não derruba sessão)', () => {
    expect(decideRefresh(sessao(), anterior, AGORA + REFRESH_GRACE_MS - 1)).toBe('grace');
  });

  it('🔴 token ANTERIOR fora da graça → reuse (vazou → chamador revoga a sessão)', () => {
    expect(decideRefresh(sessao(), anterior, AGORA + REFRESH_GRACE_MS + 1)).toBe('reuse');
  });

  it('token desconhecido → invalid', () => {
    expect(decideRefresh(sessao(), hashRefreshToken('qualquer-outro'), AGORA)).toBe('invalid');
  });

  it('sessão revogada → invalid mesmo com o token vigente', () => {
    expect(decideRefresh(sessao({ revoked_at: new Date(AGORA - 1000).toISOString() }), atual, AGORA)).toBe('invalid');
  });

  it(`idade máxima absoluta de ${REFRESH_MAX_AGE_DAYS}d → invalid (re-login por OTP)`, () => {
    const velha = sessao({ created_at: new Date(AGORA - (REFRESH_MAX_AGE_DAYS + 1) * 86_400_000).toISOString() });
    expect(decideRefresh(velha, atual, AGORA)).toBe('invalid');
  });

  it('sessão SEM prev (primeiro uso) não dá graça pra ninguém', () => {
    const primeira = sessao({ prev_refresh_hash: null, prev_valid_until: null });
    expect(decideRefresh(primeira, anterior, AGORA)).toBe('invalid');
  });

  it('created_at corrompido → invalid (nunca uma sessão eterna por lixo no banco)', () => {
    expect(decideRefresh(sessao({ created_at: 'lixo' }), atual, AGORA)).toBe('invalid');
  });
});
