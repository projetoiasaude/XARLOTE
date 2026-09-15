/**
 * NOME LIDO DE FOTO É HIPÓTESE, NÃO FATO (caso Ludmila, 10/09/2026).
 *
 * A receita manuscrita dizia *Daflon 1000 Flex, 1x ao dia*. O modelo leu "Aflor 1000 Flex,
 * 100 comprimidos", o pedido nasceu com esse nome, cinco farmácias foram acionadas com ele, as
 * grandes redes devolveram um suplemento com "Flex" no nome e link de compra, e quando a
 * farmacêutica perguntou *"Seria Daflon?"* a Xarlote respondeu *"Não, é Aflor 1000 Flex mesmo"*.
 * "Aflor" não é remédio. Ninguém checou.
 *
 * Aqui ficam as decisões PURAS: qual token identifica o remédio, se ele existe num catálogo, o
 * que fazer com cada origem (texto do paciente × foto × áudio) e como reconhecer que a farmácia
 * está sugerindo outro nome. Quem consulta o catálogo (rede VTEX, cache) é o handler.
 */

import { tokenPrincipal, tokensDeNome } from './produto-cotado.js';

export type OrigemDoNome = 'texto' | 'foto' | 'audio';

function fold(s: string): string {
  return (s ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

/**
 * Prefixos que vêm ANTES da marca/princípio no nome de catálogo e não são o nome:
 * sal ("Cloridrato de Metformina"), categoria ("Suplemento Alimentar Neutrofer", "Antialérgico
 * Allegra D"), embalagem ("Kit"). Removidos antes de olhar a posição do token.
 */
const PREFIXOS_DE_CATALOGO = /^(?:(?:cloridrato|sulfato|maleato|succinato|besilato|bromidrato|fosfato|citrato|valerato|hemifumarato|fumarato|mesilato|dipropionato|acetato|nitrato|tartarato|dicloridrato|sodio|potassio|calcio|glicinato)\s+(?:de\s+|ferrico\s+|ferroso\s+)?|(?:suplemento|complemento)\s+(?:alimentar|nutricional|vitaminico)\s+|(?:antialergico|analgesico|antibiotico|anti-?inflamatorio|antitermico|antiacido|anticoncepcional|medicamento|remedio|kit|generico)\s+)+/;

/** Tokens de um nome de produto, sem stopwords, depois de tirar os prefixos de catálogo. */
function tokensDeCatalogo(nome: string): string[] {
  return fold(nome)
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(PREFIXOS_DE_CATALOGO, '')
    .split(' ')
    .filter((t) => t && !['de', 'da', 'do', 'com', 'e', 'a', 'o', 'em', 'para'].includes(t));
}

/** Em que posição (1-based) o token aparece no nome do produto, ou 0 se não aparece. */
export function posicaoDoTokenNoProduto(token: string | null | undefined, nomeDoProduto: string): number {
  const t = fold(token ?? '').trim();
  if (t.length < 3) return 0;
  const toks = tokensDeCatalogo(nomeDoProduto);
  const i = toks.indexOf(t);
  return i < 0 ? 0 : i + 1;
}

/** Até onde no nome do produto a marca/princípio pode estar. */
export const POSICAO_MAXIMA_DA_MARCA = 3;

/**
 * O token existe como MARCA/PRINCÍPIO em algum nome de produto? Palavra inteira,
 * acento-insensível, e nas primeiras posições do nome (catálogo escreve marca primeiro:
 * "Neutrofer 300mg 30 Comprimidos", "Espironolactona 50mg…", "Cloridrato de Metformina…").
 *
 * 14/09: "Alto D" passou porque "alto" apareceu em "Colete Putti Elástico **Alto** | GG" —
 * palavra em qualquer posição não prova que o remédio existe; só a posição de marca prova.
 */
export function nomeExisteEm(token: string | null | undefined, nomesDeProdutos: string[]): boolean {
  return nomesDeProdutos.some((n) => {
    const pos = posicaoDoTokenNoProduto(token, n);
    return pos > 0 && pos <= POSICAO_MAXIMA_DA_MARCA;
  });
}

/** Prefixo fixo da pergunta de confirmação — é por ele que a conversa "lembra" que perguntou. */
export const MARCA_DA_PERGUNTA_DE_NOME = 'Li *';

/**
 * A XARLOTE JÁ PERGUNTOU esse nome e o paciente JÁ RESPONDEU? Então não pergunta de novo.
 *
 * 14/09 (Ludmila): "Oxandrolona" não está em rede nenhuma (é manipulado) → "não achei nenhum
 * remédio com esse nome" saiu QUATRO vezes, depois de "é esse mesmo" três vezes. A checagem
 * não tinha memória: cada `start_pharmacy_order` recomeçava do zero. A conversa é a memória:
 * se existe uma pergunta nossa sobre ESTE token e QUALQUER fala do paciente depois dela, ele
 * já respondeu — e, se tivesse corrigido o nome, o modelo teria trocado o item (o token não
 * casaria mais). A palavra dele vence.
 */
export function nomeJaConfirmadoPeloPaciente(
  mensagens: Array<{ direction: 'in' | 'out'; content: string | null | undefined }>,
  nome: string,
): boolean {
  const token = tokenPrincipal(nome);
  if (!token) return false;
  let perguntou = false;
  for (const m of mensagens) {
    const c = m.content ?? '';
    if (m.direction === 'out') {
      if (c.startsWith(MARCA_DA_PERGUNTA_DE_NOME) && tokenPrincipal(c.slice(MARCA_DA_PERGUNTA_DE_NOME.length).split('*')[0] ?? '') === token) perguntou = true;
      continue;
    }
    if (perguntou && c.trim()) return true;
    // O paciente escreveu o próprio nome ("é oxandrolona mesmo") — vale como texto dele.
    if (tokensDeNome(c).includes(token)) return true;
  }
  return false;
}

export type VerificacaoDeNome = 'segue' | 'confirmar' | 'segue_sem_verificar';

/**
 * O que fazer com o nome ANTES de acionar farmácias.
 *  - existe → segue (qualquer origem).
 *  - não existe e veio de foto/áudio → confirmar com o paciente (a leitura é a hipótese frágil).
 *  - não existe e veio do texto do paciente → segue, sem verificar (a palavra dele vence; a
 *    farmácia é a fonte de catálogo — regra antiga da HONESTIDADE FARMACÊUTICA).
 *  - catálogo inconclusivo (redes fora do ar) → segue sem verificar, seja qual for a origem:
 *    indisponibilidade de terceiro nunca trava um pedido.
 */
export function decidirVerificacaoDeNome(p: { origem: OrigemDoNome; existe: boolean | null }): VerificacaoDeNome {
  if (p.existe === true) return 'segue';
  if (p.existe === null) return 'segue_sem_verificar';
  return p.origem === 'texto' ? 'segue_sem_verificar' : 'confirmar';
}

/** A pergunta que a Xarlote faz ao paciente quando a leitura não bate com nenhum catálogo. */
export function perguntaDeConfirmacaoDeNome(nomeLido: string, origem: OrigemDoNome): string {
  const de = origem === 'foto' ? 'na receita' : 'no áudio';
  return `Li *${nomeLido.trim()}* ${de}, mas não achei nenhum remédio com esse nome 🤔 Pode conferir pra mim como está escrito (ou me mandar a foto mais de perto)? Assim eu coto o certo.`;
}

/**
 * A FARMÁCIA SUGERIU OUTRO NOME? "Seria Daflon?", "não seria Daflon?", "você quer dizer
 * Dafl on?", "é Daflon?", "Daflon?". Devolve o nome sugerido quando ele é DIFERENTE do pedido.
 * Palavras comuns nunca viram sugestão (sim/não/isso/qual/quanto…).
 */
export function sugestaoDeNomeDaFarmacia(textoDaFarmacia: string | null | undefined, nomePedido: string): string | null {
  const raw = (textoDaFarmacia ?? '').trim();
  if (!raw) return null;
  const f = fold(raw);
  const pedido = tokenPrincipal(nomePedido);
  const comuns = new Set(['sim', 'nao', 'isso', 'esse', 'essa', 'qual', 'quanto', 'quantos', 'quantas', 'mesmo', 'certo', 'aqui', 'entrega', 'frete', 'valor', 'preco', 'caixa', 'cx', 'comprimido', 'comprimidos', 'generico', 'similar', 'receita', 'cpf', 'nome', 'endereco', 'pagamento', 'pix', 'cartao', 'dinheiro', 'hoje', 'amanha', 'agora', 'entregar', 'retirar', 'tudo', 'bem', 'boa', 'bom', 'tarde', 'dia', 'noite', 'obrigado', 'obrigada']);
  const padroes = [
    /\b(?:nao\s+)?seria\s+(?:o|a|um|uma)?\s*([a-z][a-z0-9-]{3,})/,
    /\b(?:voce|vc)\s+(?:quer|queria)\s+dizer\s+(?:o|a)?\s*([a-z][a-z0-9-]{3,})/,
    /\b(?:nao\s+)?(?:e|seria)\s+(?:o|a)\s+([a-z][a-z0-9-]{3,})\s*\?/,
    /^\s*([a-z][a-z0-9-]{3,})\s*\?\s*$/,
  ];
  for (const re of padroes) {
    const m = re.exec(f);
    const tok = m?.[1] ? tokensDeNome(m[1])[0] : null;
    if (!tok || comuns.has(tok) || tok === pedido) continue;
    // recupera a grafia original
    for (const w of raw.split(/[\s,.;:!?()]+/)) {
      if (w && fold(w).replace(/[^a-z0-9-]/g, '') === tok) return w;
    }
    return tok.charAt(0).toUpperCase() + tok.slice(1);
  }
  return null;
}

/** Mensagem ao paciente quando a farmácia sugere que o nome está diferente. */
export function perguntaSobreSugestaoDeNome(supplierName: string, sugerido: string, pedido: string): string {
  return `A ${supplierName} perguntou se o remédio seria *${sugerido}* (eu tinha pedido *${pedido}*). É ${sugerido} mesmo? Me confirma que eu ajusto a cotação 💙`;
}
