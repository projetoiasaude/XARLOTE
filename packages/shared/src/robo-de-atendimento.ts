/**
 * ROBÔ DE MENU DO OUTRO LADO (caso Duda, 10/09/2026 — GastroEla).
 *
 * A clínica atendia por robô: saudou, pediu "nome completo" 8 vezes, mostrou um menu numerado
 * e repetiu "informe apenas o número da opção" 4 vezes. A Xarlote respondeu cortesia a cada
 * eco ("deixa eu confirmar rapidinho"), mandou 6 paráfrases da mesma pergunta à paciente,
 * vazou narração interna ("vou precisar perguntar ao paciente") pro robô e, quando acertou
 * ("3" = Agendamento de consultas), a nossa auto-verificação de saída bloqueou por "texto
 * curto demais". 25 mensagens em um minuto, limite de turnos, cotação morta.
 *
 * Robô não conversa: ele espera EXATAMENTE o que pediu. Este módulo reconhece o robô e
 * decide, sem modelo de linguagem, o que responder: o número da opção de agendamento, o
 * dado do perfil se já o temos, ou UMA pergunta ao paciente — e silêncio pra saudação
 * automática. Também reconhece o loop (mesmo prompt repetido) pra parar antes de queimar
 * o limite de turnos, e a narração interna que nunca deveria sair pra ninguém.
 *
 * PURO: sem I/O, sem relógio.
 */

import { foldPt } from './br-datetime.js';

export type DadoPedido = 'nome_completo' | 'nascimento' | 'cpf' | 'telefone' | 'convenio' | 'carteirinha' | 'endereco' | 'email';
export type TipoDeRobo = 'saudacao_automatica' | 'menu' | 'pede_numero' | 'pede_dado' | 'opcao_invalida';

export interface OpcaoDeMenu { numero: string; rotulo: string }

export interface AnaliseDeRobo {
  robo: boolean;
  tipo: TipoDeRobo | null;
  opcoes: OpcaoDeMenu[];
  dadoPedido: DadoPedido | null;
}

const SAUDACAO_AUTOMATICA = /\b(bem[- ]?vind[oa]s?\s*(\(a\))?\s+ao\s+(atendimento|canal|whatsapp)|atendimento\s+(automatico|virtual|digital)|assistente\s+virtual|resposta\s+automatica|central\s+de\s+atendimento)\b/;
const PEDE_NUMERO = /\b(informe|digite|responda|envie|escolha|selecione)\b[^.!?\n]{0,25}\b(apenas\s+)?(o\s+)?(numero|opcao|n[º°o]\s*da\s+opcao)\b|\bopcao\s+(desejada|invalida|nao\s+reconhecida)\b|\bdigite\s+\d|\bresponda\s+com\s+o\s+numero\b|\bpara\s+voltar\s+ao\s+menu\b/;
const OPCAO_INVALIDA = /\bopcao\s+(invalida|nao\s+(reconhecida|encontrada))\b|\bnao\s+entendi\s+(sua\s+)?(opcao|resposta)\b/;
/** Pedido FORMULAICO de dado (o robô fala "informe o seu X"). "Envie a foto da carteirinha" NÃO é
 *  isso — é exigência de DOCUMENTO (caso Glauber), tratada pelo agente/preconditions. */
const PEDE_DADO = /\b(informe|digite|nos\s+informe|me\s+informe|informar)\b[^.!?\n]{0,20}\b(o\s+|a\s+|seu\s+|sua\s+|o\s+seu\s+|a\s+sua\s+)?(nome\s+completo|data\s+de\s+nascimento|cpf|telefone|celular|convenio|plano|numero\s+da\s+carteir\w*|carteirinha|endereco|e-?mail)\b/;
const FALA_DE_DOCUMENTO = /\b(foto|copia|imagem|documento|pdf|pedido\s+medico|encaminhamento|guia)\b/;

const DADOS: Array<[DadoPedido, RegExp]> = [
  ['nome_completo', /\bnome\s+completo\b/],
  ['nascimento', /\b(data\s+de\s+)?nascimento\b|\bnasceu\b/],
  ['cpf', /\bcpf\b/],
  ['carteirinha', /\bcarteir\w*\b|\bnumero\s+d[oa]\s+(plano|convenio)\b/],
  ['convenio', /\bconvenio\b|\bplano\s+de\s+saude\b|\bplano\b/],
  ['telefone', /\btelefone\b|\bcelular\b|\bwhatsapp\b/],
  ['endereco', /\bendereco\b|\bcep\b/],
  ['email', /\be-?mail\b/],
];

/** Opções numeradas ("1.", "1-", "*1.2*-", "3)") com rótulo. */
export function extrairOpcoes(texto: string): OpcaoDeMenu[] {
  const out: OpcaoDeMenu[] = [];
  const re = /(?:^|\n|\s)\*?(\d{1,2}(?:\.\d{1,2})?)\*?\s*[-–—).:]\s*\*?([^\n*]{2,80})/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(texto)) !== null) {
    const numero = m[1] as string;
    const rotulo = (m[2] as string).replace(/\s+/g, ' ').trim();
    if (rotulo && !out.some((o) => o.numero === numero)) out.push({ numero, rotulo });
  }
  return out;
}

export function analisarMensagemDeRobo(texto: string | null | undefined): AnaliseDeRobo {
  const raw = (texto ?? '').trim();
  const vazio: AnaliseDeRobo = { robo: false, tipo: null, opcoes: [], dadoPedido: null };
  if (!raw) return vazio;
  const f = foldPt(raw);
  const opcoes = extrairOpcoes(raw);
  const convite = /\b(digite|escolha|selecione|informe|responda)\b[^.!?\n]{0,30}\b(numero|opcao)\b|\bem\s+que\s+(eu\s+)?posso\s+(te\s+)?ajudar\b|\bcomo\s+posso\s+ajudar\b/.test(f);

  if (OPCAO_INVALIDA.test(f)) return { robo: true, tipo: 'opcao_invalida', opcoes, dadoPedido: null };
  if (opcoes.length >= 2 && convite) return { robo: true, tipo: 'menu', opcoes, dadoPedido: null };
  if (PEDE_DADO.test(f) && !FALA_DE_DOCUMENTO.test(f) && raw.length <= 200) {
    const dado = DADOS.find(([, re]) => re.test(f))?.[0] ?? null;
    return { robo: true, tipo: 'pede_dado', opcoes: [], dadoPedido: dado };
  }
  if (PEDE_NUMERO.test(f)) return { robo: true, tipo: 'pede_numero', opcoes, dadoPedido: null };
  if (SAUDACAO_AUTOMATICA.test(f) && raw.length < 220) return { robo: true, tipo: 'saudacao_automatica', opcoes: [], dadoPedido: null };
  return vazio;
}

/**
 * Qual opção leva a MARCAR CONSULTA? Prefere "agendamento de consulta(s)"/"marcar consulta";
 * aceita "consulta" solta; evita exame/retorno/resultado/preparo/cancelamento/financeiro.
 * Sem opção de consulta, "falar com atendente" é o caminho humano. Senão null (desiste).
 */
export function escolherOpcaoDeAgendamento(opcoes: OpcaoDeMenu[]): string | null {
  const score = (rotulo: string): number => {
    const r = foldPt(rotulo);
    if (/\b(cancel\w*|resultado|preparo|localiza\w*|horario\s+de\s+funcionamento|valores?|convenios?|financeiro|boleto|retorno|exames?\b(?!.*consulta))/.test(r) && !/\bconsulta/.test(r)) return -1;
    if (/\b(agendamento|agendar|marcar|marcacao)\b[^.\n]{0,20}\bconsultas?\b/.test(r)) return 10;
    if (/\bconsultas?\b/.test(r) && !/\b(cancel\w*|confirma\w*|retorno)\b/.test(r)) return 6;
    if (/\b(falar|atendente|humano|recepcao|atendimento\s+humano)\b/.test(r)) return 2;
    return 0;
  };
  let melhor: OpcaoDeMenu | null = null; let melhorScore = 0;
  for (const o of opcoes) {
    const s = score(o.rotulo);
    if (s > melhorScore) { melhor = o; melhorScore = s; }
  }
  return melhor?.numero ?? null;
}

export interface DadosDoPaciente {
  nomeCompleto?: string | null;
  nascimento?: string | null; // DD/MM/AAAA
  cpf?: string | null;        // formatado ou dígitos
  telefone?: string | null;
  convenio?: string | null;
  carteirinha?: string | null;
}

export type AcaoParaRobo =
  | { acao: 'enviar'; texto: string; motivo: string }
  | { acao: 'perguntar_paciente'; dado: DadoPedido; pergunta: string }
  | { acao: 'esperar'; motivo: string }
  | { acao: 'desistir'; motivo: string };

const PERGUNTA_AO_PACIENTE: Record<DadoPedido, string> = {
  nome_completo: 'A clínica pediu seu nome completo pra abrir o cadastro. Me passa?',
  nascimento: 'A clínica pediu sua data de nascimento (dia/mês/ano) pra abrir o cadastro. Me passa?',
  cpf: 'A clínica pediu seu CPF pra abrir o cadastro. Pode me passar?',
  telefone: 'A clínica pediu um telefone de contato. Pode ser este WhatsApp mesmo? Me confirma.',
  convenio: 'A clínica perguntou o seu convênio (ou se é particular). Qual é?',
  carteirinha: 'A clínica pediu o número da carteirinha do convênio. Me passa?',
  endereco: 'A clínica pediu seu endereço. Me passa?',
  email: 'A clínica pediu um e-mail pra cadastro. Me passa?',
};

/** Decide o que responder ao robô — sem modelo de linguagem. */
export function responderRobo(analise: AnaliseDeRobo, dados: DadosDoPaciente, ultimaOpcaoEnviada?: string | null): AcaoParaRobo {
  switch (analise.tipo) {
    case 'saudacao_automatica':
      return { acao: 'esperar', motivo: 'saudação automática — o próximo prompt diz o que ele quer' };
    case 'menu':
    case 'pede_numero': {
      const numero = escolherOpcaoDeAgendamento(analise.opcoes);
      if (numero) return { acao: 'enviar', texto: numero, motivo: `opção de agendamento: ${numero}` };
      if (!analise.opcoes.length && ultimaOpcaoEnviada) return { acao: 'enviar', texto: ultimaOpcaoEnviada, motivo: 'robô re-pediu o número — repete a última opção' };
      return { acao: 'desistir', motivo: analise.opcoes.length ? 'menu sem opção de consulta nem atendente humano' : 'robô pede número sem mostrar menu' };
    }
    case 'opcao_invalida':
      return { acao: 'desistir', motivo: 'o robô não aceitou a opção enviada' };
    case 'pede_dado': {
      const d = analise.dadoPedido;
      if (!d) return { acao: 'esperar', motivo: 'pedido de dado não identificado' };
      const valor = d === 'nome_completo' ? dados.nomeCompleto
        : d === 'nascimento' ? dados.nascimento
        : d === 'cpf' ? dados.cpf
        : d === 'telefone' ? dados.telefone
        : d === 'convenio' ? dados.convenio
        : d === 'carteirinha' ? dados.carteirinha
        : null;
      if (valor && String(valor).trim()) return { acao: 'enviar', texto: String(valor).trim(), motivo: `dado do perfil: ${d}` };
      return { acao: 'perguntar_paciente', dado: d, pergunta: PERGUNTA_AO_PACIENTE[d] };
    }
    default:
      return { acao: 'esperar', motivo: 'não é robô' };
  }
}

/** ASSUNTO de uma pergunta: um dado conhecido (nome_completo, nascimento…) ou 'outro'. */
export function assuntoDaPergunta(texto: string | null | undefined): string {
  const f = foldPt((texto ?? '').trim());
  for (const [dado, re] of DADOS) if (re.test(f)) return dado;
  return 'outro';
}

const STOP_ASSUNTO = new Set(['clinica', 'farmacia', 'pediu', 'perguntou', 'esta', 'pedindo', 'saber', 'quer', 'voce', 'para', 'prosseguir', 'seguir', 'conseguir', 'agendamento', 'consulta', 'atendimento', 'favor', 'pode', 'passar', 'informar', 'confirma', 'confirmar', 'precisa', 'preciso', 'cadastro', 'abrir']);
function tokensDeConteudo(texto: string): Set<string> {
  return new Set(foldPt(texto).replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((t) => t.length >= 4 && !STOP_ASSUNTO.has(t)));
}

/**
 * Duas perguntas são o MESMO assunto? Dado conhecido → igualdade do dado. Sem dado conhecido →
 * similaridade dos tokens de conteúdo (Jaccard ≥ 0,5; paráfrases trocam verbos e mantêm os
 * substantivos — "manhã ou tarde" sobrevive a "quer saber se" vs "perguntou se").
 */
export function mesmoAssunto(a: string | null | undefined, b: string | null | undefined): boolean {
  const ta = assuntoDaPergunta(a); const tb = assuntoDaPergunta(b);
  if (ta !== 'outro' || tb !== 'outro') return ta === tb;
  const A = tokensDeConteudo(a ?? ''); const B = tokensDeConteudo(b ?? '');
  if (!A.size || !B.size) return false;
  let inter = 0; for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter) >= 0.5;
}

export interface MensagemDaConversa { direction: 'in' | 'out'; content: string | null | undefined }

/**
 * O robô está em LOOP? Só conta quando NÓS RESPONDEMOS e ele repetiu o MESMO prompt mesmo
 * assim: `limiar` respostas nossas rejeitadas (o prompt voltou igual depois de cada uma).
 * Robô que re-pergunta enquanto a gente espera o paciente NÃO é loop — é só espera; quem
 * segura a repetição ao paciente é o dedupe por assunto.
 * `mensagens` em ordem cronológica (mais antiga primeiro), últimas ~16.
 */
export function roboEmLoop(mensagens: MensagemDaConversa[], limiar = 2, janela = 16): boolean {
  const seq = mensagens.slice(-janela);
  const norm = (t: string | null | undefined) => foldPt((t ?? '').trim()).replace(/[^a-z0-9]+/g, ' ').trim();
  const ultimaIn = [...seq].reverse().find((m) => m.direction === 'in');
  const alvo = norm(ultimaIn?.content);
  if (!alvo) return false;
  // Ocorrências ANTERIORES do mesmo prompt que foram seguidas de uma resposta nossa.
  let rejeitadas = 0;
  for (let i = 0; i < seq.length - 1; i++) {
    const m = seq[i]!;
    if (m.direction !== 'in' || norm(m.content) !== alvo) continue;
    if (m === ultimaIn) break;
    const respondemos = seq.slice(i + 1).findIndex((x) => x.direction === 'in') !== -1
      ? seq.slice(i + 1, i + 1 + seq.slice(i + 1).findIndex((x) => x.direction === 'in')).some((x) => x.direction === 'out')
      : false;
    if (respondemos) rejeitadas++;
  }
  return rejeitadas >= limiar;
}

/**
 * NARRAÇÃO INTERNA que nunca deve sair pra clínica/farmácia: o modelo "pensa alto" em 3ª
 * pessoa ("o paciente", "vou precisar perguntar ao paciente", "só tenho o primeiro nome").
 */
export function pareceNarracaoInterna(textoDoAgente: string | null | undefined): boolean {
  const f = foldPt((textoDoAgente ?? '').trim());
  if (!f) return false;
  return /\b(ao|do|da|o|a)\s+paciente\b|\bo\s+cliente\b|\bvou\s+(precisar\s+)?perguntar\b|\bso\s+tenho\s+o\s+primeiro\s+nome\b|\bpreciso\s+(do|da)\s+\w+\s+(completo|completa)\s+d[oa]\s+(paciente|cliente)\b|\ba\s+clinica\s+esta\s+(pedindo|insistindo)\b|\ba\s+farmacia\s+esta\s+(pedindo|insistindo)\b/.test(f);
}

/** Cortesia neutra quando a narração é derrubada e o outro lado é humano. */
export const CORTESIA_NEUTRA = 'Só um instante que eu confirmo aqui e já te respondo, tá?';
