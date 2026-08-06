/**
 * app-jwt — JWT HS256 do PACIENTE (access token do app), feito à mão com node:crypto.
 *
 * Por que à mão e não uma lib: o projeto já assina JWT RS256 manualmente pro FCM
 * (packages/integrations/src/push.ts) e HMAC pro dashboard (apps/web/lib/auth-cookie.ts) —
 * mesmo padrão, zero dependência nova, superfície auditável em 100 linhas.
 *
 * Contrato de segurança:
 *   • Access curto (15min) — revogação dura acontece no REFRESH (app_sessions), não aqui.
 *   • `verifyAppJwt` NUNCA lança: devolve razão tipada. Falha de parse ≠ assinatura
 *     inválida ≠ expirado — o cliente trata `expired` com refresh e o resto com logout.
 *   • Comparação de assinatura com timingSafeEqual (mesma disciplina do resto do repo).
 *   • `nowMs` injetado — o tempo é testável.
 */
import { createHmac, timingSafeEqual } from 'crypto';

export const APP_JWT_ISSUER = 'xarlote';
export const APP_JWT_AUDIENCE = 'app';
export const APP_ACCESS_TTL_S = 15 * 60;

export interface AppJwtClaims {
  /** user_id */
  sub: string;
  /** app_session id — amarra o access à sessão que pode ser revogada */
  sid: string;
  iat: number;
  exp: number;
  iss: typeof APP_JWT_ISSUER;
  aud: typeof APP_JWT_AUDIENCE;
}

export type VerifyResult =
  | { ok: true; claims: AppJwtClaims }
  | { ok: false; reason: 'malformed' | 'bad_signature' | 'expired' | 'wrong_issuer_or_audience' };

function b64url(buf: Buffer): string {
  return buf.toString('base64url');
}

function hmac(payload: string, secret: string): Buffer {
  return createHmac('sha256', secret).update(payload).digest();
}

export function signAppJwt(
  input: { userId: string; sessionId: string },
  secret: string,
  nowMs: number,
  ttlS = APP_ACCESS_TTL_S,
): string {
  const header = b64url(Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const iat = Math.floor(nowMs / 1000);
  const claims: AppJwtClaims = {
    sub: input.userId,
    sid: input.sessionId,
    iat,
    exp: iat + ttlS,
    iss: APP_JWT_ISSUER,
    aud: APP_JWT_AUDIENCE,
  };
  const payload = b64url(Buffer.from(JSON.stringify(claims)));
  const signature = b64url(hmac(`${header}.${payload}`, secret));
  return `${header}.${payload}.${signature}`;
}

export function verifyAppJwt(token: string, secret: string, nowMs: number): VerifyResult {
  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'malformed' };
  const [header, payload, signature] = parts as [string, string, string];

  // Assinatura ANTES de olhar o conteúdo: payload não-verificado é entrada hostil.
  const expected = hmac(`${header}.${payload}`, secret);
  let provided: Buffer;
  try {
    provided = Buffer.from(signature, 'base64url');
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return { ok: false, reason: 'bad_signature' };
  }

  let claims: AppJwtClaims;
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as AppJwtClaims;
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (typeof claims.sub !== 'string' || !claims.sub || typeof claims.sid !== 'string' || !claims.sid) {
    return { ok: false, reason: 'malformed' };
  }
  if (claims.iss !== APP_JWT_ISSUER || claims.aud !== APP_JWT_AUDIENCE) {
    return { ok: false, reason: 'wrong_issuer_or_audience' };
  }
  if (typeof claims.exp !== 'number' || claims.exp * 1000 <= nowMs) {
    return { ok: false, reason: 'expired' };
  }
  return { ok: true, claims };
}
