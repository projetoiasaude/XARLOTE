// Gate do dashboard (admin). Roda no Edge — só checa a PRESENÇA do cookie de
// sessão (barato, evita flash da tela de admin). A validação criptográfica real
// acontece em /api/auth/token (Node) antes de liberar o token de admin, e o
// servidor da API ainda exige o token. Rotas públicas (/app, /login, /api,
// estáticos) NÃO são gateadas.
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

const SESSION_COOKIE = 'dash_session';

export function middleware(req: NextRequest) {
  const hasSession = !!req.cookies.get(SESSION_COOKIE)?.value;
  if (hasSession) return NextResponse.next();

  const url = req.nextUrl.clone();
  url.pathname = '/login';
  url.searchParams.set('next', req.nextUrl.pathname);
  return NextResponse.redirect(url);
}

export const config = {
  // Tudo, EXCETO: /app (cliente público), /login, /api (rotas Next), assets do
  // Next, manifest e arquivos estáticos comuns.
  matcher: [
    '/((?!app|login|api|_next/static|_next/image|favicon.ico|manifest.webmanifest|icon|.*\\.(?:png|jpg|jpeg|gif|svg|ico|webp|mp4|webmanifest|txt)).*)',
  ],
};
