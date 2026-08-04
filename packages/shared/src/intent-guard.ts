/**
 * intent-guard — protege uma intenção VIVA do paciente contra ser encerrada por uma
 * resposta curta e ambígua. PURO e testável.
 *
 * ─── POR QUE ISTO EXISTE (auditoria 04/08, caso Glauber) ──────────────────────
 * 01/08 — Glauber: "quero marcar uma consulta". Xarlote: "É pra qual especialidade?"
 * 01/08 — Glauber: "Cardiologista". Xarlote: "É em Goiânia mesmo? E você vai usar algum
 *         plano de saúde ou é particular?"
 * 02/08 — Glauber: "Não precisa"
 * 02/08 — Xarlote: "Tá certo, então deixo pra lá? Sem problema nenhum!"
 *
 * "Não precisa" era a resposta à pergunta sobre PLANO — "não precisa de plano, é
 * particular". A Xarlote leu como "não precisa da consulta" e encerrou. Nunca existiu
 * linha em `consultations`: a intenção morreu na conversa, invisível pra todo vigilante
 * do sistema. Perdemos o evento mais escasso do produto por duas palavras.
 *
 * A regra é assimetria de custo: encerrar por engano custa a consulta; perguntar de novo
 * por engano custa uma frase. Então **desistência tem que ser EXPLÍCITA.** Uma negação
 * curta respondendo a uma pergunta com "ou" é ambígua por construção, e ambiguidade
 * NUNCA encerra — pergunta.
 */
import { foldPt } from './br-datetime.js';

/**
 * Frases que encerram sem margem de dúvida. Curtas de propósito: cada uma só se escreve
 * pra desistir de algo, nunca pra responder "particular ou plano?".
 */
const ABANDONO_EXPLICITO: RegExp[] = [
  /\bnao\s+quero\s+mais\b/,
  /\bnao\s+quero\s+(?:marcar|agendar|a\s+consulta|mais\s+nada)\b/,
  /\bdesisti(?:u|r)?\b/,
  /\b(?:cancela|cancelar|cancele)\b/,
  /\bdeixa\s+(?:pra|para)\s+(?:depois|outro\s+dia|outra\s+hora|mais\s+tarde)\b/,
  /\bnao\s+precisa\s+(?:mais|da\s+consulta|marcar|agendar)\b/,
  /\bmudei\s+de\s+ideia\b/,
  /\bja\s+(?:marquei|resolvi|consegui)\b/,
  /\bnao\s+vou\s+(?:marcar|mais)\b/,
  /\bpode\s+(?:cancelar|deixar\s+pra\s+la)\b/,
  /\besquece\b/,
];

/**
 * Negações CURTAS que só fazem sentido dentro do que foi perguntado. Sozinhas não
 * encerram nada — é exatamente aqui que o "Não precisa" do Glauber cai.
 */
const NEGACAO_AMBIGUA: RegExp[] = [
  /^nao$/,
  /^nao\s+precisa$/,
  /^nao\s+precisa\s+nao$/,
  /^sem$/,
  /^nenhum$/,
  /^nenhuma$/,
  /^negativo$/,
  /^nao\s+tenho$/,
  /^nao\s+uso$/,
  /^nao\s+e$/,
  /^deixa$/,
  /^tanto\s+faz$/,
  /^indiferente$/,
];

/** Normaliza pra comparação: sem acento, sem pontuação, espaços colapsados. */
function norm(text: string): string {
  return foldPt(text)
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** O paciente desistiu de forma INEQUÍVOCA? Só isto autoriza encerrar. */
export function isExplicitAbandon(text: string): boolean {
  const t = norm(text);
  if (!t) return false;
  return ABANDONO_EXPLICITO.some((re) => re.test(t));
}

/**
 * É uma negação curta que só significa algo à luz da pergunta anterior?
 *
 * Nota sobre "não precisa": aparece nas DUAS listas de propósito, e a ordem de
 * avaliação resolve. `não precisa` sozinho é ambíguo; `não precisa MAIS` /
 * `não precisa da consulta` / `não precisa marcar` é explícito. A diferença é
 * literalmente a palavra que diz de QUÊ ele não precisa.
 */
export function isAmbiguousNegation(text: string): boolean {
  const t = norm(text);
  if (!t || t.length > 20) return false;
  if (isExplicitAbandon(text)) return false;
  return NEGACAO_AMBIGUA.some((re) => re.test(t));
}

export type IntentVerdict = 'abandon' | 'ask-first' | 'continue';

/**
 * Decide o que fazer com uma intenção viva diante da última mensagem do paciente.
 *
 * `ask-first` é o veredito que faltava: nem seguir em frente ignorando o "não", nem
 * encerrar. Pergunta de qual das duas coisas ele está falando.
 */
export function verdictForLiveIntent(text: string): IntentVerdict {
  if (isExplicitAbandon(text)) return 'abandon';
  if (isAmbiguousNegation(text)) return 'ask-first';
  return 'continue';
}
