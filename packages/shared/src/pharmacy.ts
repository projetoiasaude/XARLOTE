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

// ─── Troca de medicamento (product-switch) ───────────────────────────────────
// Palavras que NÃO discriminam o medicamento (dosagem, apresentação, quantidade,
// conectivos) — removidas antes de comparar dois pedidos. Ficam só os tokens
// "cabeça" (o nome real da droga: pietra, cefaliv, dorflex…).
const MED_NOISE = new Set<string>([
  'mg', 'mcg', 'ml', 'g', 'ui', 'un', 'und', 'unid', 'unidade', 'unidades',
  'caixa', 'caixas', 'cx', 'comp', 'comprimido', 'comprimidos', 'cp', 'cps',
  'capsula', 'capsulas', 'caps', 'drageas', 'dragea', 'frasco', 'frascos',
  'ampola', 'ampolas', 'sache', 'saches', 'gotas', 'spray', 'pomada', 'creme',
  'xarope', 'solucao', 'suspensao', 'de', 'do', 'da', 'com', 'sem', 'e', 'ed',
  'generico', 'generica', 'marca', 'ref', 'similar',
]);

// Palavras de CLASSE/veículo/sal/fabricante — genéricas demais pra discriminar UM
// medicamento sozinhas. Dois produtos TOTALMENTE diferentes podem compartilhá-las
// ("cloridrato de metformina" ≠ "cloridrato de sertralina"; "Vitamina D" ≠
// "Vitamina C"). Removidas dos tokens-cabeça pra não gerar falso "mesmo" (review
// Cefaliv: senão a troca entre vitaminas/ácidos/sais reabre o delírio). O
// discriminador real (metformina, ferroso) sobrevive; pra vitamina, o designador
// (C/D/D3/B12) é capturado à parte em medHeadTokens.
const MED_CLASS = new Set<string>([
  'vitamina', 'vitaminas', 'vit', 'acido', 'sulfato', 'cloridrato', 'maleato',
  'besilato', 'mesilato', 'valerato', 'dipropionato', 'fosfato', 'nitrato',
  'bromidrato', 'oleo', 'soro', 'colageno', 'complexo', 'composto', 'sais',
  'sabonete', 'shampoo', 'xampu', 'oral', 'infantil', 'adulto', 'pediatrico',
  'forte', 'plus', 'max', 'flex',
  // fabricantes (aparecem no nome mas não discriminam a droga)
  'neo', 'quimica', 'medley', 'eurofarma', 'cimed', 'germed', 'sandoz', 'ache',
  'biosintetica', 'prati', 'donaduzzi', 'geolab', 'nova',
]);

/**
 * Tokens "cabeça" (nome real da droga) de um item — sem acento, sem ruído, sem
 * palavra de classe/veículo, sem números puros. Extra: captura o designador de
 * vitamina ("Vitamina C" → `vit:c`, "Vitamina D3" → `vit:d3`, "Vitamina B12" →
 * `vit:b12`) como token FORTE, pois "vitamina" vira classe e o designador (C/D)
 * sozinho seria curto demais e cairia fora.
 */
function medHeadTokens(name: string | null | undefined): Set<string> {
  const out = new Set<string>();
  if (!name) return out;
  const folded = fold(name);
  // Designador de vitamina: "vitamina d", "vit c", "vitamina b12", "vitamina d3", "vitamina k2".
  const vit = folded.match(/\bvit(?:amina)?\s*([a-k])\s?(\d{0,2})\b/);
  if (vit) out.add(`vit:${vit[1]}${vit[2] ?? ''}`);
  for (const raw of folded.replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)) {
    if (raw.length < 3) continue;        // "ed", designadores curtos (já capturados acima)
    if (MED_NOISE.has(raw)) continue;
    if (MED_CLASS.has(raw)) continue;    // classe/veículo/sal/fabricante — não discrimina
    if (/^\d/.test(raw)) continue;       // "500", "30", "2mg", "1g" → dose/quantidade
    out.add(raw);
  }
  return out;
}

/**
 * Dois conjuntos de itens são o MESMO medicamento? (ex.: "Pietra 2mg" ≡ "Pietra ED").
 *
 * Usado pela trava de idempotência do start_pharmacy_order pra decidir entre
 * "re-pedido do mesmo produto" (não reiniciar) vs "TROCA de produto" (cancelar o
 * ativo e abrir o novo — incidente Cefaliv 06/07: usuário largou o Pietra e quis o
 * Cefaliv, e a Xarlote ficava presa mostrando as cotações velhas).
 *
 * Regra: se os nomes compartilham QUALQUER token-cabeça discriminável → mesmo
 * medicamento. Na dúvida (algum lado sem token discriminável) → devolve TRUE
 * (mesmo) — nunca cancela um pedido ativo por engano; a troca explícita fica com
 * cancel_order. Limitação conhecida: marca vs molécula da MESMA droga (Tylenol vs
 * Paracetamol) dá tokens disjuntos → tratado como TROCA (re-cota; recuperável).
 */
export function sameMedication(
  a: ReadonlyArray<{ name?: string | null }> | null | undefined,
  b: ReadonlyArray<{ name?: string | null }> | null | undefined,
): boolean {
  const ta = new Set<string>();
  for (const it of a ?? []) for (const t of medHeadTokens(it?.name)) ta.add(t);
  const tb = new Set<string>();
  for (const it of b ?? []) for (const t of medHeadTokens(it?.name)) tb.add(t);
  if (ta.size === 0 || tb.size === 0) return true; // incerto → trata como MESMO (seguro)
  for (const t of ta) if (tb.has(t)) return true;  // interseção → mesmo medicamento
  return false;
}

// ─── Tom humano com a farmácia (polimento 07/07) ─────────────────────────────

/**
 * Encurta o endereço geocodado pra mandar à farmácia. O geocoder devolve coisas
 * como "Rua Ema 5, Recanto das Emas, Goiânia, Goiás, Região Centro-Oeste, 74393-376,
 * Brasil" — ninguém escreve "Região Centro-Oeste, Brasil". Tira o nível de
 * macro-região e o país, mantendo rua/bairro/cidade/UF/CEP (o que a farmácia usa
 * pra calcular frete e entregar).
 */
export function shortSupplierAddress(addr: string | null | undefined): string {
  if (!addr) return '';
  return addr
    .replace(/,?\s*Regi[ãa]o\s+(Norte|Nordeste|Centro-Oeste|Sudeste|Sul)\b/gi, '')
    .replace(/,?\s*Brasil\b/gi, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/(?:,\s*){2,}/g, ', ')
    .replace(/,\s*$/, '')
    .trim();
}

/**
 * A farmácia disse que a entrega é GRÁTIS/cortesia? (pra não re-perguntar o frete
 * quando ela já avisou — incidente Droga Mauge 07/07). Acento-insensível.
 * Cuidado: "cobramos taxa de 7,90" NÃO é grátis (não casa "nao cobr" nem "gratis").
 */
export function mentionsFreeShipping(text: string | null | undefined): boolean {
  if (!text) return false;
  const t = fold(text);

  // Sinais POSITIVOS de entrega sem custo. "por conta" só conta com "nossa"/"da casa"
  // ("por conta do cliente" = o cliente paga, NÃO é grátis). "incluso" só p/ frete/entrega.
  const freePos = /\b(gratis|gratuit\w*|cortesia|free)\b|\bsem\s+(frete|taxa|custo)\b|\bde\s+gra[çc]a\b|\bpor\s+nossa\s+conta\b|\bpor\s+conta\s+da\s+(casa|loja|farmacia)\b|\b(frete|entrega)\b[^.!?\n]{0,12}\binclus[oa]\b|\bnao\s+cobr\w*\s+(o\s+|a\s+)?(frete|taxa|entrega|nada)\b|\bnao\s+paga\s+nada\b/;
  if (!freePos.test(t)) return false;

  // "sem frete grátis" = literalmente NÃO tem grátis (inversão semântica). (F1)
  if (/\bsem\s+frete\s+gratis\b/.test(t)) return false;

  // NEGAÇÃO perto do termo (antes OU depois): "não temos frete grátis", "frete
  // grátis? não temos", "não é grátis", "frete não incluso". (F2) — a janela cruza
  // "?" (mesma frase) mas NÃO "." ou "!" (frase nova).
  const term = '(gratis|gratuit|cortesia|free|de\\s+gra[çc]a|inclus)';
  if (new RegExp(`\\bnao\\b[^.!\\n]{0,25}${term}`).test(t)) return false;
  if (new RegExp(`${term}[^.!\\n]{0,20}\\bnao\\b`).test(t)) return false;

  // Frete grátis CONDICIONAL ("grátis acima de 100", "a partir de", "só pra CEP X",
  // "mínimo de") → NÃO é grátis pro pedido; trata como desconhecido (confirma o valor). (F1)
  const cond = '(acima|a partir|compras?\\s+de|apenas|somente|\\bso\\b|minim\\w+|pra\\s+cep|para\\s+cep)';
  if (new RegExp(`(gratis|gratuit|free)[^.!?\\n]{0,30}${cond}`).test(t)) return false;
  if (new RegExp(`${cond}[^.!?\\n]{0,30}(gratis|gratuit|free)`).test(t)) return false;

  return true;
}

/**
 * Nome do item pra exibição SEM repetir a dosagem quando ela já está no nome
 * (ex.: name="Pietra ED 2mg" + dosage="2mg" → "Pietra ED 2mg", não "Pietra ED 2mg 2mg").
 */
export function itemDisplayName(name: string | null | undefined, dosage?: string | null): string {
  const n = (name ?? '').trim();
  const d = (dosage ?? '').trim();
  if (!d) return n;
  if (fold(n).includes(fold(d))) return n;
  return `${n} ${d}`.trim();
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
    /\b(aceito|quero(?!\s+(saber|pensar|ver|olhar|esperar|aguardar))|pode ser|pode seguir|pode fechar|pode entregar|fecha|fechar|fechou|fechado|manda ver|confirmo|prefiro(?!\s+(esperar|aguardar|pensar|ver|nao|não))|essa mesma?|esse mesmo)\b/;
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
    const explicit = t.match(/\b(?:op[çc][aã]o|n[uú]mero|n[°º]|farm[aá]cia|drogaria)\s*([1-9])\b/);
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

  // 4) ACEITE VERBAL ("aceito", "pode ser", "sim") com UMA opção só → ela. `!hasQtyNoun`
  // barra "pode entregar 2 caixas" e afins (número de quantidade não é escolha).
  if (options.length === 1 && !hasQtyNoun && isOrderAcceptance(text)) return (options[0] as QuoteOption).quote_id;

  return null;
}

// ─── Re-engajamento dirigido: resolver farmácia por dica + sanitizar nota ─────

/** Candidato de farmácia dentro de um pedido, pra re-contato dirigido (message_supplier). */
export interface SupplierCandidate {
  quote_id: string;
  supplier_name?: string | null;
  /** pending|contacting|negotiating|quoted|unavailable|timeout */
  status?: string | null;
  /** Deu qualquer resposta substantiva (cotou um preço OU disse algo registrado em notes). */
  responded?: boolean;
}

/**
 * Resolve QUAL farmácia de um pedido o usuário quer re-contatar, a partir de uma dica
 * em texto ("volta na São Benedito", "fala com a que tem o remédio", "a que respondeu").
 * Conservador — devolve null em ambiguidade (é um envio real a um fornecedor):
 *   - nome distintivo casando EXATAMENTE 1 → ela;
 *   - >1 nome casando → null (ambíguo);
 *   - 0 nome + dica semântica ("a que tem/respondeu", "a única", "aquela") + EXATAMENTE
 *     1 respondente → ela.
 */
export function resolveSupplierByHint(
  candidates: SupplierCandidate[],
  hint: string | null | undefined,
): string | null {
  if (!candidates?.length || !hint) return null;
  const t = fold(hint);
  // Negação/exclusão → não mira ninguém (paridade com resolveQuotePick/isOrderAcceptance):
  // "não fala com a X", "qualquer uma menos a X" não podem virar um envio À X (review LOW).
  // NEGATION_RE cobre não/nunca/nem/cancela; "menos/exceto/tirando" são exclusão local.
  if (NEGATION_RE.test(t) || /\b(menos|exceto|tirando|sem ser)\b/.test(t)) return null;

  // 1) NOME da farmácia. Casa por PALAVRA INTEIRA (\b), não substring — senão um token
  //    curto ('sol','vida','rio') casaria dentro de palavras comuns ("re[sol]ve") e
  //    miraria a farmácia ERRADA (review MEDIUM). Nome 100% genérico (sem palavra
  //    distintiva, ex.: "Farmácia Popular") cai no fallback de FRASE inteira.
  const nameMatches = candidates.filter((c) => {
    const nm = c.supplier_name ?? '';
    const words = distinctiveWords(nm);
    if (words.length) return words.some((w) => new RegExp(`\\b${w}\\b`).test(t));
    const full = fold(nm).replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
    return full.length >= 5 && t.includes(full);
  });
  if (nameMatches.length === 1) return (nameMatches[0] as SupplierCandidate).quote_id;
  if (nameMatches.length > 1) return null;

  // 2) DICA SEMÂNTICA ("a que tem/respondeu", "a única", "aquela", "do uber") →
  //    se houver EXATAMENTE 1 respondente, é ela; senão null (não adivinha).
  // Cues ESPECÍFICOS de "aquela que respondeu/tem" — de propósito SEM "aquela"/"a que"
  // soltos (vagos demais; "aquela farmácia lá" não deve mirar ninguém).
  const semantic =
    /\b(que tem|que responde|respondeu|que tinha|dispon[ií]vel|a [uú]nica|[uú]nica que|a farm[aá]cia que|que ofereceu|do uber|o uber|essa farm[aá]cia)\b/.test(t);
  if (semantic) {
    const responders = candidates.filter((c) => c.responded);
    if (responders.length === 1) return (responders[0] as SupplierCandidate).quote_id;
  }
  return null;
}

/**
 * Limpa a nota interna de uma cotação (`quotes.notes`) pra apresentar ao usuário SEM
 * vazar marcadores internos nem links/chaves. Remove marcadores canônicos (subst:,
 * auto-capturado, "indicação de …"), tira URLs, colapsa espaço e corta em ~180 chars.
 * Devolve '' se não sobrar conteúdo útil (o caller então omite a linha).
 */
export function sanitizeSupplierNote(note: string | null | undefined): string {
  if (!note) return '';
  let s = String(note);
  s = s
    .replace(/\bsubst:\s*/gi, ' ') // tira o marcador "subst:", mantém o valor ("só tem N comp")
    .replace(/\bauto-capturado\b/gi, ' ')
    .replace(/^\s*indica[çc][aã]o de[^—\-|]*[—\-|]?/i, ' ')
    .replace(/fornecedor sem telefone real/gi, ' ') // nota interna de ops (sem número)
    .replace(/https?:\/\/\S+/gi, ' ')
    // Defense-in-depth: a nota vai por sendOutbound ao usuário — mascara telefone/CPF que
    // o LLM possa ter copiado da fala da farmácia (não vazar número/chave cru). CPF ANTES
    // do telefone (11 dígitos com pontuação de CPF não devem virar telefone).
    .replace(/\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/g, '[contato]') // CPF formatado
    .replace(/\(?\d{2}\)?[\s.-]?9?\d{4}[\s.-]?\d{4}\b/g, '[contato]') // telefone BR (10-11 díg)
    .replace(/[|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (s.length > 180) s = s.slice(0, 177).trimEnd() + '…';
  return s;
}

/**
 * Heurística: a nota de uma cotação `unavailable`/`timeout` indica que a farmácia TEM
 * o item ou OFERECEU uma alternativa (entrega condicional, retirada, Uber, indicação)?
 * Usado pra (a) marcar a cotação como "respondeu de forma útil" no relatório e (b)
 * sugerir re-engajar aquela farmácia. Conservador: só true com sinal claro.
 */
export function noteSignalsConditionalOffer(note: string | null | undefined): boolean {
  if (!note) return false;
  const t = fold(note);
  // 1) Alternativa OFERECIDA (Uber, retirada, balcão, horário, indicação) vale SEMPRE —
  //    inclusive junto de "não tenho, MAS indico X" (referral) ou "só entrego no Setor Y".
  //    PREFIXO (sem \b final) pra casar flexões: indic→indico/indica, retir→retirada,
  //    despach→despachar, s[óo] entreg→só entrega/entrego. uber/balcão são palavra inteira.
  const hasAlternative =
    /\bs[óo]\s+entreg|\bretir|\bbalc[aã]o|\buber\b|\bmotoboy|\bbuscar|\bdespach|\ba partir das|\bdepois das|\bindic|\bencaminh/.test(t);
  if (hasAlternative) return true;
  // 2) Disponibilidade positiva — mas BARRANDO negação ("não tenho", "não temos", "sem
  //    disponível"). "em estoque" fica de fora (casaria "não tem em estoque"). Sem o guard,
  //    "Não temos esse remédio" (Caso C puro) virava falso-positivo (review 07/07).
  const hasAvailability = /\b(tenho|temos|tem o |tem sim|tem aqui|dispon[ií]vel)\b/.test(t);
  if (!hasAvailability) return false;
  const negatedHave = /\b(nao|nem|sem)\b[^.;!?]{0,12}\b(tenho|temos|tem|dispon[ií]vel)/.test(t);
  return !negatedHave;
}
