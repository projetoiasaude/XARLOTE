// Gate do dashboard (admin). Roda no Edge — só checa a PRESENÇA do cookie de
// sessão (barato, evita flash da tela de admin). A validação criptográfica real
// acontece em /api/auth/token (Node) antes de liberar o token de admin, e o
// servidor da API ainda exige o token. Rotas públicas (/app, /s/, /login, /api,
// estáticos) NÃO são gateadas.
//
// `/s/<token>` é a página do MÉDICO, e ela precisa ser pública por definição: quem abre
// não tem — e não pode ter — conta no dashboard. Sem a exceção, o médico cai na tela de
// login e conclui que o link do paciente está quebrado. A proteção do resumo não mora
// aqui: mora no token de 256 bits, no PIN opcional e na validade, conferidos pela API em
// `POST /share/resolve`.
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

const SESSION_COOKIE = 'dash_session';

/**
 * Domínios em que a RAIZ pertence ao público, não ao admin.
 *
 * O médico que recebe `xarlote.com.br/s/abc123` e — como gente cautelosa faz — apaga tudo
 * depois da barra pra ver quem mandou, não pode cair numa tela de login. Isso lê como
 * "você não deveria estar aqui", que é o oposto do que o link precisa transmitir no exato
 * momento em que ele decide se abre o resumo de um paciente.
 *
 * Só a raiz é desviada, e só nestes hosts: em `localhost` e no endereço `.vercel.app` o
 * comportamento antigo continua, senão desenvolver localmente viraria um pulo pro site.
 */
const DOMINIOS_PUBLICOS = new Set(['xarlote.com.br', 'www.xarlote.com.br']);
const SITE_INSTITUCIONAL = 'https://xarlote.ai';

export function middleware(req: NextRequest) {
  const hasSession = !!req.cookies.get(SESSION_COOKIE)?.value;
  if (hasSession) return NextResponse.next();

  // `host` (e não `nextUrl.hostname`) porque atrás do proxy da Vercel é o header que
  // carrega o domínio que a pessoa realmente digitou. A porta é descartada — em produção
  // não existe, e localmente atrapalharia a comparação.
  const host = (req.headers.get('host') ?? '').split(':')[0].toLowerCase();
  if (req.nextUrl.pathname === '/' && DOMINIOS_PUBLICOS.has(host)) {
    // 307 e não 308: se um dia a raiz virar uma landing própria neste projeto, um 308
    // já cacheado no navegador do médico continuaria mandando ele embora.
    return NextResponse.redirect(SITE_INSTITUCIONAL, 307);
  }

  const url = req.nextUrl.clone();
  url.pathname = '/login';
  url.searchParams.set('next', req.nextUrl.pathname);
  return NextResponse.redirect(url);
}

export const config = {
  // Tudo, EXCETO: /app (cliente público), /s/ (link do médico), /login, /api
  // (rotas Next), /privacidade e /suporte (páginas legais), assets do Next,
  // manifest e arquivos estáticos comuns.
  //
  // `s/` leva a barra de propósito: `s` sozinho no lookahead casaria por PREFIXO e
  // abriria também `/saude`, `/sessoes`, `/simulator` — o gate do dashboard cairia em
  // silêncio nessas telas. Com a barra, só `/s/<token>` escapa.
  //
  // `privacidade` e `suporte` são HTML estático em `public/`, servido em URL limpa por
  // um rewrite do next.config. Precisam ser públicos por obrigação externa: a Apple abre
  // as duas na revisão da App Store, e o art. 41 da LGPD exige um canal do Encarregado
  // acessível a qualquer titular — nenhum dos dois tem, nem pode ter, conta no dashboard.
  // Vão sem barra porque são segmentos inteiros e nenhuma outra rota começa por eles.
  // ⚠️ O middleware roda ANTES do rewrite: o caminho aqui é `/privacidade`, não
  // `/privacidade.html` — pôr só `html` na lista de extensões não resolveria.
  matcher: [
    '/((?!app|s/|login|api|privacidade|suporte|_next/static|_next/image|favicon.ico|manifest.webmanifest|icon|.*\\.(?:png|jpg|jpeg|gif|svg|ico|webp|mp4|webmanifest|txt|html)).*)',
  ],
};
