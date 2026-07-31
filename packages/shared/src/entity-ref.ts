/**
 * REFERÊNCIA A ENTIDADE VINDA DO MODELO — decisão pura.
 *
 * ## A raiz
 * Toda tool que recebe um `*_id` está pedindo ao LLM que se comporte como banco de dados.
 * Ele não é. Em produção (30/07) isso apareceu em três formas no mesmo dia:
 *   - `cancel_consultation({consultation_id:'act…'})`   → placeholder inventado
 *   - `confirm_consultation({consultation_id:'Nilo Machado Junior', quote_id:'13/08/2026 09:00'})`
 *     → o NOME e a DATA no lugar dos uuids
 *   - `save_exam_result({message_id:'message_id'})`      → o nome do campo como valor
 * E existe uma quarta forma, ainda não vista mas inevitável em escala: o modelo ecoa um uuid
 * VÁLIDO que leu no contexto/histórico e que pertence a OUTRO paciente. Confiar no id cru
 * significa, nesse dia, cancelar a consulta de outra pessoa.
 *
 * ## A regra
 * O id do modelo é uma PISTA, nunca uma chave. Quem manda é o estado real do paciente:
 *   1. uuid que está entre as entidades DO PACIENTE  → exato (o caso feliz).
 *   2. uuid que não está                             → descartado, nunca usado. Cai no resgate.
 *   3. texto que casa com o rótulo de exatamente uma → resgatado ("Rafael" → a consulta do
 *      Dr. Rafael Navarrete). É o que faz o sistema FUNCIONAR, não só deixar de quebrar.
 *   4. texto com significado que não casa com nada   → `none`. **Nunca cai no resgate por
 *      eliminação**: "Nilo Machado Junior" com uma única consulta ativa do Dr. Marco Elísio
 *      resolveria para o Marco — confirmar a consulta ERRADA é pior que não confirmar.
 *   5. lixo sem significado (placeholder, nome de campo, número, uuid alheio) → se o paciente
 *      tem exatamente UMA entidade viva, é ela; se tem várias, é ambíguo e se PERGUNTA.
 *
 * Ambiguidade e ausência não têm resolução silenciosa: viram falha explícita que voltará ao
 * modelo. Adivinhar em silêncio foi o que produziu "Pronto, cancelei" sem cancelamento.
 */

/** Formato uuid aceito pelo Postgres (qualquer versão). */
export function isUuid(v: unknown): boolean {
  return typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v.trim());
}

/**
 * Tokens sem poder de identificação. Três famílias:
 *  - placeholders que o modelo inventa quando não sabe ("active", "current", "xxx");
 *  - NOMES DE CAMPO que vazam como valor ("message_id", "consultation_id") — visto ao vivo;
 *  - conectores/títulos PT-BR, que casariam com qualquer coisa ("de", "com", "dr").
 * `consulta`/`pedido` entram de propósito: são o rótulo genérico usado quando a especialidade
 * é desconhecida, e deixá-los significativos faria QUALQUER frase casar com QUALQUER consulta.
 */
const NOISE_TOKENS = new Set([
  'id', 'ids', 'uuid', 'guid', 'key', 'value', 'string', 'null', 'none', 'undefined', 'nan',
  'todo', 'tbd', 'xxx', 'abc', 'test', 'teste', 'exemplo', 'example', 'placeholder', 'chatcmpl',
  'msgid', 'na', 'current', 'actual', 'active', 'atual', 'last', 'latest', 'ultimo', 'ultima',
  'recent', 'recente', 'this', 'esse', 'este', 'essa', 'esta',
  // vocabulário de ESCOLHA: o paciente vê "1️⃣ 2️⃣ 3️⃣" e o modelo devolve "opção 1"/"a
  // primeira". Sem isso, "opcao" (≥3 letras) contava como nome e caía em label-mismatch.
  'opcao', 'opcoes', 'option', 'options', 'opt', 'escolha', 'alternativa', 'numero', 'number',
  'primeira', 'primeiro', 'segunda', 'segundo', 'terceira', 'terceiro',
  'message', 'messages', 'msg', 'consultation', 'consulta', 'consultas', 'quote', 'quotes',
  'cotacao', 'order', 'orders', 'pedido', 'pedidos', 'item', 'items', 'appointment',
  'de', 'da', 'do', 'das', 'dos', 'com', 'para', 'pra', 'em', 'no', 'na', 'o', 'a', 'os', 'as',
  'e', 'dr', 'dra', 'doutor', 'doutora', 'sr', 'sra',
  // unidades de tempo faladas: "dia 11", "às 9 horas" — a informação é o NÚMERO.
  'dia', 'dias', 'hora', 'horas', 'h', 'hs', 'min', 'mins', 'minutos',
]);

function tokenize(s: string): string[] {
  return s
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    // "9h30" e "15h" s\u00e3o UM token s\u00f3 (h \u00e9 letra) e nunca casariam com o r\u00f3tulo "09:30".
    // O h entre/depois de d\u00edgitos \u00e9 separador de hora em PT-BR, n\u00e3o conte\u00fado.
    .replace(/(\d)\s*h\s*(\d)/g, '$1:$2')
    .replace(/(\d)\s*h\b/g, '$1')
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    // Zero \u00e0 esquerda fora: o paciente escreve "9h30" e o r\u00f3tulo \u00e9 "09:30" \u2014 sem isto,
    // '9' \u2260 '09' e uma escolha inequ\u00edvoca virava "n\u00e3o entendi, qual hor\u00e1rio?".
    .map((t) => (/^\d+$/.test(t) ? String(Number(t)) : t));
}

/** Tokens que efetivamente identificam algo (sem ruído). */
function significant(s: string): string[] {
  return tokenize(s).filter((t) => !NOISE_TOKENS.has(t));
}

/**
 * A referência é UM número solto? Devolve-o; senão null.
 * Serve pra distinguir "quero a 2" (número da OPÇÃO) de qualquer outra coisa — necessário
 * porque, sem zero à esquerda, o mês `02` de uma data também vira o token `2`.
 */
export function loneNumberRef(raw: unknown): number | null {
  const toks = significant(typeof raw === 'string' ? raw : '');
  if (toks.length !== 1 || !/^\d+$/.test(toks[0]!)) return null;
  return Number(toks[0]);
}

/**
 * A referência carrega PALAVRA de verdade? (≥3 letras seguidas em algum token)
 * Datas e ids numéricos NÃO carregam: "13/08/2026 09:00" que não casa com nenhuma cotação
 * ainda pode ser resolvido pela única cotação existente, enquanto "Nilo Machado Junior" que
 * não casa com nada tem que falhar.
 */
function carriesMeaning(tokens: string[]): boolean {
  return tokens.some((t) => /[a-z]{3}/.test(t));
}

/** Casa se um lado contém todos os tokens significativos do outro ("Rafael" ⊂ "Dr. Rafael Navarrete"). */
function labelMatches(rawTokens: string[], labelTokens: string[]): boolean {
  if (!rawTokens.length || !labelTokens.length) return false;
  return rawTokens.every((t) => labelTokens.includes(t)) || labelTokens.every((t) => rawTokens.includes(t));
}

export interface EntityCandidate {
  id: string;
  /** Como o paciente/modelo pode se referir a isto: nome do médico, especialidade, data, clínica. */
  labels: Array<string | null | undefined>;
}

export type RefDecision =
  | { kind: 'exact'; id: string }
  | { kind: 'rescued'; id: string; why: 'label' | 'only-one' }
  | { kind: 'none'; reason: 'no-candidates' | 'label-mismatch' }
  | { kind: 'ambiguous'; ids: string[] };

/**
 * `candidates` DEVE vir pré-filtrado pelo dono (user_id) — é essa pré-filtragem que torna
 * impossível tocar a entidade de outro paciente, mesmo com um uuid alheio válido na mão.
 */
export function resolveEntityRef(raw: unknown, candidates: EntityCandidate[]): RefDecision {
  if (!candidates.length) return { kind: 'none', reason: 'no-candidates' };
  const rawStr = typeof raw === 'string' ? raw.trim() : '';

  if (isUuid(rawStr)) {
    const hit = candidates.find((c) => c.id.toLowerCase() === rawStr.toLowerCase());
    if (hit) return { kind: 'exact', id: hit.id };
    // uuid que não é do paciente: DESCARTADO. Segue pro resgate por estado — que só
    // enxerga as entidades dele, então o id alheio não tem como ser usado.
  } else if (rawStr) {
    const rawTokens = significant(rawStr);
    if (rawTokens.length) {
      const hits = candidates.filter((c) =>
        c.labels.some((l) => labelMatches(rawTokens, significant(String(l ?? '')))),
      );
      if (hits.length === 1) return { kind: 'rescued', id: hits[0]!.id, why: 'label' };
      if (hits.length > 1) return { kind: 'ambiguous', ids: hits.map((h) => h.id) };
      // Nomeou algo de verdade e nada bateu → o paciente NÃO tem essa entidade.
      if (carriesMeaning(rawTokens)) return { kind: 'none', reason: 'label-mismatch' };
    }
  }

  if (candidates.length === 1) return { kind: 'rescued', id: candidates[0]!.id, why: 'only-one' };
  return { kind: 'ambiguous', ids: candidates.map((c) => c.id) };
}
