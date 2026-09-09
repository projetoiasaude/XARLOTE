/**
 * Ponta a ponta contra um PORTAL FALSO, com o Playwright de verdade.
 *
 * Sobe um servidor HTTP local que imita o que 90% dos portais fazem — login, lista de
 * resultados, PDF — mais três variantes hostis (CAPTCHA, 2FA, senha errada). Roda o adapter
 * genérico contra cada uma e confere que ele entra onde deve, PARA onde deve, e que a parada
 * tem o nome certo.
 *
 * Nenhum laboratório real é tocado. Se o Chromium não estiver instalado
 * (`npx playwright install chromium`), o arquivo inteiro é pulado — não falha.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { adapterGenerico, type PaginaDoPortal } from '../packages/integrations/src/lab-portals/index.js';

const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF');
const LOGIN_OK = { login: 'P137956', senha: 'WtQv' };

const pagina = (corpo: string) => `<!doctype html><html><body>${corpo}</body></html>`;
const formLogin = (extra = '') => pagina(`
  <h1>Resultados de Exames</h1>${extra}
  <form method="post" action="/login">
    <input name="usuario" placeholder="Usuário">
    <input type="password" name="senha">
    <button type="submit">Entrar</button>
  </form>`);

function montarPortal(modo: 'ok' | 'captcha' | '2fa' | 'senha-errada' | 'vazio'): Server {
  return createServer((req, res) => {
    const url = req.url ?? '/';
    if (req.method === 'GET' && url === '/') {
      const extra = modo === 'captcha' ? '<div class="g-recaptcha" data-sitekey="abc"></div>' : '';
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(formLogin(extra)); return;
    }
    if (req.method === 'POST' && url === '/login') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const p = new URLSearchParams(body);
        const certo = p.get('usuario') === LOGIN_OK.login && p.get('senha') === LOGIN_OK.senha;
        if (!certo || modo === 'senha-errada') {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          res.end(formLogin('<p class="erro">Usuário ou senha inválida</p>')); return;
        }
        if (modo === '2fa') {
          res.writeHead(302, { location: '/2fa' }); res.end(); return;
        }
        res.writeHead(302, { location: '/resultados', 'set-cookie': 'sessao=ok; Path=/' }); res.end();
      });
      return;
    }
    if (url === '/2fa') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(pagina('<p>Enviamos um código para o seu celular.</p><input inputmode="numeric" maxlength="6">')); return;
    }
    if (url === '/resultados') {
      if (!/sessao=ok/.test(req.headers.cookie ?? '')) { res.writeHead(302, { location: '/' }); res.end(); return; }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(modo === 'vazio'
        ? pagina('<h1>Seus exames</h1><p>Nenhum resultado liberado.</p><a href="/sair">Sair</a>')
        : pagina('<h1>Seus exames</h1><ul><li><a href="/laudo/1.pdf">Hemograma completo — Baixar</a></li><li><a href="/laudo/2.pdf">Glicemia — Baixar</a></li><li><a href="/sair">Sair</a></li></ul>'));
      return;
    }
    if (url.startsWith('/laudo/')) {
      if (!/sessao=ok/.test(req.headers.cookie ?? '')) { res.writeHead(403); res.end(); return; }
      res.writeHead(200, { 'content-type': 'application/octet-stream' }); res.end(PDF); return;
    }
    res.writeHead(404); res.end();
  });
}

let chromiumDisponivel = false;
let pw: typeof import('playwright') | null = null;

beforeAll(async () => {
  try {
    pw = await import('playwright');
    const b = await pw.chromium.launch({ headless: true });
    await b.close();
    chromiumDisponivel = true;
  } catch {
    chromiumDisponivel = false;
  }
});

async function comPortal<T>(modo: Parameters<typeof montarPortal>[0], fn: (base: string, p: PaginaDoPortal) => Promise<T>): Promise<T> {
  const server = montarPortal(modo);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;
  const browser = await pw!.chromium.launch({ headless: true });
  try {
    const ctx = await browser.newContext({ userAgent: 'Xarlote/1.0 (+https://xarlote.ai) teste' });
    const page = await ctx.newPage();
    const p: PaginaDoPortal = {
      goto: (u, o) => page.goto(u, { timeout: o?.timeout ?? 10_000, waitUntil: 'domcontentloaded' }),
      url: () => page.url(),
      content: () => page.content(),
      fill: (s, v) => page.fill(s, v, { timeout: 3_000 }),
      click: (s, o) => page.click(s, { timeout: o?.timeout ?? 3_000 }),
      waitForLoadState: (st, o) => page.waitForLoadState(st ?? 'load', { timeout: o?.timeout ?? 10_000 }),
      async clicarEEsperar(s, o) {
        const espera = page.waitForEvent('load', { timeout: Math.min(o?.timeout ?? 10_000, 8_000) }).catch(() => null);
        await page.click(s, { timeout: 3_000 });
        await espera;
        await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => undefined);
      },
      async baixar(u) {
        const r = await page.request.get(u, { timeout: 10_000 });
        return { contentType: r.headers()['content-type'] ?? '', body: Buffer.from(await r.body()) };
      },
      coletar: (s, attrs) => page.$$eval(s, (els, a) =>
        els.map((el) => Object.fromEntries(a.map((k) => [k, k === 'textContent' ? (el.textContent ?? null) : el.getAttribute(k)]))), attrs as string[]),
      existe: (s) => page.locator(s).first().isVisible().catch(() => false),
    };
    await p.goto(base);
    return await fn(base, p);
  } finally {
    await browser.close();
    await new Promise<void>((r) => server.close(() => r()));
  }
}

describe('adapter genérico contra um portal falso', () => {
  it('entra, lista e baixa os dois PDFs — o caminho feliz', async (ctx) => {
    if (!chromiumDisponivel) return ctx.skip();
    await comPortal('ok', async (_base, p) => {
      const login = await adapterGenerico.login(p, LOGIN_OK);
      expect(login).toEqual({ ok: true });
      const itens = await adapterGenerico.listarResultados(p);
      // "Sair" não é resultado; os dois laudos são. O `href` é o dado estável — o rótulo é
      // texto de tela e pode vir com espaço/quebra do HTML.
      expect(itens.map((i) => new URL(i.href!).pathname)).toEqual(['/laudo/1.pdf', '/laudo/2.pdf']);
      expect(itens[0]!.rotulo).toMatch(/Hemograma/);
      expect(itens[1]!.rotulo).toMatch(/Glicemia/);
      const pdf = await adapterGenerico.baixar(p, itens[0]!);
      expect(pdf?.toString('latin1', 0, 5)).toBe('%PDF-');
    });
  }, 30_000);

  it('CAPTCHA na tela de login: PARA antes de digitar qualquer coisa', async (ctx) => {
    if (!chromiumDisponivel) return ctx.skip();
    await comPortal('captcha', async (_b, p) => {
      expect(await adapterGenerico.login(p, LOGIN_OK)).toEqual({ ok: false, motivo: 'bloqueado_captcha' });
    });
  }, 30_000);

  it('2FA depois do login: PARA e nomeia', async (ctx) => {
    if (!chromiumDisponivel) return ctx.skip();
    await comPortal('2fa', async (_b, p) => {
      expect(await adapterGenerico.login(p, LOGIN_OK)).toEqual({ ok: false, motivo: 'bloqueado_2fa' });
    });
  }, 30_000);

  it('senha errada: uma tentativa só, nome certo', async (ctx) => {
    if (!chromiumDisponivel) return ctx.skip();
    await comPortal('senha-errada', async (_b, p) => {
      expect(await adapterGenerico.login(p, { login: 'P137956', senha: 'errada' })).toEqual({ ok: false, motivo: 'credenciais_invalidas' });
    });
  }, 30_000);

  it('logou mas não há resultado liberado: lista vazia (o orquestrador vira sem_resultados)', async (ctx) => {
    if (!chromiumDisponivel) return ctx.skip();
    await comPortal('vazio', async (_b, p) => {
      expect(await adapterGenerico.login(p, LOGIN_OK)).toEqual({ ok: true });
      expect(await adapterGenerico.listarResultados(p)).toEqual([]);
    });
  }, 30_000);
});
