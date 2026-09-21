/**
 * O adapter Synapse EIS/RIS (portal do CDI Goiânia) e o reconhecimento — com uma página
 * FALSA que reproduz o que o portal real mostrou em 21/09/2026 (acessibilidade lida ao vivo:
 * banner de cookies, "Digite seu login", senha, input type=date, botão Entrar).
 */
import { describe, it, expect } from 'vitest';
import { adapterSynapse, adapterGenerico, escolherAdapter, escolherAdapterPelaPagina, type PaginaDoPortal, type CredenciaisLab } from '../packages/integrations/src/lab-portals/index.js';
import { verificarAnuncios, semAnuncios, falaHonestaPara, FAMILIAS_DE_PROMESSA_SEM_FERRAMENTA } from '../packages/shared/src/claim-guard';

const HTML_LOGIN = `<html><head><title>Synapse EIS/RIS - Enterprise Imaging</title></head><body>
<div>Utilizamos cookies para autenticação e para o funcionamento do sistema.</div><button type="button">Rejeitar</button><button type="button">Aceitar</button>
<form><label>Protocolo</label><input type="text" placeholder="Digite seu login"><label>Senha</label><input type="password" placeholder="Digite sua senha">
<label>Data de Nascimento</label><input type="date"><button type="submit">Entrar</button></form><button type="button">Perdi meu protocolo</button></body></html>`;
const HTML_LOGADO = `<html><head><title>Synapse EIS/RIS - Enterprise Imaging</title></head><body><h1>Meus exames</h1>
<div>EEG prolongado — 14/09/2026 <button id="btn-laudo-1">Laudo</button> <a href="/api/laudo/123.pdf">Baixar PDF</a></div></body></html>`;
const HTML_ERRO = `<html><head><title>Synapse EIS/RIS</title></head><body><form><input type="text" placeholder="Digite seu login"><input type="password"><input type="date"></form><div role="alert">Protocolo ou senha inválidos</div></body></html>`;

/** Página falsa: estado 'login' → após submit vira 'logado' (ou 'erro' quando a senha é "errada"). */
function paginaFalsa(opts: { cookies?: boolean } = {}): PaginaDoPortal & { preenchido: Record<string, string>; cliques: string[]; estado: string } {
  const st = { estado: 'login', preenchido: {} as Record<string, string>, cliques: [] as string[], cookiesVisiveis: opts.cookies ?? true };
  const html = () => st.estado === 'login' ? HTML_LOGIN : st.estado === 'logado' ? HTML_LOGADO : HTML_ERRO;
  const existe = (sel: string): boolean => {
    if (sel.includes('Aceitar')) return st.cookiesVisiveis && st.estado === 'login';
    if (sel.includes('Digite seu login') || sel === 'input[type="text"]') return st.estado !== 'logado';
    if (sel.includes('type="password"')) return st.estado !== 'logado';
    if (sel.includes('type="date"')) return st.estado !== 'logado';
    if (sel.includes('submit')) return st.estado !== 'logado';
    return false;
  };
  return {
    get preenchido() { return st.preenchido; }, get cliques() { return st.cliques; }, get estado() { return st.estado; },
    async goto() { return null; }, url: () => 'https://novo.cdig.com.br/resultado/',
    async content() { return html(); },
    async fill(sel, v) { st.preenchido[sel] = v; },
    async click(sel) {
      st.cliques.push(sel);
      if (sel.includes('Aceitar')) st.cookiesVisiveis = false;
      if (sel.includes('submit')) st.estado = st.preenchido['input[type="password"]'] === 'errada' ? 'erro' : 'logado';
    },
    async clicarEEsperar(sel) { await this.click(sel); },
    async waitForLoadState() { /* nada */ },
    async esperar() { /* nada */ },
    async baixar(url) { return url.endsWith('.pdf') ? { contentType: 'application/pdf', body: Buffer.from('%PDF-1.4 laudo') } : { contentType: 'text/html', body: Buffer.from('<html>') }; },
    async coletar(sel) {
      if (sel === 'input[type="password"]') return st.estado === 'logado' ? [] : [{ name: 'senha', id: null }];
      if (sel === 'a[href]') return st.estado === 'logado' ? [{ href: '/api/laudo/123.pdf', textContent: 'Baixar PDF', title: null, 'aria-label': null }] : [];
      if (sel.startsWith('button')) return st.estado === 'logado' ? [{ textContent: 'Laudo', title: null, 'aria-label': null, id: 'btn-laudo-1', 'data-testid': null }] : [];
      return [];
    },
    async existe(sel) { return existe(sel); },
    async clicarEBaixar(sel) { st.cliques.push(sel); return { contentType: 'application/octet-stream', body: Buffer.from('%PDF-1.4 por clique') }; },
  };
}

const CREDS: CredenciaisLab = { login: '6160668', senha: 'segredo', protocolo: '6160668', nascimento: '1990-03-15' };

describe('escolha do adapter', () => {
  it('pela URL do protocolo (cdig.com.br) e pelo nome ("CDI G"); "CDI" cru não basta', () => {
    expect(escolherAdapter({ url: 'cdig.com.br', nome: 'CDI' }).id).toBe('synapse-eis');
    expect(escolherAdapter({ url: null, nome: 'CDI G' }).id).toBe('synapse-eis');
    expect(escolherAdapter({ url: null, nome: 'CDI' }).id).toBe('generico');
    expect(escolherAdapter({ url: 'https://resultados.outrolab.com.br', nome: 'Outro' }).id).toBe('generico');
  });
  it('pela PÁGINA: a tela de resultados se apresenta como Synapse', () => {
    expect(escolherAdapterPelaPagina(HTML_LOGIN, adapterGenerico).id).toBe('synapse-eis');
    expect(escolherAdapterPelaPagina('<html><title>Lab X</title><input type="password"></html>', adapterGenerico).id).toBe('generico');
  });
  it('o Synapse sabe de antemão que pede a data de nascimento', () => {
    expect(adapterSynapse.camposObrigatorios).toEqual(['login', 'senha', 'nascimento']);
  });
});

describe('reconhecimento (sem digitar nada)', () => {
  it('Synapse: aceita cookies, reconhece o formulário e lista os campos', async () => {
    const p = paginaFalsa();
    await adapterSynapse.preparar!(p);
    expect(p.cliques.some((c) => c.includes('Aceitar'))).toBe(true);
    const r = await adapterSynapse.reconhecer(p);
    expect(r).toEqual({ ok: true, campos: ['login', 'senha', 'nascimento'] });
    expect(Object.keys(p.preenchido)).toEqual([]); // nada digitado
  });
  it('genérico: também reconhece (senha única + campo de usuário), e vê o campo de data', async () => {
    const p = paginaFalsa();
    const r = await adapterGenerico.reconhecer(p);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.campos).toContain('nascimento');
  });
  it('página sem formulário → portal_desconhecido; CAPTCHA → bloqueado_captcha', async () => {
    const p = paginaFalsa();
    (p as { estado: string }).estado; // só pra ler
    const semForm: PaginaDoPortal = { ...p, content: async () => '<html><body>Bem-vindo ao CDI</body></html>', existe: async () => false, coletar: async () => [] };
    expect(await adapterSynapse.reconhecer(semForm)).toEqual({ ok: false, motivo: 'portal_desconhecido' });
    const captcha: PaginaDoPortal = { ...p, content: async () => '<div class="g-recaptcha"></div>' + HTML_LOGIN };
    expect(await adapterSynapse.reconhecer(captcha)).toEqual({ ok: false, motivo: 'bloqueado_captcha' });
  });
});

describe('login e resultados no Synapse', () => {
  it('preenche protocolo, senha e data (ISO), submete uma vez e entra', async () => {
    const p = paginaFalsa();
    const r = await adapterSynapse.login(p, CREDS);
    expect(r).toEqual({ ok: true });
    expect(p.preenchido['input[type="date"]']).toBe('1990-03-15');
    expect(Object.values(p.preenchido)).toContain('segredo');
    expect(p.cliques.filter((c) => c.includes('submit')).length).toBe(1);
  });
  it('senha errada → credenciais_invalidas (uma tentativa só); sem data → não tenta', async () => {
    const p = paginaFalsa();
    expect(await adapterSynapse.login(p, { ...CREDS, senha: 'errada' })).toEqual({ ok: false, motivo: 'credenciais_invalidas' });
    expect(p.cliques.filter((c) => c.includes('submit')).length).toBe(1);
    const p2 = paginaFalsa();
    expect(await adapterSynapse.login(p2, { ...CREDS, nascimento: null })).toEqual({ ok: false, motivo: 'credenciais_invalidas' });
    expect(p2.cliques.filter((c) => c.includes('submit')).length).toBe(0);
  });
  it('lista o link do PDF e o botão "Laudo", e baixa os dois (GET e clique)', async () => {
    const p = paginaFalsa();
    await adapterSynapse.login(p, CREDS);
    const itens = await adapterSynapse.listarResultados(p);
    expect(itens.map((i) => i.rotulo)).toEqual(['Baixar PDF', 'Laudo']);
    const a = await adapterSynapse.baixar(p, itens[0]!);
    const b = await adapterSynapse.baixar(p, itens[1]!);
    expect(a?.toString().startsWith('%PDF')).toBe(true);
    expect(b?.toString()).toContain('por clique');
  });
});

describe('a promessa de entrar no site sem a ferramenta', () => {
  it('as duas frases reais do Ciro caem; com fetch_lab_results no turno, não são suspeitas', () => {
    const t1 = 'Estou entrando no site do CDI no dia 21/09 a partir das 17h30 pra buscar seu resultado, Ciro. Aviso assim que tiver novidade!';
    const t2 = 'Vou entrar no site do CDI com seu protocolo pra buscar o resultado. Já volto com novidades!';
    for (const t of [t1, t2]) {
      const v = verificarAnuncios(t, [], []);
      expect(v.suspect.map((s) => s.kind)).toContain('busca_no_portal');
      expect(semAnuncios(t, FAMILIAS_DE_PROMESSA_SEM_FERRAMENTA).removidas.length).toBeGreaterThan(0);
    }
    expect(verificarAnuncios(t1, [], ['fetch_lab_results']).suspect.filter((s) => s.kind === 'busca_no_portal')).toEqual([]);
    expect(falaHonestaPara('busca_no_portal')).toContain('depois que você autoriza');
  });
});
