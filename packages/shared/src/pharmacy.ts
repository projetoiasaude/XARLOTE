/**
 * Helpers puros do fluxo de farmácia (sem I/O — testáveis isolados).
 *
 *  - `isPharmacyChain`  : deprioriza redes que só mandam auto-resposta (Fix #6).
 *  - `extractPriceBRL`  : captura preço de um texto cru da farmácia quando o
 *                         agente LLM devolve turno vazio (Fix #3, lost-offer).
 *  - `parseUnitCount`   : nº de comprimidos/unidades num texto ("20 comp" → 20)
 *                         pra detectar substituição de apresentação (20 vs 30).
 */

/** Remove acentos + minúsculas — pra casar nomes/palavras sem depender de diacrítico. */
function fold(s: string): string {
  return s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

// ─── Redes de farmácia (Fix #6) ──────────────────────────────────────────────
// Substrings (já sem acento/minúsculas) de redes que costumam só mandar
// auto-resposta e nunca engajar humano no WhatsApp. Deprioritizadas na seleção
// Top-5 (mas ainda contatadas como fallback se não houver independentes).
// NÃO incluir "rede" (casaria qualquer "Drogaria Boa Rede").
// Só marcas INEQUÍVOCAS. Removidos sobrenomes/nomes comuns que colidem com
// independentes (araujo/pacheco/sao joao/onofre/venancio) — um 'Drogaria São João'
// ou 'Farmácia Araújo' do dono independente seria deprioritizado por engano (Fix
// review). Prefere-se perder alguma rede (que só auto-responde mesmo) a cortar uma
// independente real.
export const PHARMACY_CHAIN_NAMES: readonly string[] = [
  'drogasil',
  'droga raia',
  'drogaraia',
  'raia drogasil',
  'pague menos',
  'paguemenos',
  'pague-menos',
  'drogarias pacheco',
  'extrafarma',
  'nissei',
  'drogaria sao paulo',
  'ultrafarma',
  'panvel',
  'farmais',
];

/** A farmácia é uma rede grande conhecida (por nome)? Match acento-insensível. */
export function isPharmacyChain(name: string | null | undefined): boolean {
  if (!name) return false;
  const n = fold(name);
  return PHARMACY_CHAIN_NAMES.some((c) => n.includes(c));
}

// ─── Extração de preço (Fix #3, lost-offer) ──────────────────────────────────

/** Converte "1.250,00" / "65,00" / "65.00" / "65" → número. null se inválido. */
function brNumberToFloat(raw: string): number | null {
  let x = raw.trim();
  if (/,\d{2}$/.test(x)) {
    // vírgula decimal — remove pontos de milhar
    x = x.replace(/\./g, '').replace(',', '.');
  } else if (/\.\d{2}$/.test(x)) {
    // ponto decimal — remove vírgulas de milhar
    x = x.replace(/,/g, '');
  } else {
    // inteiro (talvez com separador de milhar)
    x = x.replace(/[.,]/g, '');
  }
  const n = parseFloat(x);
  return Number.isFinite(n) ? n : null;
}

// Unidades que, coladas a um número, indicam que ele NÃO é preço
// (prazo/quantidade/dosagem/distância). Ex.: "40 minutos", "20 comp", "500mg".
const NON_PRICE_UNIT = /^\s*(?:min\b|minuto|hora|\bh\b|dia|semana|km|kg|mg|ml|mcg|g\b|%|comp|comprimid|caps|c[aá]psul|cp\b|un\b|unid|cx\b|caixa|amp\b|frasco|und)/i;

function sane(n: number | null): number | null {
  return n != null && n >= 1 && n <= 9999 ? n : null;
}

/**
 * Extrai um preço em R$ de um texto cru da farmácia. Conservador: em caso de
 * ambiguidade (múltiplos candidatos divergentes) devolve `null` — melhor deixar
 * a cotação cair no timeout do que gravar um preço errado.
 *
 * Estratégia em 3 níveis, do mais confiável ao menos:
 *   1. Prefixado por "R$"  → "R$ 65,00", "r$65"
 *   2. Decimal (NN,NN)     → "65,00" (forte sinal de dinheiro), exceto colado a unidade
 *   3. Inteiro com palavra monetária → "fica 12 reais", "custa 12", "sai por 18", "por 65"
 */
export function extractPriceBRL(text: string | null | undefined): number | null {
  if (!text) return null;
  const t = ` ${text.toLowerCase()} `;

  const uniqueOrNull = (cands: number[]): number | null => {
    const uniq = [...new Set(cands)];
    return uniq.length === 1 ? (uniq[0] as number) : null;
  };

  // 1) R$-prefixado (mais confiável)
  const r1: number[] = [];
  for (const m of t.matchAll(/r\$\s*(\d{1,4}(?:\.\d{3})*(?:,\d{2})?|\d{1,4}(?:\.\d{2})?)/g)) {
    const n = sane(brNumberToFloat(m[1] as string));
    if (n != null) r1.push(n);
  }
  if (r1.length) return uniqueOrNull(r1);

  // 2) Decimal solto (NN,NN ou NN.NN) — não colado a unidade não-preço.
  const r2: number[] = [];
  for (const m of t.matchAll(/(?<![\d.,])(\d{1,4}(?:\.\d{3})*,\d{2}|\d{1,4}\.\d{2})(?![\d])/g)) {
    const idx = (m.index ?? 0) + m[0].length;
    if (NON_PRICE_UNIT.test(t.slice(idx, idx + 14))) continue;
    const n = sane(brNumberToFloat(m[1] as string));
    if (n != null) r2.push(n);
  }
  if (r2.length) return uniqueOrNull(r2);

  // 3) Inteiro com sinal monetário INEQUÍVOCO (evita capturar prazo/quantidade/telefone).
  // NÃO usa gatilhos fracos como "é/são/por" — casavam telefone ("meu whats é 62 9...")
  // e códigos ("o pedido é 1234"). Só palavras que só aparecem antes de PREÇO. Também
  // rejeita número seguido de outro grupo de dígitos (padrão de telefone).
  const r3: number[] = [];
  for (const m of t.matchAll(/(?:custa|fica|sai\s+por|fica\s+por|valor\s*(?:de|é)?|preco|pre[çc]o)\s+(?:r\$\s*)?(\d{1,4})(?![.,]?\d)(?!\s+\d)/g)) {
    const idx = (m.index ?? 0) + m[0].length;
    if (NON_PRICE_UNIT.test(t.slice(idx, idx + 14))) continue;
    const n = sane(brNumberToFloat(m[1] as string));
    if (n != null) r3.push(n);
  }
  // 3b. número SEGUIDO de "reais"/"real"/"pila": "12 reais", "8 real"
  for (const m of t.matchAll(/(\d{1,4})\s*(?:reais|real|pila|pilas|conto|contos)\b/g)) {
    const n = sane(brNumberToFloat(m[1] as string));
    if (n != null) r3.push(n);
  }
  if (r3.length) return uniqueOrNull(r3);

  return null;
}

/**
 * Nº de comprimidos/unidades declarado num texto ("caixa com 20 comp" → 20,
 * "30 comprimidos" → 30). Usado pra detectar substituição de apresentação.
 * Retorna null se não achar um número seguido de unidade de contagem.
 */
export function parseUnitCount(text: string | null | undefined): number | null {
  if (!text) return null;
  const m = fold(text).match(/(\d{1,4})\s*(?:comp\b|comprimid|caps\b|capsul|cp\b|drageas?|unid|und\b|un\b)/);
  if (!m) return null;
  const n = parseInt(m[1] as string, 10);
  return Number.isFinite(n) && n > 0 && n <= 9999 ? n : null;
}

// ─── Resolução da escolha do usuário (Fix #1, confirm) ───────────────────────

export interface QuoteOption {
  option: number;
  quote_id: string;
  supplier_name?: string | null;
  total?: number | null;
  eta_minutes?: number | null;
}

/** Palavras genéricas de nome de farmácia — descartadas ao casar nome da opção. */
const GENERIC_PHARMACY_WORDS = new Set([
  'farmacia', 'farmacias', 'drogaria', 'drogarias', 'droga', 'drogas', 'rede', 'popular',
  'saude', 'de', 'da', 'do', 'dos', 'das', 'e', 'a', 'o', 'jd', 'jardim', 'setor', 'st',
  'centro', 'sul', 'norte', 'leste', 'oeste', 'com', 'mais',
]);

// Negação/cancelamento — se presente, a mensagem NÃO é aceite nem escolha (evita
// fechar uma RECUSA como "não quero"/"não a 1, quero a 3"). Conservador de propósito.
const NEGATION_RE = /(^|\s)(n[ãa]o|nao|nem|jamais|nunca|cancela|cancelar|desist|deixa pra la|esquece)(\s|$)/;
// Substantivo de quantidade/unidade colado a um número → o número é QUANTIDADE, não
// opção ("a 2 caixas", "1 unidade", "na 2 via da receita", "20 comp"). Bloqueia o
// caminho por-número da escolha (nome/superlativo continuam válidos).
const QTY_UNIT_RE = /\b\d{1,4}\s*(caixa|caixas|comp\b|comprimid|cartela|unidade|unidades|unid\b|un\b|via|vias|frasco|frascos|ampola|ampolas|mg|ml|g\b|gota|gotas|dose|doses)/;
// Palavras que sinalizam RESPOSTA A DADO da farmácia (plano/receita/marca) — não aceite.
const DATA_ANSWER_RE = /\b(generico|gen[eé]rico|similar|de refer[eê]ncia|particular|conv[eê]nio|convenio|unimed|amil|bradesco|hapvida|sulam[eé]rica|geap|plano|receita|marca|cpf)\b/;

/**
 * O texto do usuário é um ACEITE VERBAL inequívoco de uma cotação (quer FECHAR)?
 *
 * SÓ sinais verbais claros (aceito/quero/pode ser/prefiro/fecha/superlativo/sim curto).
 * NÃO conta número solto ("2") nem "a N" — esses são resolvidos por resolveQuotePick e
 * só fecham quando NÃO há pergunta pendente (senão "2" pode ser resposta a "quantas
 * caixas?"). Devolve false em negação e em resposta-a-dado (generico/plano/receita).
 */
export function isOrderAcceptance(text: string | null | undefined): boolean {
  if (!text) return false;
  const raw = text.trim();
  const t = fold(raw);
  if (NEGATION_RE.test(t)) return false;
  // PERGUNTA (termina em "?") NÃO é aceite ("aceita cartão?", "qual a mais barata?").
  if (/\?\s*$/.test(raw)) return false;
  // ADIAMENTO/CONSIDERAÇÃO NÃO é aceite (review HIGH: "quero pensar", "prefiro esperar",
  // "quero ver outras opções", "pode fechar amanhã").
  if (/\b(pensar|esperar|aguardar|olhar|depois|mais tarde|amanha|semana que vem|outro dia|calma|ver (outr|mais|as op|as cot))\b/.test(t)) return false;
  // Resposta a dado (generico/plano/receita/marca) NÃO é aceite — a menos que traga
  // um verbo de fechamento explícito ("aceito o genérico", "fecha assim mesmo").
  if (DATA_ANSWER_RE.test(t) && !/\b(aceito|fecha|fechar|confirmo|quero fechar|pode fechar)\b/.test(t)) return false;
  // Só verbos INEQUÍVOCOS de aceite em 1ª pessoa. "aceita"/"confirma" (3ª pessoa/pergunta)
  // ficam FORA — "aceita cartão?"/"confirma o endereço" não são aceites. "quero"/"prefiro"
  // com lookahead pra não casar consideração.
  const acceptRe =
    /\b(aceito|quero(?!\s+(saber|pensar|ver|olhar|esperar|aguardar))|pode ser|pode seguir|pode fechar|fecha|fechar|fechou|fechado|manda ver|confirmo|prefiro(?!\s+(esperar|aguardar|pensar|ver|nao|não))|essa mesma?|esse mesmo)\b/;
  const superlative = /\b(a mais barata|mais barat|mais em conta|a mais rapida|mais rapid|a primeira|a segunda|a terceira)\b/;
  const shortYes = /^(sim|ok|okay|isso|isso mesmo|blz|beleza|show|perfeito|bora|pode|pode sim|quero sim|fechou|👍|✅)[\s!.]*$/;
  return acceptRe.test(t) || superlative.test(t) || shortYes.test(t);
}

/** Palavra distintiva mais longa de um nome de farmácia (pra casar por nome). */
function distinctiveWords(name: string): string[] {
  return fold(name)
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !GENERIC_PHARMACY_WORDS.has(w));
}

/**
 * Resolve qual `quote_id` o usuário escolheu, a partir do texto e das opções
 * apresentadas (orders.summary.options). MUITO conservador — devolve null em
 * qualquer ambiguidade (é o gate de uma COMPRA real):
 *   - negação presente → null (não fecha recusa);
 *   - número colado a substantivo de quantidade → ignora número (é quantidade);
 *   - >1 número de opção distinto na frase → null (ambíguo);
 *   - nome casa 0 ou >1 opção → null.
 *
 * Ordem: número da opção → nome da farmácia → superlativo → aceite verbal c/ 1 opção.
 */
export function resolveQuotePick(options: QuoteOption[], text: string | null | undefined): string | null {
  if (!options?.length || !text) return null;
  const t = fold(text);
  if (NEGATION_RE.test(t)) return null;

  const hasQtyNoun = QTY_UNIT_RE.test(t);

  // 1) NÚMERO da opção — só quando NÃO há substantivo de quantidade confundindo.
  //    Aceita: msg isolada ("2", "a 1"), "opção N"/"número N" explícito, ou verbo de
  //    escolha + N ("quero a 2", "prefiro a 3"). Se houver >1 número de opção distinto
  //    na frase (ex.: "a 1 ou a 2"), é ambíguo → null.
  if (!hasQtyNoun) {
    const ordinal: Record<string, number> = { primeira: 1, segunda: 2, terceira: 3, primeiro: 1, segundo: 2, terceiro: 3 };
    let num: number | null = null;
    const iso = t.match(/^\s*(?:a\s+|op[çc][aã]o\s*|n[uú]mero\s*|n[°º]\s*)?([1-9])\s*$/);
    const explicit = t.match(/\b(?:op[çc][aã]o|n[uú]mero|n[°º])\s*([1-9])\b/);
    const verbNum = t.match(/\b(?:quero|prefiro|escolho|fico com|vou de|pode ser)\s+(?:a\s+)?([1-9])\b/);
    if (iso) num = parseInt(iso[1] as string, 10);
    else if (explicit) num = parseInt(explicit[1] as string, 10);
    else if (verbNum) num = parseInt(verbNum[1] as string, 10);
    else for (const [word, n] of Object.entries(ordinal)) if (t.includes(word)) { num = n; break; }

    if (num != null) {
      // Ambiguidade: se há OUTRO número no range das opções, não arrisca.
      const distinct = new Set([...t.matchAll(/\b([1-9])\b/g)].map((m) => parseInt(m[1] as string, 10)).filter((d) => d <= options.length));
      if (distinct.size > 1) return null;
      const opt = options.find((o) => o.option === num);
      return opt ? opt.quote_id : null; // fora do range → null (não fecha errado)
    }
  }

  // 2) NOME da farmácia: casa por palavra distintiva. Exatamente 1 opção casando → ela.
  const nameMatches = options.filter((o) => {
    const words = distinctiveWords(o.supplier_name ?? '');
    return words.some((w) => t.includes(w));
  });
  if (nameMatches.length === 1) return (nameMatches[0] as QuoteOption).quote_id;
  if (nameMatches.length > 1) return null; // ambíguo

  // 3) SUPERLATIVO: "a mais barata" → menor total; "a mais rápida" → menor eta.
  if (/mais barat|mais em conta|menor pre[çc]o|a barata/.test(t)) {
    const withPrice = options.filter((o) => typeof o.total === 'number');
    if (withPrice.length) return withPrice.reduce((a, b) => ((a.total as number) <= (b.total as number) ? a : b)).quote_id;
  }
  if (/mais rapid|mais rápida|entrega antes|chega antes|mais rapido/.test(t)) {
    const withEta = options.filter((o) => typeof o.eta_minutes === 'number');
    if (withEta.length) return withEta.reduce((a, b) => ((a.eta_minutes as number) <= (b.eta_minutes as number) ? a : b)).quote_id;
  }

  // 4) ACEITE VERBAL ("aceito", "pode ser", "sim") com UMA opção só → ela.
  if (options.length === 1 && isOrderAcceptance(text)) return (options[0] as QuoteOption).quote_id;

  return null;
}
