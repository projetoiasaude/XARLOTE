/**
 * Adapter GENÉRICO — o único que existe hoje, e o que mais precisa saber quando desistir.
 *
 * Ele tenta o que 90% dos portais de laboratório fazem: um formulário com usuário e senha,
 * um clique, uma lista de resultados com links para PDF. E em CADA passo tem um critério de
 * confiança: se não achar exatamente um campo de senha, se não souber qual é o campo de
 * usuário, se depois do login ainda houver campo de senha na tela — devolve
 * `portal_desconhecido` em vez de chutar. Um chute aqui digita a senha da pessoa no campo
 * errado de um site que a gente não conhece.
 *
 * O que ele NÃO faz, por desenho (docs/PLANO_EXAMES_LAB.md §2): não tenta contornar CAPTCHA,
 * não passa por 2FA, não tenta o login uma segunda vez.
 */
import type { LabAdapter, PaginaDoPortal, CredenciaisLab, LoginResultado, ResultadoRemoto, ReconhecimentoDoPortal } from './types.js';
import { pareceCaptcha, parece2FA, pareceLoginFalhou, pareceLinkDeResultado, ehPdf, resolverHref } from './deteccao.js';

const NAV_TIMEOUT_MS = 20_000;

/** Seletores de campo de usuário, do mais específico ao mais genérico. */
const SELETORES_USUARIO = [
  'input[autocomplete="username"]',
  'input[type="email"]',
  'input[name*="user" i]',
  'input[name*="login" i]',
  'input[name*="usuario" i]',
  'input[name*="cpf" i]',
  'input[name*="protocolo" i]',
  'input[name*="atendimento" i]',
  'input[id*="user" i]',
  'input[id*="login" i]',
  'input[id*="usuario" i]',
  'input[id*="cpf" i]',
  'input[placeholder*="usu" i]',
  'input[placeholder*="cpf" i]',
  'input[placeholder*="login" i]',
  'input[placeholder*="protocolo" i]',
  'input[type="text"]',
];

const SELETOR_SENHA = 'input[type="password"]';

const SELETORES_SUBMIT = [
  'button[type="submit"]',
  'input[type="submit"]',
  'button:has-text("Entrar")',
  'button:has-text("Acessar")',
  'button:has-text("Login")',
  'button:has-text("Consultar")',
  'button:has-text("Ver resultado")',
];

async function primeiroQueExiste(page: PaginaDoPortal, seletores: readonly string[]): Promise<string | null> {
  for (const s of seletores) {
    if (await page.existe(s)) return s;
  }
  return null;
}

const SEL_NASCIMENTO = 'input[type="date"], input[name*="nascimento" i], input[id*="nascimento" i], input[placeholder*="nascimento" i]';
const SELETORES_COOKIES = ['button:has-text("Aceitar")', 'button:has-text("Aceito")', 'button:has-text("Concordo")', 'button:has-text("OK")', '#onetrust-accept-btn-handler'];

export const adapterGenerico: LabAdapter = {
  id: 'generico',
  nome: 'genérico',
  // É o último da lista: só é escolhido quando nenhum específico casa.
  casa: () => true,

  async preparar(page) {
    for (const s of SELETORES_COOKIES) {
      if (await page.existe(s)) { await page.click(s).catch(() => undefined); await page.esperar?.(400); break; }
    }
  },

  /** A mesma régua do login, sem digitar: exatamente um campo de senha e um de usuário. */
  async reconhecer(page): Promise<ReconhecimentoDoPortal> {
    const html = await page.content();
    if (pareceCaptcha(html)) return { ok: false, motivo: 'bloqueado_captcha' };
    const senhas = await page.coletar(SELETOR_SENHA, ['name', 'id']);
    if (senhas.length !== 1) return { ok: false, motivo: 'portal_desconhecido' };
    const campoUsuario = await primeiroQueExiste(page, SELETORES_USUARIO);
    if (!campoUsuario) return { ok: false, motivo: 'portal_desconhecido' };
    const pedeNascimento = await page.existe(SEL_NASCIMENTO);
    return { ok: true, campos: pedeNascimento ? ['login', 'senha', 'nascimento'] : ['login', 'senha'] };
  },

  async login(page, creds: CredenciaisLab): Promise<LoginResultado> {
    // 1. Antes de digitar QUALQUER coisa: a página já é um CAPTCHA?
    const htmlInicial = await page.content();
    if (pareceCaptcha(htmlInicial)) return { ok: false, motivo: 'bloqueado_captcha' };

    // 2. Exatamente um campo de senha visível. Zero = não é tela de login; dois = não sei
    //    qual é o de entrar e qual é o de "cadastre-se" — desisto nos dois casos.
    const senhas = await page.coletar(SELETOR_SENHA, ['name', 'id']);
    if (senhas.length !== 1) return { ok: false, motivo: 'portal_desconhecido' };

    const campoUsuario = await primeiroQueExiste(page, SELETORES_USUARIO);
    if (!campoUsuario) return { ok: false, motivo: 'portal_desconhecido' };

    // 3. Preenche. O protocolo, quando existe e há campo para ele, vai junto; senão o login
    //    é o que a pessoa mandou como login (em vários portais o protocolo É o usuário).
    await page.fill(campoUsuario, creds.login);
    await page.fill(SELETOR_SENHA, creds.senha);
    if (creds.protocolo) {
      const campoProtocolo = await primeiroQueExiste(page, [
        'input[name*="protocolo" i]', 'input[id*="protocolo" i]', 'input[placeholder*="protocolo" i]',
      ]);
      if (campoProtocolo && campoProtocolo !== campoUsuario) await page.fill(campoProtocolo, creds.protocolo);
    }
    // Data de nascimento, quando o portal tem o campo e a gente tem o dado (ISO pra `type=date`).
    if (creds.nascimento && await page.existe(SEL_NASCIMENTO)) {
      await page.fill(SEL_NASCIMENTO, creds.nascimento).catch(() => undefined);
    }

    // 4. Submete UMA vez.
    const submit = await primeiroQueExiste(page, SELETORES_SUBMIT);
    if (!submit) return { ok: false, motivo: 'portal_desconhecido' };
    const urlAntes = page.url();
    // A espera pela navegação é armada ANTES do clique (ver `clicarEEsperar`). Sem isso, o
    // `content()` abaixo lia a página velha e o `url()` a nova — e senha errada virava ok.
    if (page.clicarEEsperar) {
      await page.clicarEEsperar(submit, { timeout: NAV_TIMEOUT_MS });
    } else {
      await page.click(submit, { timeout: NAV_TIMEOUT_MS });
      await page.waitForLoadState?.('load', { timeout: NAV_TIMEOUT_MS }).catch(() => undefined);
    }

    // 5. O que apareceu depois? Cada checagem de princípio ANTES de concluir sucesso.
    const html = await page.content();
    if (pareceCaptcha(html)) return { ok: false, motivo: 'bloqueado_captcha' };
    if (parece2FA(html)) return { ok: false, motivo: 'bloqueado_2fa' };
    if (pareceLoginFalhou(html)) return { ok: false, motivo: 'credenciais_invalidas' };
    // Campo de senha AINDA visível depois do submit = não entrou — independente da URL.
    // Portal comum faz POST em /login e devolve o formulário de novo numa URL diferente da
    // inicial; exigir "mesma URL" aqui deixava senha errada virar "entrou" (o e2e pegou).
    // Sem mensagem de erro reconhecível, tratamos como credencial inválida: é o mais
    // provável, e é a resposta que faz a pessoa conferir o papel em vez de a gente insistir.
    void urlAntes;
    if (await page.existe(SELETOR_SENHA)) return { ok: false, motivo: 'credenciais_invalidas' };

    return { ok: true };
  },

  async listarResultados(page): Promise<ResultadoRemoto[]> {
    const base = page.url();
    const links = await page.coletar('a[href], button[data-href], a[download]', ['href', 'data-href', 'download', 'textContent', 'title', 'aria-label']);
    const vistos = new Set<string>();
    const out: ResultadoRemoto[] = [];
    for (const l of links) {
      const hrefCru = l['href'] ?? l['data-href'] ?? null;
      const texto = [l['textContent'], l['title'], l['aria-label']].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
      if (!pareceLinkDeResultado(texto, hrefCru)) continue;
      const href = resolverHref(hrefCru, base);
      if (!href || vistos.has(href)) continue;
      vistos.add(href);
      out.push({ rotulo: texto.slice(0, 120) || 'Resultado', href });
    }
    return out;
  },

  async baixar(page, item): Promise<Buffer | null> {
    if (!item.href) return null;
    const r = await page.baixar(item.href);
    // O header do arquivo manda; content-type de portal mente com frequência.
    return ehPdf(r.body) ? r.body : null;
  },
};
