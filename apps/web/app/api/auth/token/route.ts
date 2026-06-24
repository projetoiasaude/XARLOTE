// GET /api/auth/token — devolve o TOKEN DE ADMIN somente para uma sessão válida
// (cookie assinado). É o ÚNICO ponto onde o token chega ao navegador, e só após
// login. O token vive em variável de ambiente server-side (ADMIN_API_TOKEN),
// nunca no bundle público.
import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { verifySession, SESSION_COOKIE } from '@/lib/auth-cookie';

export const runtime = 'nodejs';

export async function GET() {
  const cookieStore = cookies();
  const session = cookieStore.get(SESSION_COOKIE)?.value;
  if (!verifySession(session)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const token = process.env['ADMIN_API_TOKEN'] ?? '';
  if (!token) {
    return NextResponse.json({ error: 'admin_token_not_configured' }, { status: 503 });
  }
  return NextResponse.json({ token }, { headers: { 'Cache-Control': 'no-store' } });
}
