// Sessão de admin do dashboard — cookie httpOnly assinado (HMAC).
// Server-side only (usa node:crypto). NUNCA importar isto no middleware (Edge)
// nem em componente client. O middleware só checa PRESENÇA do cookie; a
// validação criptográfica de verdade acontece em /api/auth/token (Node).
import { createHmac, timingSafeEqual } from 'crypto';

export const SESSION_COOKIE = 'dash_session';
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 dias

function secret(): string {
  return process.env['DASHBOARD_SESSION_SECRET'] ?? '';
}

export function signSession(ttlMs = DEFAULT_TTL_MS): string {
  const payload = Buffer.from(JSON.stringify({ exp: Date.now() + ttlMs })).toString('base64url');
  const sig = createHmac('sha256', secret()).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

export function verifySession(value: string | undefined | null): boolean {
  if (!value || !secret()) return false;
  const dot = value.indexOf('.');
  if (dot <= 0) return false;
  const payload = value.slice(0, dot);
  const sig = value.slice(dot + 1);
  const expected = createHmac('sha256', secret()).update(payload).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
  try {
    const { exp } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8')) as { exp?: number };
    return typeof exp === 'number' && exp > Date.now();
  } catch {
    return false;
  }
}

/** Compara senha em tempo constante (evita timing attack). */
export function passwordMatches(input: string): boolean {
  const expected = process.env['DASHBOARD_PASSWORD'] ?? '';
  if (!expected) return false;
  const a = Buffer.from(String(input));
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
