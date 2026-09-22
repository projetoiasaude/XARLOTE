/**
 * A emergência que o SERVIDOR reconhece sozinho — sem depender do modelo.
 *
 * ## Por que existe (e por que cresceu em 22/09)
 *
 * A preempção determinística cobria só sinais FÍSICOS agudos (dor no peito, falta de ar,
 * AVC, sangramento). Ideação suicida, automutilação e overdose dependiam INTEIRAMENTE de
 * o modelo chamar `red_flag_check` — e o modelo de fallback (que atende todo turno com
 * foto, e turnos inteiros quando o primário falha) perde chamada de ferramenta no
 * benchmark da casa. Num dia de fallback, "tomei a cartela inteira" podia virar conversa
 * comum. `EMERGENCY_KEYWORDS` em `constants.ts` até listava "suicídio" e "overdose", mas
 * não tinha um único chamador: código morto que parecia proteção.
 *
 * ## A régua
 *
 * Conservadora nos DOIS sentidos, porque os dois erros custam caro: mandar os botões do
 * SAMU pra quem disse "tô morrendo de rir" queima a credibilidade da única ferramenta
 * que precisa ser levada a sério; não mandar pra quem disse "quero me matar" é o pior
 * desfecho que este sistema tem. Por isso: frases de alto sinal, com as exceções
 * idiomáticas do português explicitamente descontadas ("morrer de rir", "me matar de
 * trabalhar", "matando de saudade").
 *
 * Quem chama aplica as guardas de PASSADO e TERCEIRA PESSOA por cima (ver
 * `PASSADO_RE`/`TERCEIRO_RE` e `emergenciaSobreQuemCuido`): aqui só se responde "esta
 * frase, sozinha, é sinal de emergência AGORA — e de qual tipo".
 */

/** As categorias que a tool `red_flag_check` entende. */
export type CategoriaDeEmergencia =
  | 'suicide_ideation'
  | 'self_harm'
  | 'overdose'
  | 'other_critical';

/**
 * Figuras de linguagem que usam "morrer/matar" sem nada a ver com morte. Sem isto,
 * "morrendo de rir" e "me matando de trabalhar" virariam emergência — e o português
 * brasileiro usa essas construções o tempo todo.
 */
const FIGURA_DE_LINGUAGEM =
  /^\s*[,]?\s*(de|da|do)\s+(rir|rindo|risada|vergonha|sono|fome|sede|calor|frio|amor|saudade[s]?|t[ée]dio|pregui[çc]a|trabalh|estud|tanto|curiosidade|raiva|inveja|medo|cansa[çc]o)/i;

/** "me matando de trabalhar", "matar o tempo", "matar aula" — nada disso é emergência. */
const MATAR_INOFENSIVO = /\bmatar\s+(o\s+tempo|aula|a\s+saudade|a\s+charada|a\s+fome|a\s+sede)\b/i;

const IDEACAO_SUICIDA: RegExp[] = [
  /\b(quero|queria|vou|penso em|pensando em|pensei em|tenho vontade de)\s+(me\s+)?(matar|morrer|sumir de vez)\b/i,
  /\b(n[ãa]o\s+(quero|aguento)\s+mais\s+viver|cansei\s+de\s+viver|melhor\s+(eu\s+)?morrer|queria\s+n[ãa]o\s+existir)\b/i,
  /\b(acabar|dar cabo)\s+com\s+(a\s+)?(minha\s+)?vida\b/i,
  /\btirar\s+(a\s+)?(minha\s+)?(pr[óo]pria\s+)?vida\b/i,
  /\b(pensamento[s]?|ideia[s]?)\s+suicida[s]?\b/i,
  /\bme\s+suicidar\b|\bsuic[íi]dio\b/i,
];

const AUTOMUTILACAO: RegExp[] = [
  /\bme\s+(cortei|cortando|corto|machuquei|machucando|queimei)\b/i,
  /\bcortar\s+(os\s+)?(meus\s+)?pulso[s]?\b/i,
  /\b(me\s+)?automutil/i,
];

const OVERDOSE: RegExp[] = [
  /\btomei\s+(a\s+)?(cartela|caixa|vidro|frasco)\s+(toda|inteira|inteiro)\b/i,
  /\btomei\s+(um\s+monte|v[áa]rios|todos)\s+(de\s+)?(os\s+)?(comprimido|rem[ée]dio|compridinho)/i,
  /\btomei\s+rem[ée]dio\s+demais\b/i,
  /\boverdose\b/i,
  /\btomei\s+\d{2,}\s+(comprimido|c[áa]psula|p[íi]lula)/i,
];

/** Sinais FÍSICOS agudos — a régua que já existia, movida pra cá sem afrouxar. */
const SINAL_FISICO =
  /(dor no peito|aperto no peito|falta de ar|n[aã]o consigo respirar|desmai|convuls|derrame\b|\bavc\b|rosto torto|fala arrastada|sangrando muito|dor de cabe[çc]a (muito|t[aã]o|super|bem) forte|infarto|enfarte|hemorragia|inconsciente|parou de respirar|n[aã]o (est[aá] )?respirando)/i;
// "engasguei" ficou de FORA de propósito: em 1ª pessoa quase sempre é o engasgo leve que
// a pessoa já superou pra poder digitar. "Acidente" também — "por acidente" e "acidente
// doméstico pequeno" são conversa comum. Palavra ambígua não entra numa régua que
// interrompe o turno com os botões do SAMU.

/**
 * Casa um dos padrões E desconta a idiomática SÓ quando ela é o COMPLEMENTO do verbo.
 *
 * Duas versões erradas antes desta, nesta ordem:
 *
 * 1. "é figura de linguagem?" sobre a MENSAGEM INTEIRA — aí *"tenho vontade de sumir de
 *    vez, tô morrendo de vergonha do que fiz"* tinha a detecção desligada pelo "de
 *    vergonha" de outra oração. Co-ocorrência banal, detecção muda.
 * 2. Uma janela de 20 caracteres depois do casamento — que ainda atravessava a vírgula:
 *    *"não aguento mais viver, morrendo de sono"* caía no "de sono" do trecho seguinte.
 *
 * O que separa os dois casos é a GRAMÁTICA: em "morrer **de vergonha**" o complemento vem
 * colado ao verbo; em "viver, morrendo de sono" ele pertence a outra oração. Por isso a
 * idiomática é testada ANCORADA no que vem logo depois do casamento (`^`), e não "em
 * algum lugar por perto".
 */
function casaAlgum(padroes: RegExp[], texto: string): boolean {
  for (const p of padroes) {
    const m = p.exec(texto);
    if (!m) continue;
    const depois = texto.slice(m.index + m[0].length);
    // "morrer DE vergonha" — complemento colado ao verbo.
    if (FIGURA_DE_LINGUAGEM.test(depois)) continue;
    // "matar O TEMPO/aula" — objeto direto, não preposicionado.
    if (MATAR_INOFENSIVO.test(m[0] + depois.slice(0, 20))) continue;
    return true;
  }
  return false;
}

/**
 * Esta fala é emergência? Devolve a CATEGORIA (que muda a frase e o registro clínico)
 * ou `null`.
 *
 * A ordem importa: uma frase que traz ideação E sinal físico ("tomei a cartela inteira e
 * não consigo respirar") é classificada pela causa, não pelo sintoma.
 */
export function categoriaDeEmergenciaNaFala(texto: string | null | undefined): CategoriaDeEmergencia | null {
  if (!texto || !texto.trim()) return null;

  if (casaAlgum(OVERDOSE, texto)) return 'overdose';
  if (casaAlgum(IDEACAO_SUICIDA, texto)) return 'suicide_ideation';
  if (casaAlgum(AUTOMUTILACAO, texto)) return 'self_harm';
  if (SINAL_FISICO.test(texto)) return 'other_critical';
  return null;
}
