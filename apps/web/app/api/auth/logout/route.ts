// POST /api/auth/logout — encerra a sessão (limpa o cookie).
import { NextResponse } from 'next/server';
import { SESSION_COOKIE } from '@/lib/auth-cookie';

export const runtime = 'nodejs';

export async function POST() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, '', { httpOnly: true, secure: true, sameSite: 'lax', path: '/', maxAge: 0 });
  return res;
}
