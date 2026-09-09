/**
 * Buscar exames no portal do laboratório — as partes PURAS.
 *
 * O que está em jogo em cada bloco:
 *   • detecção: é o que impede a Xarlote de tentar contornar um CAPTCHA ou de pedir um
 *     código de SMS a um paciente. Falso negativo aqui é violação de princípio, não bug.
 *   • cofre: a senha do portal é a única senha de terceiro que a Xarlote toca. Se `cifrar`
 *     vazar texto puro ou `redigirCredenciais` deixar passar, ela vai parar no Postgres.
 *   • consentimento: a prova é a fala da pessoa. Um "sim" mal detectado abre um navegador
 *     com a senha dela sem ela ter dito que podia.
 */
import { describe, it, expect } from 'vitest';
import {
  pareceCaptcha, parece2FA, pareceLoginFalhou, pareceLinkDeResultado, ehPdf, resolverHref, mensagemDeParada,
  escolherAdapter, urlDeEntrada, adapterGenerico,
} from '../packages/integrations/src/lab-portals/index.js';
import { chaveDoCofre, cifrar, decifrar, redigirCredenciais, labFetchDisponivel, labFetchPronto } from '../apps/api/src/lib/lab-vault.js';
import { resolverChromium } from '../apps/api/src/handlers/lab-fetch.js';
import { autorizouBuscaNoPortal } from '../apps/api/src/handlers/tool-executor.js';

describe('detecção — na dúvida, é sim', () => {
  it('CAPTCHA: reCAPTCHA, hCaptcha, Turnstile e o texto "não sou um robô"', () => {
    expect(pareceCaptcha('<div class="g-recaptcha" data-sitekey="x"></div>')).toBe(true);
    expect(pareceCaptcha('<script src="https://js.hcaptcha.com/1/api.js"></script>')).toBe(true);
    expect(pareceCaptcha('<div class="cf-turnstile"></div>')).toBe(true);
    expect(pareceCaptcha('<label>Não sou um robô</label>')).toBe(true);
    expect(pareceCaptcha('<form><input type="password"></form>')).toBe(false);
  });

  it('2FA: código enviado, token, autenticação em duas etapas, campo one-time-code', () => {
    expect(parece2FA('Enviamos um código para o seu celular')).toBe(true);
    expect(parece2FA('Digite o código recebido por SMS')).toBe(true);
    expect(parece2FA('<input autocomplete="one-time-code">')).toBe(true);
    expect(parece2FA('Autenticação em dois fatores')).toBe(true);
    expect(parece2FA('<h1>Seus resultados</h1><a href="/laudo.pdf">Baixar</a>')).toBe(false);
  });

  it('login falhou: as frases que os portais usam', () => {
    expect(pareceLoginFalhou('Senha inválida')).toBe(true);
    expect(pareceLoginFalhou('Usuário não encontrado')).toBe(true);
    expect(pareceLoginFalhou('Credenciais inválidas')).toBe(true);
    expect(pareceLoginFalhou('Invalid credentials')).toBe(true);
    expect(pareceLoginFalhou('Bem-vindo, Glauber')).toBe(false);
  });

  it('link de resultado: destino .pdf ou texto de laudo com destino real', () => {
    expect(pareceLinkDeResultado('Baixar', '/laudos/123.pdf')).toBe(true);
    expect(pareceLinkDeResultado('Resultado', '/resultado/abc')).toBe(true);
    expect(pareceLinkDeResultado('Laudo hemograma', 'https://x.com/ver?id=1')).toBe(true);
    expect(pareceLinkDeResultado('Resultado', '#')).toBe(false);
    expect(pareceLinkDeResultado('Resultado', 'javascript:void(0)')).toBe(false);
    expect(pareceLinkDeResultado('Sair', '/logout')).toBe(false);
  });

  it('PDF de verdade é decidido pelo header, não pelo content-type', () => {
    expect(ehPdf(Buffer.from('%PDF-1.4 ...'))).toBe(true);
    expect(ehPdf(Buffer.from('<html>erro</html>'))).toBe(false);
    expect(ehPdf(null)).toBe(false);
  });

  it('href relativo resolve contra a URL da página', () => {
    expect(resolverHref('/laudo.pdf', 'https://lab.com/area/')).toBe('https://lab.com/laudo.pdf');
    expect(resolverHref('laudo.pdf', 'https://lab.com/area/')).toBe('https://lab.com/area/laudo.pdf');
    // `::inválido` é caminho relativo VÁLIDO ("/::inv%C3%A1lido") — o que não resolve é
    // esquema sem host, ou base que não é URL.
    expect(resolverHref('http://', 'https://lab.com')).toBeNull();
    expect(resolverHref('/laudo.pdf', 'isso não é url')).toBeNull();
    expect(resolverHref(null, 'https://lab.com')).toBeNull();
  });

  it('toda parada termina oferecendo o PDF — menos "sem resultados", que oferece tentar amanhã', () => {
    const motivos = ['bloqueado_captcha', 'bloqueado_2fa', 'credenciais_invalidas', 'portal_desconhecido', 'download_falhou', 'timeout', 'erro_interno'] as const;
    for (const m of motivos) expect(mensagemDeParada(m, 'Lab X')).toMatch(/PDF/);
    expect(mensagemDeParada('sem_resultados', 'Lab X')).toMatch(/amanhã/);
    // As paradas de princípio dizem que NÃO fazem, em vez de "não consegui".
    expect(mensagemDeParada('bloqueado_captcha', null)).toMatch(/isso eu não faço/);
    expect(mensagemDeParada('bloqueado_2fa', null)).toMatch(/não é seguro/i);
  });
});

describe('registry', () => {
  it('sem adapter específico, cai no genérico', () => {
    expect(escolherAdapter({ nome: 'Laboratório Qualquer' }).id).toBe('generico');
  });
  it('url de entrada: aceita https, completa host nu, recusa lixo', () => {
    expect(urlDeEntrada({ url: 'https://lab.com/res' }, adapterGenerico)).toBe('https://lab.com/res');
    expect(urlDeEntrada({ url: 'resultados.lab.com.br' }, adapterGenerico)).toBe('https://resultados.lab.com.br');
    expect(urlDeEntrada({ url: 'ver no site' }, adapterGenerico)).toBeNull();
    expect(urlDeEntrada({}, adapterGenerico)).toBeNull();
  });
});

describe('cofre', () => {
  const HEX = 'a'.repeat(64);
  const chave = chaveDoCofre({ LAB_VAULT_KEY: HEX } as NodeJS.ProcessEnv)!;

  it('chave precisa ter exatamente 32 bytes em hex', () => {
    expect(chaveDoCofre({ LAB_VAULT_KEY: HEX } as NodeJS.ProcessEnv)).not.toBeNull();
    expect(chaveDoCofre({ LAB_VAULT_KEY: 'curta' } as NodeJS.ProcessEnv)).toBeNull();
    expect(chaveDoCofre({} as NodeJS.ProcessEnv)).toBeNull();
  });

  it('a feature só existe com flag E chave', () => {
    expect(labFetchDisponivel({ LAB_FETCH_ENABLED: 'true', LAB_VAULT_KEY: HEX } as NodeJS.ProcessEnv)).toBe(true);
    expect(labFetchDisponivel({ LAB_FETCH_ENABLED: 'true' } as NodeJS.ProcessEnv)).toBe(false);
    expect(labFetchDisponivel({ LAB_VAULT_KEY: HEX } as NodeJS.ProcessEnv)).toBe(false);
  });

  it('cifra e decifra; o envelope não contém o texto', () => {
    const env = cifrar('{"login":"P137956","senha":"WtQv"}', chave);
    expect(env).not.toContain('WtQv');
    expect(env).not.toContain('P137956');
    expect(decifrar(env, chave)).toBe('{"login":"P137956","senha":"WtQv"}');
  });

  it('IV aleatório: o mesmo texto cifra diferente a cada vez', () => {
    expect(cifrar('x', chave)).not.toBe(cifrar('x', chave));
  });

  it('adulteração ou chave errada devolve null, nunca lixo', () => {
    const env = cifrar('segredo', chave);
    const outra = chaveDoCofre({ LAB_VAULT_KEY: 'b'.repeat(64) } as NodeJS.ProcessEnv)!;
    expect(decifrar(env, outra)).toBeNull();
    expect(decifrar(env.slice(0, -2) + 'zz', chave)).toBeNull();
    expect(decifrar('nao.e.envelope', chave)).toBeNull();
    expect(decifrar('', chave)).toBeNull();
  });

  it('redige senha, login e protocolo — e não muta a entrada', () => {
    const args = { laboratorio: 'Lab', login: 'P137956', senha: 'WtQv', protocolo: '99', nested: { password: 'x' } };
    const r = redigirCredenciais(args);
    expect(r.senha).toBe('[redigido]');
    expect(r.login).toBe('[redigido]');
    expect(r.protocolo).toBe('[redigido]');
    expect(r.nested.password).toBe('[redigido]');
    expect(r.laboratorio).toBe('Lab');
    expect(args.senha).toBe('WtQv');
  });
});

describe('consentimento — a prova é a fala da pessoa', () => {
  it('sim inequívoco', () => {
    for (const s of ['sim', 'Sim!', 'pode', 'pode sim', 'autorizo', 'ok', 'claro', 'vai lá', 'pode entrar']) {
      expect(autorizouBuscaNoPortal(s)).toBe(true);
    }
  });
  it('negação em qualquer lugar vence', () => {
    for (const s of ['não', 'nao', 'sim, mas não agora', 'pode deixar', 'depois', 'agora não', 'espera']) {
      expect(autorizouBuscaNoPortal(s)).toBe(false);
    }
  });
  it('mensagem que não é resposta não conta', () => {
    for (const s of ['', '   ', 'meu remédio acabou', 'qual o preço?', 'oi']) {
      expect(autorizouBuscaNoPortal(s)).toBe(false);
    }
  });
});

describe('prontidão provada — a tool só existe quando um worker abriu navegador', () => {
  const HEX = 'c'.repeat(64);
  const envOk = { LAB_FETCH_ENABLED: 'true', LAB_VAULT_KEY: HEX } as NodeJS.ProcessEnv;
  const redisCom = { get: async () => '12345' };
  const redisSem = { get: async () => null };
  const redisFora = { get: async () => { throw new Error('ECONNREFUSED'); } };

  it('config OK + chave no Redis → pronta', async () => {
    expect(await labFetchPronto(redisCom, envOk)).toBe(true);
  });
  it('config OK mas nenhum worker provou → NÃO pronta (o modelo não vê a tool)', async () => {
    expect(await labFetchPronto(redisSem, envOk)).toBe(false);
  });
  it('Redis fora → falha FECHADA', async () => {
    expect(await labFetchPronto(redisFora, envOk)).toBe(false);
  });
  it('flag desligada → nem consulta o Redis', async () => {
    let consultou = false;
    const espiao = { get: async () => { consultou = true; return '1'; } };
    expect(await labFetchPronto(espiao, { LAB_VAULT_KEY: HEX } as NodeJS.ProcessEnv)).toBe(false);
    expect(consultou).toBe(false);
  });
});

describe('resolverChromium — a env explícita vence o PATH', () => {
  it('usa PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH quando definido', () => {
    expect(resolverChromium({ PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH: '/nix/store/x/bin/chromium' } as NodeJS.ProcessEnv))
      .toBe('/nix/store/x/bin/chromium');
  });
  it('env vazia não é caminho', () => {
    const r = resolverChromium({ PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH: '   ' } as NodeJS.ProcessEnv);
    // Sem env, cai no PATH (pode ou não existir nesta máquina) e por fim em undefined —
    // nunca uma string em branco, que faria o Playwright tentar executar "".
    expect(r === undefined || (typeof r === 'string' && r.length > 0)).toBe(true);
  });
});
