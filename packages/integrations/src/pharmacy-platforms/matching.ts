/**
 * Matching pedido↔produto. A busca `ft=` do VTEX é fuzzy e traz ruído (ex.: `ft=dipirona`
 * devolve "Kit Novalgina + Allegra" como 1º item). Aqui a gente RANQUEIA e FILTRA os
 * candidatos que a busca trouxe — nunca é a Xarlote que "adivinha": abaixo do limiar de
 * confiança, o chamador deve confirmar com o usuário em vez de cotar o produto errado.
 */
import type { PlatformProduct } from './types.js';

export interface ParsedMedication {
  raw: string;
  /** tokens do NOME do remédio (>=3 letras), sem dosagem/forma/qtd/stopwords */
  nameTokens: string[];
  /** dosagens normalizadas, ex.: ['500mg', '1g'] */
  strengths: string[];
  /** forma canônica: 'comprimido'|'gotas'|... ou null */
  form: string | null;
  /** quantidade de unidades (ex.: 30 comprimidos) ou null */
  quantity: number | null;
  /** o usuário pediu explicitamente um kit/combo? */
  wantsKit: boolean;
}

const STOPWORDS = new Set([
  'de', 'da', 'do', 'das', 'dos', 'para', 'pra', 'com', 'sem', 'e', 'o', 'a', 'os', 'as',
  'um', 'uma', 'caixa', 'cx', 'generico', 'genérico', 'remedio', 'remédio', 'medicamento',
  'por', 'favor', 'quero', 'preciso', 'comprar', 'me', 've', 'vê', 'the',
]);

const FORMS: [string, RegExp][] = [
  ['comprimido', /\b(comprimidos?|compr|cpr|cp|comp)\b/],
  ['capsula', /\b(c[áa]psulas?|caps?)\b/],
  ['gotas', /\b(gotas?|gts)\b/],
  ['xarope', /\bxarope\b/],
  ['solucao', /\b(solu[çc][ãa]o|suspens[ãa]o|susp)\b/],
  ['pomada', /\b(pomada|creme|gel|unguento)\b/],
  ['injetavel', /\b(injet[áa]vel|ampolas?|amp)\b/],
  ['adesivo', /\badesivos?\b/],
  ['sache', /\bsach[êe]s?\b/],
  ['spray', /\b(spray|aerossol)\b/],
];

const KIT_RE = /\b(kit|combo)\b|\bleve\s*\d|\+/;

export function normalize(s: string): string {
  return (s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\w\s%/.+-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Extrai dosagens (número+unidade) normalizadas de um texto: "500 mg" → "500mg". */
export function extractStrengths(text: string): string[] {
  const out = new Set<string>();
  const re = /(\d+(?:[.,]\d+)?)\s*(mg|mcg|g|ml|ui|%)\b/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    out.add(`${m[1]!.replace(',', '.')}${m[2]!.toLowerCase()}`);
  }
  return [...out];
}

/**
 * Normaliza uma dosagem para uma chave comparável convertendo massa pra mg
 * (1g = 1000mg, 88mcg = 0.088mg) — assim "1g" casa com "1000mg" e 88mcg ≠ 100mcg.
 */
export function canonStrength(s: string): string {
  const m = /^(\d+(?:\.\d+)?)(mg|mcg|g|ml|ui|%)$/.exec(s.trim().toLowerCase());
  if (!m) return s.trim().toLowerCase();
  const v = parseFloat(m[1]!);
  switch (m[2]) {
    case 'g': return `m:${v * 1000}`;
    case 'mg': return `m:${v}`;
    case 'mcg': return `m:${v / 1000}`;
    case 'ml': return `v:${v}`;
    case '%': return `p:${v}`;
    default: return `u:${v}`; // ui
  }
}

/** true se alguma dosagem de `a` é equivalente a alguma de `b` (após normalização de unidade). */
export function strengthsCompatible(a: string[], b: string[]): boolean {
  if (!a.length || !b.length) return false;
  const bc = new Set(b.map(canonStrength));
  return a.map(canonStrength).some((x) => bc.has(x));
}

function detectForm(text: string): string | null {
  for (const [canonical, re] of FORMS) if (re.test(text)) return canonical;
  return null;
}

function detectQuantity(text: string): number | null {
  const m = /(\d+)\s*(comprimidos?|c[áa]psulas?|caps?|gotas?|unidades?|un|comp|cpr?|cp)\b/i.exec(text);
  return m ? Number(m[1]) : null;
}

export function parseMedicationQuery(text: string): ParsedMedication {
  const norm = normalize(text);
  const strengths = extractStrengths(norm);
  const form = detectForm(norm);
  const quantity = detectQuantity(norm);
  const wantsKit = /\b(kit|combo)\b/.test(norm);
  // nameTokens = o que sobra depois de tirar dosagem/forma/qtd/stopwords/números soltos.
  const strengthWords = new Set(strengths.flatMap((s) => [s, s.replace(/[a-z%]+$/i, '')]));
  const nameTokens = norm
    .split(' ')
    .filter((t) => t.length >= 3)
    .filter((t) => !STOPWORDS.has(t))
    .filter((t) => !/^\d+([.,]\d+)?(mg|mcg|g|ml|ui|%)?$/i.test(t))
    .filter((t) => !strengthWords.has(t))
    .filter((t) => !FORMS.some(([, re]) => re.test(t)));
  return { raw: text, nameTokens, strengths, form, quantity, wantsKit };
}

/**
 * Score 0..1 de quão bem um produto atende ao pedido. Combina: presença do nome (peso maior),
 * casamento de dosagem, forma e quantidade; multiplica por penalidade se o produto é kit/combo
 * e o usuário não pediu. Disponibilidade dá um empurrãozinho no desempate.
 */
export function scoreProductMatch(q: ParsedMedication, product: PlatformProduct): number {
  const hay = normalize(`${product.productName} ${(product.activeIngredient ?? []).join(' ')}`);

  // NOME — obrigatório: fração dos tokens de nome presentes no produto.
  let nameFrac = 1;
  if (q.nameTokens.length > 0) {
    const present = q.nameTokens.filter((t) => hay.includes(t)).length;
    nameFrac = present / q.nameTokens.length;
  }
  if (nameFrac === 0) return 0; // nem o nome do remédio bate → não é candidato

  let score = 0.55 * nameFrac;
  let weight = 0.55;
  let penalty = 1; // penalidades MULTIPLICATIVAS (dosagem/forma divergente, kit) — derrubam o match

  // DOSAGEM — dosagem presente e DIFERENTE é grave (1g no lugar de 500mg; 100mcg no lugar
  // de 88mcg de levotiroxina). Penaliza forte, não só deixa de somar (achado H1 do review).
  if (q.strengths.length > 0) {
    weight += 0.25;
    const prodStrengths = extractStrengths(hay);
    if (strengthsCompatible(q.strengths, prodStrengths)) score += 0.25;
    else if (prodStrengths.length === 0) score += 0.08; // produto não expõe dosagem = incerto
    else penalty *= 0.28; // dosagem explícita e divergente → cai abaixo do limiar
  }

  // FORMA — comprimido × gotas × pomada são coisas diferentes: divergência penaliza.
  if (q.form) {
    weight += 0.13;
    const prodForm = detectForm(hay);
    if (prodForm === q.form) score += 0.13;
    else if (!prodForm) score += 0.05;
    else penalty *= 0.45;
  }

  // QUANTIDADE (sinal fraco — embalagem varia; só bonifica, nunca penaliza)
  if (q.quantity) {
    weight += 0.07;
    const prodQty = detectQuantity(hay);
    if (prodQty === q.quantity) score += 0.07;
    else if (prodQty == null) score += 0.03;
  }

  let normalized = weight > 0 ? score / weight : 0;

  // KIT/combo quando o usuário não pediu kit.
  if (!q.wantsKit && KIT_RE.test(normalize(product.productName))) penalty *= 0.3;

  normalized *= penalty;

  // Empurrãozinho de disponibilidade no desempate.
  if (product.availableQuantity > 0) normalized = Math.min(1, normalized + 0.02);

  return Math.max(0, Math.min(1, normalized));
}

export interface RankedMatch {
  product: PlatformProduct;
  score: number;
}

/** Ranqueia (desc) os candidatos de UMA rede e filtra os abaixo do limiar. */
export function rankProductMatches(
  query: string,
  products: PlatformProduct[],
  opts: { minScore?: number } = {},
): RankedMatch[] {
  const q = parseMedicationQuery(query);
  const minScore = opts.minScore ?? 0.5;
  return products
    .map((product) => ({ product, score: scoreProductMatch(q, product) }))
    .filter((r) => r.score >= minScore)
    .sort((a, b) => b.score - a.score);
}
