/**
 * reminder-body — o corpo de um lembrete não pode carregar placeholder disfarçado de frase.
 *
 * ─── O QUE ACONTECEU (Glauber, 04–08/09/2026) ────────────────────────────────────
 * O modelo escreveu no `body` do lembrete de antibiótico:
 *   "Toma 1 comprimido agora, depois das 13h30. Faltam X dias pra acabar a caixa!"
 * Com o X literal — um espaço que ele esperava que alguém preenchesse. Ninguém preenche:
 * o body é entregue como está, todo dia, às 13h30. Saiu assim cinco dias seguidos pra um
 * paciente real, e teria saído pra sempre (a recorrência não tinha fim — ver rrule.ts).
 *
 * ─── A REGRA ─────────────────────────────────────────────────────────────────────
 * O body é texto FINAL. Se uma oração contém marca de preenchimento ("X dias", "{nome}",
 * "[remédio]", "N doses", "___") — ou uma PROMESSA de ação da Xarlote ("vou entrar no site
 * e buscar", "já volto com novidades"; ver `prometeAcaoDaXarlote`) — a oração inteira sai. Texto com um buraco a menos é
 * sempre melhor que texto com um buraco à mostra — e o modelo recebe, na observação da
 * ferramenta, o que foi cortado e o motivo, pra aprender no mesmo turno.
 *
 * Contagens de verdade ("faltam 3 dias") não são placeholder e passam. O que se corta é o
 * SÍMBOLO no lugar do número. Quem sabe quantos dias faltam é o servidor
 * (`fimDaRecorrencia`), e é ele que informa o modelo — não o contrário.
 *
 * PURO: sem I/O, sem relógio. Roda na criação (tool) e no disparo (dispatcher), porque as
 * linhas que já existem no banco também precisam da proteção.
 */
import { foldPt } from './br-datetime.js';

const UNIDADES = String.raw`dias?|comprimidos?|doses?|vezes|semanas?|horas?|caixas?|minutos?|meses|gotas?|ml|mg`;

/** Cada regex roda sobre a oração DOBRADA (minúscula, sem acento). */
const MARCAS_DE_PLACEHOLDER: RegExp[] = [
  /\{\{?[^}]*\}\}?/,                                                     // {nome} · {{dias}}
  /\[[^\]]{0,40}\]/,                                                     // [nome do paciente]
  /<[^>]{0,40}>/,                                                        // <remedio>
  new RegExp(String.raw`\b(?:x{1,3}|n{1,2})\s+(?:${UNIDADES})\b`),         // "X dias" · "N doses"
  new RegExp(String.raw`\b(?:faltam|falta|restam|resta|ainda|so\s+mais|mais)\s+(?:x{1,3}|n{1,2})\b`), // "faltam X"
  /_{3,}/,                                                               // ____
  /\b(?:nome do paciente|nome do remedio|nome do medicamento|inserir aqui|preencher|a definir)\b/,
  /\b(?:tbd|todo|placeholder)\b/,
];

/**
 * PROMESSA DE AÇÃO DA XARLOTE dentro do lembrete (caso Ciro, 17→21/09/2026).
 *
 * O modelo criou um lembrete pra 21/09 17:30 com o body: "Vou entrar no site do CDI com seu
 * protocolo pra buscar o resultado. Já volto com novidades!" Um lembrete não entra em site
 * nenhum — é texto que toca na hora marcada. A promessa sairia pro paciente como se fosse
 * verdade, e nada no sistema a cumpriria. Oração em que a Xarlote diz o que ELA vai fazer
 * ("vou entrar/buscar/ligar/mandar/cotar", "já volto", "te aviso assim que", "estou
 * entrando") cai. O que o PACIENTE faz ("toma 1 comprimido", "leva o exame") fica.
 */
const MARCAS_DE_PROMESSA: RegExp[] = [
  /\b(?:eu\s+)?(?:vou|irei)\s+(?:entrar|buscar|pegar|ligar|mandar|enviar|cotar|procurar|falar|verificar|checar|conferir|olhar|consultar|acessar|baixar|pesquisar|tentar)\b/,
  /\b(?:ja|logo)\s+volto\b/,
  /\bte\s+aviso\s+(?:assim|quando|se)\b/,
  /\b(?:estou|to|tou)\s+(?:entrando|buscando|pegando|ligando|cotando|procurando|verificando|acessando|baixando)\b/,
  /\bvolto\s+com\s+novidades?\b/,
];

/** `true` quando a oração promete uma ação da Xarlote (não do paciente). */
export function prometeAcaoDaXarlote(oracao: string): boolean {
  const f = foldPt(oracao);
  return MARCAS_DE_PROMESSA.some((re) => re.test(f));
}

export interface CorpoSaneado {
  /** O que sobrou. `null` quando nada aproveitável restou (o chamador usa o título). */
  body: string | null;
  /** Orações removidas, na ordem — pra log (sem PII: é texto que o modelo escreveu) e pra observação. */
  removidas: string[];
}

function oracoes(texto: string): string[] {
  return texto
    .split(/(?<=[.!?\n])\s*/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** `true` quando a oração carrega marca de preenchimento não resolvida. */
export function temPlaceholder(oracao: string): boolean {
  const f = foldPt(oracao);
  return MARCAS_DE_PLACEHOLDER.some((re) => re.test(f));
}

/**
 * Remove as orações com placeholder. Mantém a pontuação e a ordem das demais.
 * Idempotente: sanear o já saneado não muda nada.
 */
export function sanitizarCorpoDeLembrete(body: string | null | undefined): CorpoSaneado {
  const t = (body ?? '').trim();
  if (!t) return { body: null, removidas: [] };
  const partes = oracoes(t);
  const removidas: string[] = [];
  const mantidas: string[] = [];
  for (const o of partes) {
    if (temPlaceholder(o) || prometeAcaoDaXarlote(o)) removidas.push(o);
    else mantidas.push(o);
  }
  if (!removidas.length) return { body: t, removidas };
  const resto = mantidas.join(' ').replace(/\s{2,}/g, ' ').trim();
  return { body: resto || null, removidas };
}
