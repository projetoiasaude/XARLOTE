/**
 * Detecção PURA sobre o HTML da página — sem navegador, sem I/O. É o que faz as travas de
 * princípio (CAPTCHA, 2FA) serem testáveis sem abrir um Chromium.
 *
 * A regra de todas as funções aqui: **na dúvida, é sim.** Um falso positivo custa uma
 * mensagem "não consegui, me manda o PDF". Um falso negativo custa tentar contornar uma
 * verificação humana, ou pedir um código de SMS a um paciente — e isso a Xarlote não faz.
 */

const RE_CAPTCHA = [
  /recaptcha/i,
  /hcaptcha/i,
  /cf-turnstile|challenges\.cloudflare\.com/i,
  /g-recaptcha/i,
  /data-sitekey=/i,
  /\bcaptcha\b/i,
  /não sou um rob[oô]|nao sou um robo|i'm not a robot/i,
  /verifica[çc][ãa]o de seguran[çc]a/i,
];

/**
 * 2FA: o portal pediu um código depois do login. O sinal é um campo de código curto OU o
 * texto falando em código/token enviado por SMS/e-mail/app.
 */
const RE_2FA = [
  /c[óo]digo (de )?(verifica[çc][ãa]o|seguran[çc]a|acesso) (enviado|foi enviado|mandado)/i,
  /enviamos (um )?c[óo]digo/i,
  /token (de )?(seguran[çc]a|acesso)/i,
  /autentica[çc][ãa]o (em|de) (dois|2) (fatores|etapas)/i,
  /two[- ]factor|2fa\b|one[- ]time (code|password)|\botp\b/i,
  /digite o c[óo]digo (recebido|que enviamos)/i,
  /autocomplete="one-time-code"/i,
  /inputmode="numeric"[^>]*maxlength="[4-8]"/i,
];

/**
 * Login falhou: mensagem de erro típica, ou continua na tela de login. A segunda parte
 * (campo de senha ainda visível) é decidida pelo adapter, que sabe olhar a página; aqui só
 * o texto.
 */
const RE_LOGIN_FALHOU = [
  /senha (inv[áa]lida|incorreta|errada)/i,
  /usu[áa]rio (inv[áa]lido|incorreto|n[ãa]o encontrado|inexistente)/i,
  /login (inv[áa]lido|incorreto)/i,
  /credenciais? inv[áa]lidas?/i,
  /dados (inv[áa]lidos|incorretos)/i,
  /acesso negado/i,
  /invalid (username|password|credentials|login)/i,
  /n[ãa]o foi poss[íi]vel (autenticar|efetuar (o )?login)/i,
];

function casaAlgum(html: string, res: readonly RegExp[]): boolean {
  return res.some((r) => r.test(html));
}

export function pareceCaptcha(html: string): boolean {
  return casaAlgum(html, RE_CAPTCHA);
}

export function parece2FA(html: string): boolean {
  return casaAlgum(html, RE_2FA);
}

export function pareceLoginFalhou(html: string): boolean {
  return casaAlgum(html, RE_LOGIN_FALHOU);
}

/**
 * Um link/botão é candidato a resultado de exame? Olha o texto e o destino. Deliberadamente
 * generoso no texto e estrito no destino: "Resultado" pode levar a uma página HTML, e aí o
 * download decide (só `application/pdf` passa).
 */
const RE_RESULTADO_TEXTO = /resultado|laudo|exame|relat[óo]rio|pdf|baixar|download|visualizar|imprimir/i;
const RE_RESULTADO_HREF = /\.pdf(\?|$)|\/(resultado|laudo|exame|download|pdf)s?\b/i;

export function pareceLinkDeResultado(texto: string | null | undefined, href: string | null | undefined): boolean {
  const t = (texto ?? '').trim();
  const h = (href ?? '').trim();
  if (!t && !h) return false;
  if (RE_RESULTADO_HREF.test(h)) return true;
  return RE_RESULTADO_TEXTO.test(t) && h.length > 0 && !/^(#|javascript:|mailto:|tel:)/i.test(h);
}

/** É PDF de verdade? Confia no header do arquivo, não no content-type, que portal mente. */
export function ehPdf(bytes: Buffer | null | undefined): boolean {
  return !!bytes && bytes.length > 5 && bytes.toString('latin1', 0, 5) === '%PDF-';
}

/** Resolve um href relativo contra a URL atual. Devolve null se não der. */
export function resolverHref(href: string | null | undefined, base: string): string | null {
  if (!href) return null;
  try {
    return new URL(href, base).toString();
  } catch {
    return null;
  }
}

/**
 * A frase que a pessoa lê para cada motivo. Toda parada termina no caminho que já
 * funciona: mandar o PDF. Sem exceção — é o que impede a parada de virar beco.
 */
export function mensagemDeParada(motivo: import('./types.js').MotivoParada, laboratorio: string | null): string {
  const lab = laboratorio?.trim() ? ` do ${laboratorio.trim()}` : ' do laboratório';
  const fallback = ' Se você conseguir baixar o PDF, me manda aqui que eu leio e guardo na hora 💙';
  switch (motivo) {
    case 'bloqueado_captcha':
      return `Tentei entrar no site${lab}, mas ele pede uma verificação humana (aquele "não sou um robô") — e isso eu não faço.${fallback}`;
    case 'bloqueado_2fa':
      return `Entrei no site${lab}, mas ele pede um código enviado pro seu celular. Não é seguro você repassar esse código pra mim, então parei por aqui.${fallback}`;
    case 'credenciais_invalidas':
      return `O site${lab} não aceitou esse login. Confere no papel se o usuário e a senha estão certinhos? Não vou tentar de novo por conta própria pra não bloquear seu acesso.${fallback}`;
    case 'portal_desconhecido':
      return `Ainda não conheço o site${lab} bem o suficiente pra navegar nele sozinha.${fallback}`;
    case 'sem_resultados':
      return `Consegui entrar no site${lab}, mas ainda não tem nenhum resultado liberado. Quer que eu tente de novo amanhã?`;
    case 'download_falhou':
      return `Achei o resultado no site${lab}, mas não consegui baixar o arquivo.${fallback}`;
    case 'timeout':
      return `O site${lab} demorou demais pra responder e eu desisti pra não te deixar esperando.${fallback}`;
    case 'erro_interno':
    default:
      return `Deu um problema do meu lado ao buscar no site${lab}.${fallback}`;
  }
}
