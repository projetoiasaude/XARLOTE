/**
 * Adapter SYNAPSE EIS/RIS (Fujifilm) — o portal de resultados do CDI Goiânia
 * (`novo.cdig.com.br/resultado/`) e de outras clínicas de imagem que usam o mesmo sistema.
 *
 * Escrito OLHANDO o portal real em 21/09/2026 (caso Ciro): SPA em Nuxt, título
 * "Synapse EIS/RIS - Enterprise Imaging", banner de cookies ("Aceitar"/"Rejeitar" — os
 * cookies são de autenticação, então aceita), e um formulário com três campos:
 *   · Protocolo  → `input[placeholder="Digite seu login"]`
 *   · Senha      → `input[type="password"]` (placeholder "Digite sua senha")
 *   · Data de Nascimento → `input[type="date"]`
 * e o botão "Entrar" (`button[type="submit"]`). Sem CAPTCHA na entrada.
 *
 * O que vem DEPOIS do login ninguém viu ainda (precisa de um protocolo real): a listagem
 * usa a mesma heurística do genérico (links/botões com "laudo/resultado/pdf") e, sendo SPA,
 * tenta o download por clique. Se não achar nada, para em `sem_resultados`/`download_falhou`
 * com a frase honesta — nunca inventa.
 */
import type { LabAdapter, PaginaDoPortal, CredenciaisLab, LoginResultado, ResultadoRemoto, ReconhecimentoDoPortal } from './types.js';
import { pareceCaptcha, parece2FA, pareceLoginFalhou, pareceLinkDeResultado, ehPdf, resolverHref } from './deteccao.js';

const SEL_LOGIN = 'input[placeholder="Digite seu login"], input[placeholder*="login" i], input[placeholder*="protocolo" i]';
const SEL_SENHA = 'input[type="password"]';
const SEL_NASCIMENTO = 'input[type="date"]';
const SEL_SUBMIT = 'form button[type="submit"], button[type="submit"]';
const SEL_ACEITAR_COOKIES = 'button:has-text("Aceitar")';
const HOSTS_CONHECIDOS = [/(^|\.)cdig\.com\.br$/i];

function hostDe(url: string | null | undefined): string {
  try { return new URL(/^https?:\/\//i.test(url ?? '') ? (url as string) : `https://${url}`).hostname; } catch { return ''; }
}

export const adapterSynapse: LabAdapter = {
  id: 'synapse-eis',
  nome: 'Synapse EIS/RIS (CDI Goiânia)',
  urlPadrao: 'https://novo.cdig.com.br/resultado/',
  camposObrigatorios: ['login', 'senha', 'nascimento'],

  casa(alvo) {
    const host = hostDe(alvo.url);
    if (host && HOSTS_CONHECIDOS.some((re) => re.test(host))) return true;
    // Nome sem URL: só "CDI" cru é ambíguo demais (há CDIs em várias cidades). Só casa com
    // a grafia do papel do CDI Goiânia.
    return /\bcdi\s*g\b|cdi\s*goi[aâ]nia|cdig/i.test(alvo.nome ?? '');
  },

  detecta(html) {
    return /Synapse EIS\/RIS/i.test(html) || /Digite seu login/.test(html);
  },

  async preparar(page) {
    if (await page.existe(SEL_ACEITAR_COOKIES)) {
      await page.click(SEL_ACEITAR_COOKIES).catch(() => undefined);
      await page.esperar?.(500);
    }
  },

  async reconhecer(page): Promise<ReconhecimentoDoPortal> {
    const html = await page.content();
    if (pareceCaptcha(html)) return { ok: false, motivo: 'bloqueado_captcha' };
    const temLogin = await page.existe(SEL_LOGIN);
    const senhas = await page.coletar(SEL_SENHA, ['name', 'id']);
    if (!temLogin || senhas.length !== 1) return { ok: false, motivo: 'portal_desconhecido' };
    const pedeNascimento = await page.existe(SEL_NASCIMENTO);
    return { ok: true, campos: pedeNascimento ? ['login', 'senha', 'nascimento'] : ['login', 'senha'] };
  },

  async login(page, creds: CredenciaisLab): Promise<LoginResultado> {
    const rec = await this.reconhecer(page);
    if (!rec.ok) return { ok: false, motivo: rec.motivo === 'bloqueado_captcha' ? 'bloqueado_captcha' : 'portal_desconhecido' };
    await page.fill(SEL_LOGIN, creds.protocolo?.trim() || creds.login);
    await page.fill(SEL_SENHA, creds.senha);
    if (rec.campos.includes('nascimento')) {
      // Sem a data o portal recusa; o orquestrador já garantiu que ela existe (faltou_dado antes).
      if (!creds.nascimento) return { ok: false, motivo: 'credenciais_invalidas' };
      await page.fill(SEL_NASCIMENTO, creds.nascimento);
    }
    if (page.clicarEEsperar) await page.clicarEEsperar(SEL_SUBMIT, { timeout: 15_000 });
    else await page.click(SEL_SUBMIT, { timeout: 15_000 });
    // SPA: a resposta do login chega por XHR; dá um tempo pra tela trocar (ou pra o erro aparecer).
    await page.esperar?.(2_500);
    await page.waitForLoadState?.('networkidle', { timeout: 8_000 }).catch(() => undefined);

    const html = await page.content();
    if (pareceCaptcha(html)) return { ok: false, motivo: 'bloqueado_captcha' };
    if (parece2FA(html)) return { ok: false, motivo: 'bloqueado_2fa' };
    if (pareceLoginFalhou(html) || /protocolo.{0,40}(inv[áa]lido|n[ãa]o encontrado|incorret)|dados (inv[áa]lidos|incorretos)|n[ãa]o foi poss[íi]vel/i.test(html)) {
      return { ok: false, motivo: 'credenciais_invalidas' };
    }
    if (await page.existe(SEL_SENHA)) return { ok: false, motivo: 'credenciais_invalidas' };
    return { ok: true };
  },

  async listarResultados(page): Promise<ResultadoRemoto[]> {
    await page.esperar?.(1_500);
    const base = page.url();
    const out: ResultadoRemoto[] = [];
    const vistos = new Set<string>();
    const links = await page.coletar('a[href]', ['href', 'textContent', 'title', 'aria-label']);
    for (const l of links) {
      const texto = [l['textContent'], l['title'], l['aria-label']].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
      if (!pareceLinkDeResultado(texto, l['href'])) continue;
      const href = resolverHref(l['href'], base);
      if (!href || vistos.has(href)) continue;
      vistos.add(href);
      out.push({ rotulo: texto.slice(0, 120) || 'Resultado', href });
    }
    // Botões sem href (download por clique): laudo / resultado / pdf / baixar.
    const botoes = await page.coletar('button, [role="button"]', ['textContent', 'title', 'aria-label', 'id', 'data-testid']);
    botoes.forEach((b, i) => {
      const texto = [b['textContent'], b['title'], b['aria-label']].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
      if (!/\b(laudo|resultado|pdf|baixar|download|visualizar)\b/i.test(texto)) return;
      const seletor = b['id'] ? `#${CSS_escape(b['id'])}` : b['data-testid'] ? `[data-testid="${b['data-testid']}"]` : `button:has-text("${texto.replace(/"/g, '').slice(0, 40)}") >> nth=${i}`;
      out.push({ rotulo: texto.slice(0, 120) || 'Resultado', href: null, seletor });
    });
    return out;
  },

  async baixar(page, item): Promise<Buffer | null> {
    if (item.href) {
      const r = await page.baixar(item.href);
      return ehPdf(r.body) ? r.body : null;
    }
    if (item.seletor && page.clicarEBaixar) {
      const r = await page.clicarEBaixar(item.seletor, { timeout: 15_000 });
      return r && ehPdf(r.body) ? r.body : null;
    }
    return null;
  },
};

/** `CSS.escape` não existe no Node; o suficiente pra ids simples. */
function CSS_escape(s: string): string {
  return s.replace(/([^a-zA-Z0-9_-])/g, '\\$1');
}
