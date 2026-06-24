// POST /api/auth/login — troca senha por uma sessão (cookie httpOnly assinado).
// Roda no runtime Node (precisa de node:crypto). Não expõe o token de admin aqui.
import { NextResponse } from 'next/server';
import { signSession, passwordMatches, SESSION_COOKIE } from '@/lib/auth-cookie';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  let password = '';
  try {
    const body = (await req.json()) as { password?: string };
    password = String(body?.password ?? '');
  } catch {
    return NextResponse.json({ error: 'bad_request' }, { status: 400 });
  }

  if (!process.env['DASHBOARD_PASSWORD'] || !process.env['DASHBOARD_SESSION_SECRET']) {
    return NextResponse.json({ error: 'login_not_configured' }, { status: 503 });
  }
  if (!passwordMatches(password)) {
    return NextResponse.json({ error: 'invalid_credentials' }, { status: 401 });
  }

  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, signSession(), {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 7 * 24 * 60 * 60,
  });
  return res;
}
