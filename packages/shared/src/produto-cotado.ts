/**
 * O QUE A FARMÁCIA DISSE QUE TEM — como dado, não como texto (caso Ludmila, 10/09/2026).
 *
 * A cotação guardava preço, frete e forma de pagamento; nunca o PRODUTO. Quando a Drogaria
 * Coimbra respondeu "só estou tendo o Venaflon, concorrente do Daflon" e "a cx com 30 cpr 64.90",
 * a Xarlote registrou R$ 64,90 e apresentou "Drogaria Coimbra — R$ 64,90" à paciente. Ela
 * perguntou na lata: *"é o daflon flex 1000mg com 30 envelopes por esse valor?"* — e o modelo,
 * que só via um número, respondeu **"Sim"**. Era outro remédio, em outra apresentação.
 *
 * A partir daqui toda cotação carrega `ProdutoCotado[]` em `quotes.items_available`: o que foi
 * pedido, o que a farmácia disse que tem, se é substituto e de onde essa informação veio. A
 * apresentação ao paciente, o bloco de estado no prompt e a guarda de afirmação leem DAQUI.
 * Preço sem produto é "preço de algo que a farmácia não nomeou" — e é dito assim.
 */

export type FonteDoProduto = 'agente' | 'auto_captura' | 'texto_da_farmacia' | 'reparo_manual';

export interface ProdutoCotado {
  /** O que o pedido pedia (nome como veio do paciente/receita). */
  pedido: string;
  /** O que a farmácia DISSE que tem, como ela disse. null = ela não nomeou. */
  cotado: string | null;
  /** É outro produto (similar/genérico/concorrente)? null = não dá pra saber. */
  substituto: boolean | null;
  /** Apresentação dita pela farmácia ("30 comprimidos", "30 envelopes"), se disse. */
  apresentacao: string | null;
  fonte: FonteDoProduto;
  /** ISO de quando foi registrado. */
  em: string;
}

const STOP = new Set([
  'de', 'do', 'da', 'dos', 'das', 'com', 'sem', 'para', 'pra', 'o', 'a', 'os', 'as', 'um', 'uma', 'e', 'ou',
  'comprimido', 'comprimidos', 'cp', 'cpr', 'cps', 'comp', 'caixa', 'cx', 'caixas', 'envelope', 'envelopes',
  'sache', 'saches', 'gotas', 'xarope', 'capsula', 'capsulas', 'ampola', 'ampolas', 'frasco', 'frascos',
  'pomada', 'creme', 'gel', 'spray', 'solucao', 'suspensao', 'injetavel', 'oral', 'uso', 'unidade', 'unidades',
  'generico', 'similar', 'referencia', 'marca', 'original', 'mg', 'ml', 'g', 'mcg', 'ui', 'kg',
]);

function fold(s: string): string {
  return (s ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

/** Tokens de NOME (sem dose, quantidade, forma, stopwords), acento-insensíveis. */
export function tokensDeNome(nome: string | null | undefined): string[] {
  return fold(nome ?? '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 2)
    .filter((t) => !/^\d+([.,]\d+)?(mg|mcg|g|ml|ui|%)?$/.test(t))
    .filter((t) => !STOP.has(t));
}

/** O token que identifica o remédio (marca/princípio): o primeiro token de nome. */
export function tokenPrincipal(nome: string | null | undefined): string | null {
  return tokensDeNome(nome)[0] ?? null;
}

export function montarProdutoCotado(p: {
  pedido: string;
  cotado?: string | null;
  substituto?: boolean | null;
  apresentacao?: string | null;
  fonte: FonteDoProduto;
  agora?: Date;
}): ProdutoCotado {
  const cotado = (p.cotado ?? '').trim() || null;
  // Substituto: o que o agente/detector disse; se ninguém disse, decide pelo NOME quando há
  // nome (Daflon ≠ Venaflon); sem nome, não dá pra saber (null — nunca "false" por omissão).
  let substituto: boolean | null = p.substituto ?? null;
  if (substituto == null && cotado) substituto = ehSubstitutoPeloNome(p.pedido, cotado);
  return {
    pedido: p.pedido,
    cotado,
    substituto,
    apresentacao: (p.apresentacao ?? '').trim() || null,
    fonte: p.fonte,
    em: (p.agora ?? new Date()).toISOString(),
  };
}

/**
 * O nome cotado é OUTRO produto? Compara o token principal (Daflon × Venaflon). "genérico"/
 * "similar" no cotado também conta. Sem token em algum dos lados → null (não afirma nada).
 */
export function ehSubstitutoPeloNome(pedido: string, cotado: string): boolean | null {
  const f = fold(cotado);
  if (/\b(generico|similar|concorrente|equivalente|parecido)\b/.test(f)) return true;
  const a = tokenPrincipal(pedido);
  const b = tokenPrincipal(cotado);
  if (!a || !b) return null;
  return a !== b;
}

/**
 * A farmácia OFERECEU um substituto no texto dela? ("só tenho o Venaflon", "tem o genérico",
 * "concorrente do Daflon", "similar"). Devolve o nome quando dá pra extrair.
 *
 * Conservador de propósito: só sinaliza com palavra de substituição explícita OU com "só
 * tenho/temos X" onde X não é o remédio pedido. "temos sim" / "tenho o Daflon" NÃO é substituto.
 */
export function detectarSubstitutoOferecido(
  textoDaFarmacia: string | null | undefined,
  nomePedido: string,
): { substituto: boolean; nome: string | null } {
  const raw = (textoDaFarmacia ?? '').trim();
  if (!raw) return { substituto: false, nome: null };
  const f = fold(raw);
  const pedido = tokenPrincipal(nomePedido);

  // 1) "só tenho/temos/tem/estou tendo/trabalho com (o|a) X"
  const so = /\b(?:so|apenas|somente)\s+(?:tenho|temos|tem|estou\s+tendo|to\s+tendo|trabalho\s+com|trabalhamos\s+com)\s+(?:o|a|os|as)?\s*([a-z][a-z0-9-]{2,}(?:\s+[a-z0-9-]{2,}){0,2})/.exec(f);
  if (so?.[1]) {
    const nomeTok = tokensDeNome(so[1])[0] ?? null;
    if (nomeTok && nomeTok !== pedido) {
      return { substituto: true, nome: nomeOriginal(raw, nomeTok) };
    }
  }
  // 2) palavra de substituição explícita
  if (/\b(concorrente|similar|generico|genericos|equivalente|no\s+lugar\s+d[oa]|em\s+vez\s+d[oa]|parecido)\b/.test(f)) {
    // tenta um nome próprio ANTES da palavra ("Venaflon concorrente do Daflon")
    const antes = /([a-z][a-z0-9-]{3,})\s*,?\s*(?:e\s+o\s+|que\s+e\s+o\s+|o\s+)?(?:concorrente|similar|generico|equivalente)\b/.exec(f);
    const tok = antes?.[1] && tokensDeNome(antes[1])[0];
    const nome = tok && tok !== pedido && !/^(tenho|temos|tem|tendo|estou|um|uma|o|a)$/.test(tok) ? nomeOriginal(raw, tok) : null;
    return { substituto: true, nome };
  }
  return { substituto: false, nome: null };
}

/** Recupera a grafia ORIGINAL (com acento/maiúscula) do token achado na forma dobrada. */
function nomeOriginal(raw: string, tokenDobrado: string): string {
  for (const w of raw.split(/[\s,.;:!?()]+/)) {
    if (w && fold(w).replace(/[^a-z0-9-]/g, '') === tokenDobrado) return w;
  }
  return tokenDobrado.charAt(0).toUpperCase() + tokenDobrado.slice(1);
}

/** A linha do produto na oferta ao paciente — honesta sobre o que se sabe e o que não se sabe. */
export function linhaDoProduto(pc: ProdutoCotado | null | undefined): string {
  if (!pc) return '(a farmácia não confirmou o produto)';
  if (pc.substituto === true) {
    if (pc.cotado) return `⚠️ ${pc.cotado}${pc.apresentacao ? ` (${pc.apresentacao})` : ''} — similar, não é o ${pc.pedido}`;
    return `⚠️ um similar (a farmácia não tem o ${pc.pedido})`;
  }
  if (pc.cotado) return `${pc.cotado}${pc.apresentacao ? ` (${pc.apresentacao})` : ''}`;
  return '(a farmácia não confirmou o produto)';
}

/**
 * O paciente perguntou "é o X?" — a cotação PROVA que é? 'sim' só com nome cotado, não
 * substituto e o token de X presente no cotado. 'nao' quando é substituto ou o nome bate
 * outro remédio. 'nao_sei' quando a farmácia não nomeou o produto.
 */
export function podeAfirmarQueEh(nomePerguntado: string, pc: ProdutoCotado | null | undefined): 'sim' | 'nao' | 'nao_sei' {
  const tok = tokenPrincipal(nomePerguntado);
  if (!tok) return 'nao_sei';
  if (!pc || !pc.cotado) return pc?.substituto === true ? 'nao' : 'nao_sei';
  if (pc.substituto === true) return 'nao';
  return tokensDeNome(pc.cotado).includes(tok) ? 'sim' : 'nao';
}

/**
 * GUARDA DE AFIRMAÇÃO DE PRODUTO (lado da paciente). Relê o que a Xarlote vai dizer: uma
 * afirmação "sim, é o Daflon Flex…" só passa se a cotação prova. Devolve a frase corrigida
 * quando a afirmação não tem prova — mesma filosofia do claim-guard (anúncio sem prova cai).
 */
export function afirmacaoDeProdutoSemProva(
  textoDaXarlote: string,
  cotacoes: Array<{ supplierName: string; produto: ProdutoCotado | null }>,
): { corrigido: string; motivo: string } | null {
  const t = textoDaXarlote ?? '';
  // "Sim, é o Daflon Flex 1000mg…" / "É o Daflon mesmo" / "isso, é o daflon"
  // Sem `\b` na frente: \b não conhece acento e "É o…" no início da frase nunca casaria (regra de ouro).
  const m = /(?:^|[\s,.!?])(?:sim|isso|exato|exatamente|certo|correto)?[,!.]?\s*(?:[ée]|s[ãa]o)\s+(?:o|a|os|as)\s+([A-Za-zÀ-ú][A-Za-zÀ-ú0-9-]{2,}(?:\s+[A-Za-zÀ-ú0-9-]{2,}){0,4})/i.exec(t);
  if (!m?.[1]) return null;
  // Só é afirmação de PRODUTO se começa com "sim/isso/é o" no início da frase (não "…é o valor").
  if (!/^\s*(?:sim|isso|exato|exatamente|certo|correto)?[,!.]?\s*(?:[ée]|s[ãa]o)\s+(?:o|a|os|as)\s/i.test(t)) return null;
  const tok = tokenPrincipal(m[1]);
  if (!tok) return null;
  // Alguma cotação PROVA que é esse produto? Então a afirmação é legítima.
  const provas = cotacoes.map((c) => podeAfirmarQueEh(m[1] as string, c.produto));
  if (provas.includes('sim')) return null;
  // Nenhuma prova. Monta a resposta honesta a partir do que a cotação diz.
  const primeira = cotacoes[0];
  if (!primeira) return null;
  const p = primeira.produto;
  let corrigido: string;
  if (p?.substituto === true && p.cotado) {
    corrigido = `Não é o ${p.pedido}: a ${primeira.supplierName} disse que só tem o *${p.cotado}*${p.apresentacao ? ` (${p.apresentacao})` : ''}, que é um similar. Quer que eu feche com esse, ou prefere que eu procure o ${p.pedido} mesmo?`;
  } else if (p?.substituto === true) {
    corrigido = `A ${primeira.supplierName} disse que não tem o ${p.pedido}, só um similar. Quer que eu confirme com eles qual é, ou prefere que eu procure o ${p.pedido} mesmo?`;
  } else {
    corrigido = `Ainda não posso te garantir: a ${primeira.supplierName} me passou o preço mas não confirmou o produto e a apresentação. Quer que eu confirme com eles antes de fechar?`;
  }
  return { corrigido, motivo: `afirmou "${m[0].trim().slice(0, 40)}" sem cotação que prove` };
}

/**
 * GUARDA DE ACEITE DE SUBSTITUTO (lado da farmácia). O agente escreveu "Venaflon serve sim"
 * sem a paciente ter dito que aceita similar. Se nenhum item do pedido tem `substitutes_ok`
 * = true, a frase de aceite vira "vou confirmar" — a decisão volta pra quem decide.
 */
export function consertarAceiteDeSubstituto(
  textoDoAgente: string,
  itens: Array<{ substitutes_ok?: boolean | null }>,
): { texto: string; corrigiu: boolean } {
  const t = textoDoAgente ?? '';
  const algumAceita = itens.some((i) => i.substitutes_ok === true);
  if (algumAceita || !t.trim()) return { texto: t, corrigiu: false };
  const f = fold(t);
  const aceite = /\bserve\s+sim\b|\bpode\s+ser\s+(?:o|a|esse|essa|ele|ela)?\s*(?:generico|similar|concorrente|mesmo)?\b(?!\s*\?)|\baceito\s+(?:o|a)?\s*(?:generico|similar)\b|\b(?:fechado|beleza|tranquilo|tudo\s+bem|ok)\s*,?\s*(?:pode\s+ser\s+)?(?:o|a)?\s*(?:generico|similar)\b|\bo\s+(?:generico|similar)\s+(?:serve|ta\s+bom|tá\s+bom|resolve)\b/;
  if (!aceite.test(f)) return { texto: t, corrigiu: false };
  // Só corrige se a frase fala de produto/substituição (não "pode ser hoje à tarde").
  if (!/\b(generico|similar|concorrente|serve|venaflon|marca|outro|outra|no\s+lugar)\b/.test(f) && !/\bserve\s+sim\b/.test(f)) {
    return { texto: t, corrigiu: false };
  }
  return { texto: 'Deixa eu confirmar se pode ser o similar e já te falo, tá? Consegue me passar o valor e o prazo de entrega dele enquanto isso?', corrigiu: true };
}

/**
 * O PACIENTE FALOU de genérico/similar/marca? Só então um `substitutes_ok` booleano vindo do
 * modelo é honrado (teste cego 13/09: o gpt-4.1-mini preencheu `false` sozinho ao ler uma
 * receita — nada na fala da paciente dizia isso). Sem fala, o campo volta a null.
 */
export function pacienteFalouDeSubstituto(falas: Array<string | null | undefined>): boolean {
  const t = falas.map((f) => fold(f ?? '')).join(' \n ');
  return /\b(generico|genericos|similar|similares|equivalente|concorrente|outra marca|qualquer marca|tanto faz a marca|so (o|a) (original|marca|referencia)|tem que ser (o|a) (original|marca|referencia)|nao aceito (generico|similar)|nao quero (generico|similar)|pode ser (generico|similar|outro)|aceito (generico|similar))\b/.test(t);
}
