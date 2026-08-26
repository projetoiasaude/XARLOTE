/**
 * laudo-recorte — quando o laudo não cabe, cortar pelo que VALE, não pelo que vem antes.
 *
 * ─── O PROBLEMA ───────────────────────────────────────────────────────────────
 * Documento maior que o teto de contexto era cortado por POSIÇÃO: `texto.slice(0, limite)`.
 * Num laudo de laboratório isso é o pior corte possível, porque a ordem de um laudo é
 * quase sempre a mesma:
 *
 *   cabeçalho e endereço do laboratório · dados do paciente · método · hemograma ·
 *   bioquímica · hormônios · observações do responsável técnico · rodapé legal
 *
 * O começo é o que menos importa (endereço, CNPJ, telefone do laboratório) e o fim é onde
 * costumam estar bioquímica, hormônios e a observação técnica. Cortar os primeiros N
 * caracteres joga fora exatamente a metade clínica.
 *
 * ─── O QUE ESTE MÓDULO FAZ ────────────────────────────────────────────────────
 * Quando não cabe, mantém:
 *   1. um CABEÇALHO curto (as primeiras linhas identificam paciente, data e material);
 *   2. todas as linhas que carregam VALOR — número com unidade, faixa de referência,
 *      marcador seguido de resultado — na ORDEM ORIGINAL, de ponta a ponta do documento.
 *
 * E descarta o que é ruído previsível: endereço, CNPJ, telefone, "página X de Y", rodapé
 * de assinatura digital.
 *
 * ⚠️ NÃO reinterpreta, não reordena e não resume. Só escolhe QUAIS linhas cabem. O corte
 * continua ANUNCIADO por quem chama — laudo que encolhe em silêncio ensina o paciente que
 * o app perde exame.
 *
 * PURO: sem I/O, sem relógio.
 */

/** Número seguido de unidade clínica, ou percentual. É o sinal mais forte de valor. */
const UNIDADE = /\d\s*(?:mg\/dl|g\/dl|mg\/l|g\/l|ng\/ml|pg\/ml|ui\/l|u\/l|mmol\/l|mcg|µg|ml\/min|mm3|mm³|\/mm3|mil\/mm3|milh|%|mmhg|bpm|ui\/ml|meq\/l|fl\b|pg\b|seg\b)/i;

/** Vocabulário de faixa de referência — a linha do valor quase sempre traz uma. */
const REFERENCIA = /\b(?:valor(?:es)?\s+de\s+refer|refer[êe]ncia|\bvr\b|\bv\.r\b|intervalo|desej[áa]vel|limite|at[ée]\s+\d|superior\s+a|inferior\s+a|menor\s+que|maior\s+que)/i;

/**
 * Resultado nomeado: "Hemoglobina: 13,2" / "Glicose 96".
 *
 * ⚠️ Só vale em linha CURTA. Sem o teto de comprimento, uma frase de prosa com um número
 * no meio ("Observação metodológica 3: o ensaio segue procedimento…") casava e entrava
 * como se fosse resultado — pego pelo teste, que viu a bioquímica ser expulsa por texto
 * corrido. Linha de resultado é curta por natureza; parágrafo não é.
 */
const MARCADOR_COM_NUMERO = /^[^\d\n]{3,44}[:\s]\s*-?\d+[.,]?\d*/;
const MAX_LINHA_DE_RESULTADO = 120;

/** Ruído previsível de laudo — o que dá pra descartar sem perder informação clínica. */
const RUIDO = [
  /\b(?:cnpj|cpf do laborat|inscri[çc][ãa]o|raz[ãa]o social)\b/i,
  /\b(?:rua|avenida|av\.|alameda|travessa)\b.{0,60}\b(?:n[ºo°]|\d{2,5})\b/i,
  /\bp[áa]gina\s+\d+\s*(?:de|\/)\s*\d+/i,
  /\b(?:assinado|assinatura)\s+(?:digital|eletr[ôo]nic)/i,
  /\bwww\.|https?:\/\/|@[\w.-]+\.\w{2,}/i,
  /\btelefone|\bfone\b|\bfax\b|\bcep\b/i,
  /^[\s\-_=.·•]*$/,
];

/** Quantas linhas do topo entram sempre — é onde ficam paciente, data e material. */
export const LINHAS_DE_CABECALHO = 12;

export interface RecorteDeLaudo {
  texto: string;
  /** `true` quando alguma linha ficou de fora. */
  cortado: boolean;
  linhasNoOriginal: number;
  linhasMantidas: number;
}

function ehRuido(linha: string): boolean {
  return RUIDO.some((re) => re.test(linha));
}

/** A linha carrega resultado de exame? */
export function linhaTemValor(linha: string): boolean {
  const l = linha.trim();
  if (l.length < 3 || ehRuido(l)) return false;
  // Unidade e faixa de referência valem em qualquer comprimento — são inequívocas.
  if (UNIDADE.test(l) || REFERENCIA.test(l)) return true;
  return l.length <= MAX_LINHA_DE_RESULTADO && MARCADOR_COM_NUMERO.test(l);
}

/**
 * Recorta o laudo pro limite, preservando o que tem valor clínico.
 *
 * A ordem original é mantida: um laudo lido fora de ordem confunde mais que um laudo
 * incompleto, e a Xarlote precisa poder dizer "li o hemograma e a bioquímica" sem
 * inventar a sequência.
 */
export function recortarLaudo(texto: string, limite: number): RecorteDeLaudo {
  const bruto = texto ?? '';
  const linhas = bruto.split(/\r?\n/);
  if (bruto.length <= limite) {
    return { texto: bruto, cortado: false, linhasNoOriginal: linhas.length, linhasMantidas: linhas.length };
  }

  const manter = new Set<number>();
  // 1. Cabeçalho: identifica de quem é o exame e de quando.
  for (let i = 0; i < Math.min(LINHAS_DE_CABECALHO, linhas.length); i++) {
    if (!ehRuido(linhas[i]!)) manter.add(i);
  }
  // 2. Tudo que carrega valor, do começo ao FIM do documento.
  for (let i = 0; i < linhas.length; i++) {
    if (linhaTemValor(linhas[i]!)) manter.add(i);
  }

  // 3. Monta respeitando o teto. Se nem as linhas de valor couberem, o corte volta a ser
  //    por posição — mas agora sobre um conjunto que já é só o que importa.
  const escolhidas: string[] = [];
  let usados = 0;
  let sobrou = false;
  for (const i of [...manter].sort((a, b) => a - b)) {
    const l = linhas[i]!;
    if (usados + l.length + 1 > limite) { sobrou = true; break; }
    escolhidas.push(l);
    usados += l.length + 1;
  }

  // 🛟 NADA FOI ESCOLHIDO ⇒ volta o corte por posição.
  //
  // Um documento sem nenhuma linha reconhecível como resultado não é um laudo: é uma
  // carta, um relatório corrido, ou um PDF de uma linha só. Devolver vazio ali seria
  // trocar "meio laudo" por "laudo nenhum" — o oposto do que esta função existe pra fazer.
  // Pego por `tests/inbound-documento.test.ts`, que manda 900 caracteres numa linha só.
  if (escolhidas.length === 0) {
    return {
      texto: bruto.slice(0, limite),
      cortado: true,
      linhasNoOriginal: linhas.length,
      linhasMantidas: 0,
    };
  }

  return {
    texto: escolhidas.join('\n'),
    cortado: sobrou || escolhidas.length < linhas.length,
    linhasNoOriginal: linhas.length,
    linhasMantidas: escolhidas.length,
  };
}
