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

/** O token existe como PALAVRA INTEIRA em algum nome de produto? (acento-insensível) */
export function nomeExisteEm(token: string | null | undefined, nomesDeProdutos: string[]): boolean {
  const t = fold(token ?? '').trim();
  if (t.length < 3) return false;
  const re = new RegExp(`(^|[^a-z0-9])${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`);
  return nomesDeProdutos.some((n) => re.test(fold(n)));
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
