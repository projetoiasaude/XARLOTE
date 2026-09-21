/**
 * Portais de laboratório — os tipos que todo adapter fala.
 *
 * Um adapter sabe entrar em UM portal (ou numa família de portais) e baixar os PDFs de
 * resultado. Ele NÃO decide nada sobre a pessoa, sobre consentimento nem sobre o que fazer
 * com o PDF — isso é do orquestrador em `apps/api/src/handlers/lab-fetch.ts`.
 *
 * O contrato mais importante aqui é `MotivoParada`: cada jeito de NÃO conseguir tem um nome,
 * e cada nome vira uma frase honesta para a pessoa. Nunca "erro genérico".
 * Desenho completo: docs/PLANO_EXAMES_LAB.md.
 */

/** O que a pessoa mandou (lido da foto do protocolo). Vive só o tempo do job. */
export interface CredenciaisLab {
  login: string;
  senha: string;
  /** Número do protocolo/atendimento, quando o portal pede além do login. */
  protocolo?: string | null;
  /** Data de nascimento (ISO aaaa-mm-dd) — o Synapse (CDI) pede junto com protocolo e senha. */
  nascimento?: string | null;
  /** CPF só-dígitos, quando o portal pede. */
  cpf?: string | null;
}

/** Os campos que um portal pode exigir na tela de entrada. */
export type CampoDoPortal = 'login' | 'senha' | 'protocolo' | 'nascimento' | 'cpf';

/**
 * RECONHECIMENTO: o adapter olha a página SEM digitar nada e diz se sabe entrar nela e o
 * que ela pede. É a prova que precede a promessa ("dia 21 eu entro lá") — caso Ciro, 16/09.
 */
export type ReconhecimentoDoPortal =
  | { ok: true; campos: CampoDoPortal[] }
  | { ok: false; motivo: Extract<MotivoParada, 'bloqueado_captcha' | 'portal_desconhecido' | 'timeout' | 'erro_interno'> };

/** Como o adapter foi escolhido — a URL impressa no protocolo ou o nome do laboratório. */
export interface AlvoDoPortal {
  url?: string | null;
  nome?: string | null;
}

/**
 * Por que parou. Todos os valores têm mensagem própria em `mensagemDeParada`.
 *
 * `bloqueado_captcha` e `bloqueado_2fa` são PARADAS DE PRINCÍPIO, não falhas: o portal
 * disse "não quero robô" ou "quero um código do celular da pessoa", e a resposta certa é
 * parar e contar. Não existe retry para eles, nem existirá.
 */
export type MotivoParada =
  | 'bloqueado_captcha'
  | 'bloqueado_2fa'
  | 'credenciais_invalidas'
  | 'portal_desconhecido'
  | 'faltou_dado'
  | 'sem_resultados'
  | 'download_falhou'
  | 'timeout'
  | 'erro_interno';

export type LoginResultado =
  | { ok: true }
  | { ok: false; motivo: Extract<MotivoParada, 'bloqueado_captcha' | 'bloqueado_2fa' | 'credenciais_invalidas' | 'portal_desconhecido'> };

/** Um resultado listado no portal, antes do download. */
export interface ResultadoRemoto {
  /** Rótulo como aparece no portal ("Hemograma completo", "Laudo 12/08"). */
  rotulo: string;
  /** URL absoluta do PDF, ou `null` quando o download é por clique (o adapter resolve). */
  href: string | null;
  /** Seletor do botão que dispara o download, quando não há href (SPA). */
  seletor?: string | null;
  /** Data impressa ao lado, se houver — string crua; quem interpreta é o orquestrador. */
  dataTexto?: string | null;
}

export interface PdfBaixado {
  rotulo: string;
  buffer: Buffer;
}

/**
 * A superfície mínima do navegador que os adapters usam. É um subconjunto do `Page` do
 * Playwright, declarado aqui para o pacote `integrations` NÃO depender do Playwright em
 * tempo de tipo — quem instancia o navegador é o worker da API.
 */
export interface PaginaDoPortal {
  goto(url: string, opts?: { timeout?: number }): Promise<unknown>;
  url(): string;
  content(): Promise<string>;
  fill(selector: string, value: string): Promise<void>;
  click(selector: string, opts?: { timeout?: number }): Promise<void>;
  waitForLoadState?(state?: 'load' | 'domcontentloaded' | 'networkidle', opts?: { timeout?: number }): Promise<void>;
  /**
   * Clica E espera a navegação que o clique dispara terminar. `click` sozinho NÃO espera —
   * o adapter lia a página velha, e quando conferia a URL ela já tinha mudado: senha errada
   * virava "entrou". Quem implementa arma a espera pelo `load` ANTES do clique.
   */
  clicarEEsperar?(selector: string, opts?: { timeout?: number }): Promise<void>;
  /** Faz um GET autenticado (cookies da sessão) e devolve os bytes. */
  baixar(url: string): Promise<{ contentType: string; body: Buffer }>;
  /** `$$eval` simplificado: devolve os atributos de todos os elementos que casam. */
  coletar(selector: string, attrs: readonly string[]): Promise<Array<Record<string, string | null>>>;
  /** Existe pelo menos um elemento visível que casa? */
  existe(selector: string): Promise<boolean>;
  /** Clica e captura o arquivo que o clique baixa (SPA sem href). `null` se nada veio. */
  clicarEBaixar?(selector: string, opts?: { timeout?: number }): Promise<{ contentType: string; body: Buffer } | null>;
  /** Espera um pouco (renderização de SPA). */
  esperar?(ms: number): Promise<void>;
}

export interface LabAdapter {
  id: string;
  /** Como o laboratório se chama no papel — usado para casar com o que a visão leu. */
  nome: string;
  /** Este adapter atende este alvo? (pela URL/nome, antes de abrir a página) */
  casa(alvo: AlvoDoPortal): boolean;
  /** Este adapter reconhece a PÁGINA aberta? (o Synapse do CDI se apresenta no título) */
  detecta?(html: string): boolean;
  /** Campos que este portal exige, quando o adapter os conhece de antemão. */
  camposObrigatorios?: CampoDoPortal[];
  /** URL de entrada quando o protocolo não traz uma. */
  urlPadrao?: string;
  /** Aceita cookies / fecha o que cobre o formulário. Sem digitar nada. */
  preparar?(page: PaginaDoPortal): Promise<void>;
  /** Olha a tela de entrada sem digitar: dá pra entrar aqui? o que ela pede? */
  reconhecer(page: PaginaDoPortal): Promise<ReconhecimentoDoPortal>;
  login(page: PaginaDoPortal, creds: CredenciaisLab): Promise<LoginResultado>;
  listarResultados(page: PaginaDoPortal): Promise<ResultadoRemoto[]>;
  baixar(page: PaginaDoPortal, item: ResultadoRemoto): Promise<Buffer | null>;
}

export type DesfechoDaBusca =
  | { ok: true; pdfs: PdfBaixado[]; adapter: string }
  | { ok: false; motivo: MotivoParada; adapter: string | null; detalhe?: string };
