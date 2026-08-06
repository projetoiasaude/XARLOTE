import { describe, it, expect } from 'vitest';
import { signAppJwt, verifyAppJwt, APP_ACCESS_TTL_S } from '../apps/api/src/lib/app-jwt.js';

/**
 * Blinda o access token do PACIENTE (app nativo).
 *
 * Contexto (auditoria 05/08 que originou o plano do app): hoje NÃO existe auth de
 * paciente — digitar um telefone dá acesso ao prontuário completo. Este JWT é a peça
 * que fecha esse buraco, então os modos de falha importam mais que o caminho feliz:
 * um verify permissivo aqui reabriria exatamente a vulnerabilidade que o app existe
 * pra eliminar.
 */

const SECRET = 'segredo-de-teste-com-entropia-suficiente-123';
const AGORA = Date.parse('2026-08-06T12:00:00Z');

describe('signAppJwt / verifyAppJwt — caminho feliz', () => {
  it('assina e verifica com os claims certos', () => {
    const token = signAppJwt({ userId: 'user-1', sessionId: 'sess-1' }, SECRET, AGORA);
    const v = verifyAppJwt(token, SECRET, AGORA + 1000);
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.claims.sub).toBe('user-1');
      expect(v.claims.sid).toBe('sess-1');
      expect(v.claims.iss).toBe('xarlote');
      expect(v.claims.aud).toBe('app');
      expect(v.claims.exp - v.claims.iat).toBe(APP_ACCESS_TTL_S);
    }
  });

  it('expira EXATAMENTE no exp (revogação dura é do refresh, mas o access não sobrevive)', () => {
    const token = signAppJwt({ userId: 'u', sessionId: 's' }, SECRET, AGORA);
    const umSegundoAntes = AGORA + (APP_ACCESS_TTL_S - 1) * 1000;
    const noExp = AGORA + APP_ACCESS_TTL_S * 1000;
    expect(verifyAppJwt(token, SECRET, umSegundoAntes).ok).toBe(true);
    const v = verifyAppJwt(token, SECRET, noExp);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe('expired');
  });
});

describe('🔴 verifyAppJwt — modos de falha (cada um com a razão certa)', () => {
  const token = signAppJwt({ userId: 'u', sessionId: 's' }, SECRET, AGORA);

  it('segredo errado → bad_signature (não expired, não malformed)', () => {
    const v = verifyAppJwt(token, 'outro-segredo', AGORA);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe('bad_signature');
  });

  it('payload adulterado (sub trocado) → bad_signature', () => {
    const [h, , s] = token.split('.') as [string, string, string];
    const forjado = Buffer.from(JSON.stringify({
      sub: 'OUTRO-usuario', sid: 's', iat: Math.floor(AGORA / 1000),
      exp: Math.floor(AGORA / 1000) + 900, iss: 'xarlote', aud: 'app',
    })).toString('base64url');
    const v = verifyAppJwt(`${h}.${forjado}.${s}`, SECRET, AGORA);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe('bad_signature');
  });

  it.each([
    ['vazio', ''],
    ['sem pontos', 'abcdef'],
    ['duas partes', 'a.b'],
    ['quatro partes', 'a.b.c.d'],
    ['lixo base64', '!!!.???.###'],
  ])('malformado (%s) → malformed', (_nome, t) => {
    const v = verifyAppJwt(t, SECRET, AGORA);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(['malformed', 'bad_signature']).toContain(v.reason);
  });

  it('access expirado retorna expired — é o sinal pro app dar refresh, não logout', () => {
    const velho = signAppJwt({ userId: 'u', sessionId: 's' }, SECRET, AGORA - 3_600_000);
    const v = verifyAppJwt(velho, SECRET, AGORA);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe('expired');
  });
});
