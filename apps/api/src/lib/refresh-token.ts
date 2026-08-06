/**
 * refresh-token — sessão longa do app com ROTAÇÃO e detecção de reuso.
 *
 * Modelo (padrão de mercado pra mobile):
 *   • O refresh é opaco (256 bits), o banco guarda só o sha256 (`app_sessions.refresh_hash`).
 *   • A cada uso ele ROTACIONA: o antigo vira `prev_refresh_hash` com uma JANELA DE
 *     GRAÇA de 60s (`prev_valid_until`). Por quê: rede móvel repete requests — o app
 *     manda o refresh, o 200 se perde no túnel, e ele re-manda o MESMO token. Sem a
 *     graça, esse retry legítimo derrubaria a sessão do paciente.
 *   • Reuso do antigo FORA da graça = o token vazou (alguém replayou) → a sessão
 *     inteira é revogada. É o trade clássico: detectar roubo custa a sessão, nunca
 *     a conta.
 *   • Idade máxima absoluta: 180 dias — depois disso re-login por OTP.
 *
 * PURO: decisão separada de I/O; `nowMs` injetado.
 */
import { createHash } from 'crypto';

export const REFRESH_TOKEN_BYTES = 32;
export const REFRESH_GRACE_MS = 60_000;
export const REFRESH_MAX_AGE_DAYS = 180;

/** Gera o refresh com RNG injetado (`randomBytes`-like). Sai em base64url. */
export function newRefreshToken(randomBytes: (n: number) => Buffer): string {
  return randomBytes(REFRESH_TOKEN_BYTES).toString('base64url');
}

export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export interface SessionRow {
  refresh_hash: string;
  prev_refresh_hash: string | null;
  prev_valid_until: string | null;
  revoked_at: string | null;
  created_at: string;
}

export type RefreshVerdict =
  /** token vigente → rotacionar e emitir par novo */
  | 'rotate'
  /** token anterior DENTRO da graça (retry de rede) → devolver o par vigente, sem rotacionar de novo */
  | 'grace'
  /** token anterior FORA da graça → REUSO detectado → revogar a sessão */
  | 'reuse'
  /** não pertence a esta sessão / sessão revogada / idade máxima estourada */
  | 'invalid';

export function decideRefresh(session: SessionRow, providedHash: string, nowMs: number): RefreshVerdict {
  if (session.revoked_at) return 'invalid';
  const ageMs = nowMs - Date.parse(session.created_at);
  if (!Number.isFinite(ageMs) || ageMs > REFRESH_MAX_AGE_DAYS * 86_400_000) return 'invalid';

  if (providedHash === session.refresh_hash) return 'rotate';

  if (session.prev_refresh_hash && providedHash === session.prev_refresh_hash) {
    const until = session.prev_valid_until ? Date.parse(session.prev_valid_until) : 0;
    return nowMs <= until ? 'grace' : 'reuse';
  }
  return 'invalid';
}
