/**
 * DEPOIS DE COTAR, A CONVERSA CONTINUA (caso Ludmila, 10/09/2026).
 *
 * A Drogaria Coimbra deu o preço (R$ 64,90) e, nos 40 minutos seguintes, mandou "69.90"
 * (total com frete), "qual nome da pessoa que vai receber?" (duas vezes) e "5 reais de frete".
 * Nada disso chegou à paciente, e a Xarlote ainda perguntou o frete à farmácia mais três vezes
 * — porque `message_supplier` manda o que o modelo escreve sem olhar o que a farmácia já disse.
 *
 * Aqui ficam as interpretações PURAS do que a farmácia fala depois de cotar (frete, total novo,
 * pergunta de nome/dado), a checagem "isso já foi respondido?" antes de mandar mensagem à
 * farmácia, e o texto do update ao paciente quando a oferta muda.
 */

import { extractPriceBRL } from './pharmacy.js';
import { WHO_ASK_RE } from './rota-farmacia.js';
import { linhaDoProduto, type ProdutoCotado } from './produto-cotado.js';

function fold(s: string): string {
  return (s ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

export interface CotacaoResumo {
  total: number | null;
  deliveryFee: number | null;
  etaMinutes?: number | null;
}

export interface InterpretacaoPosCotacao {
  /** Frete informado (valor), ou null. 0 = disse que é grátis. */
  frete: number | null;
  /** Total NOVO consistente (ex.: "69.90" quando o total era 64.90 → frete 5). */
  novoTotal: number | null;
  perguntaNome: boolean;
  perguntaDado: 'cpf' | 'endereco' | 'pagamento' | null;
  /** Prazo em minutos, se deu ("entrego às 14:40" NÃO vira minutos — fica em textoPrazo). */
  textoPrazo: string | null;
}

const FRETE_RE = /\b(frete|taxa\s*(de\s*)?(entrega)?|entrega|motoboy|motoqueiro)\b/;
const GRATIS_RE = /\b(gratis|gratuit\w*|cortesia|sem\s+(frete|taxa|custo)|nao\s+cobr\w*)\b/;

/** Lê a mensagem da farmácia à luz da cotação já registrada. */
export function interpretarMensagemPosCotacao(texto: string | null | undefined, cot: CotacaoResumo): InterpretacaoPosCotacao {
  const raw = (texto ?? '').trim();
  const f = fold(raw);
  const out: InterpretacaoPosCotacao = { frete: null, novoTotal: null, perguntaNome: WHO_ASK_RE.test(raw), perguntaDado: null, textoPrazo: null };
  if (!raw) return out;

  if (/\bcpf\b/.test(f)) out.perguntaDado = 'cpf';
  else if (/\b(endereco|rua|bairro|setor|quadra|lote|cep|numero\s+da\s+casa)\b/.test(f) && /\?|qual|me\s+passa|informa|manda/.test(f)) out.perguntaDado = 'endereco';
  else if (/\b(pix|cartao|dinheiro|maquininha|forma\s+de\s+pagamento|como\s+vai\s+pagar)\b/.test(f) && /\?|qual|como|aceita/.test(f)) out.perguntaDado = 'pagamento';

  const preco = extractPriceBRL(raw);
  const falaDeFrete = FRETE_RE.test(f);

  if (falaDeFrete && GRATIS_RE.test(f)) {
    out.frete = 0;
  } else if (preco != null && falaDeFrete) {
    // "5 reais de frete", "frete 7,90", "taxa de entrega R$ 6": o número É o frete — se for
    // plausível como frete (menor que o total, ou total desconhecido).
    if (cot.total == null || preco < cot.total) out.frete = preco;
    else if (cot.total != null && preco > cot.total && preco - cot.total <= 60) {
      // "com a entrega fica 69,90" → total novo; frete = diferença.
      out.novoTotal = preco;
      out.frete = round2(preco - cot.total);
    }
  } else if (preco != null && cot.total != null && preco > cot.total && preco - cot.total <= 60) {
    // Número SOLTO maior que o total por até R$60: é o total com frete ("69.90" após "64.90").
    out.novoTotal = preco;
    out.frete = round2(preco - cot.total);
  }

  const prazo = /\b(?:entreg\w*|chega|fica\s+pronto|sai)\b[^.!?\n]{0,30}?\b(\d{1,2}[:h]\d{2}|\d{1,2}\s*h(?:oras)?|\d{1,3}\s*min(?:utos)?|amanh[ãa]\w*|hoje\s+[àa]\s+(?:tarde|noite))/.exec(f);
  if (prazo?.[1]) out.textoPrazo = prazo[1];
  return out;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Cortesia à farmácia que pergunta o nome ANTES de o pedido estar fechado — uma vez por cotação. */
export const CORTESIA_NOME_ANTES_DE_FECHAR = 'Vou confirmar com quem vai receber e já te passo o nome, tá? Obrigada!';

/**
 * A mensagem que o modelo quer mandar à farmácia pergunta algo que a cotação JÁ responde?
 * Devolve o fato (pra o modelo responder ao paciente) ou null (pode mandar).
 */
export function perguntaJaRespondida(
  mensagem: string,
  cot: CotacaoResumo & { supplierName: string },
): string | null {
  const f = fold(mensagem);
  const pergunta = /\?|\b(quanto|qual|valor|me\s+passa|me\s+informa|consegue\s+(me\s+)?(passar|informar|dizer))\b/.test(f);
  if (!pergunta) return null;
  const fmt = (n: number) => `R$ ${n.toFixed(2).replace('.', ',')}`;
  if (FRETE_RE.test(f) && cot.deliveryFee != null) {
    const total = cot.total != null ? ` (total ${fmt(cot.total + cot.deliveryFee)} com a entrega)` : '';
    return `A ${cot.supplierName} JÁ respondeu o frete: ${cot.deliveryFee === 0 ? 'grátis' : fmt(cot.deliveryFee)}${total}. Não pergunte de novo — responda ao paciente com esse valor.`;
  }
  if (/\b(preco|valor|quanto\s+(fica|custa|sai))\b/.test(f) && !FRETE_RE.test(f) && cot.total != null) {
    return `A ${cot.supplierName} JÁ passou o preço: ${fmt(cot.total)}${cot.deliveryFee != null ? ` + frete ${cot.deliveryFee === 0 ? 'grátis' : fmt(cot.deliveryFee)}` : ' (frete ainda não confirmado)'}. Não pergunte de novo — responda ao paciente.`;
  }
  if (/\b(prazo|demora|quanto\s+tempo|que\s+horas)\b/.test(f) && cot.etaMinutes != null) {
    return `A ${cot.supplierName} JÁ deu o prazo: ~${cot.etaMinutes} min. Não pergunte de novo — responda ao paciente.`;
  }
  return null;
}

/** A oferta mudou de um jeito que o paciente precisa saber? */
export function ofertaMudou(
  antes: { total: number | null; deliveryFee: number | null; substituto: boolean | null },
  depois: { total: number | null; deliveryFee: number | null; substituto: boolean | null },
): boolean {
  if (antes.deliveryFee == null && depois.deliveryFee != null) return true;
  if (antes.total != null && depois.total != null && Math.abs(antes.total - depois.total) >= 0.01) return true;
  if (antes.substituto !== true && depois.substituto === true) return true;
  return false;
}

/** Update ao paciente quando a oferta de UMA farmácia muda depois de apresentada. */
export function mensagemDeAtualizacaoDaOferta(p: {
  supplierName: string;
  produto: ProdutoCotado | null;
  total: number | null;
  deliveryFee: number | null;
  textoPrazo?: string | null;
}): string {
  const fmt = (n: number) => `R$ ${n.toFixed(2).replace('.', ',')}`;
  const linhas: string[] = [`Novidade da *${p.supplierName}* 💙`];
  linhas.push(`• ${linhaDoProduto(p.produto)}`);
  if (p.total != null && p.deliveryFee != null) {
    linhas.push(`• ${fmt(p.total)} + ${p.deliveryFee === 0 ? 'entrega grátis' : `${fmt(p.deliveryFee)} de entrega`} = *${fmt(p.total + p.deliveryFee)}*`);
  } else if (p.total != null) {
    linhas.push(`• ${fmt(p.total)} + frete a confirmar`);
  }
  if (p.textoPrazo) linhas.push(`• entrega: ${p.textoPrazo}`);
  const pergunta = p.produto?.substituto === true
    ? `Quer fechar com o similar, ou prefere que eu procure o ${p.produto.pedido} mesmo?`
    : 'Quer que eu feche com eles? Me diz "pode fechar" que eu confirmo 😊';
  linhas.push('', pergunta);
  return linhas.join('\n');
}

/**
 * A última fala da Xarlote é uma ÂNCORA DE FECHAMENTO? Um "sim"/"pode fechar" logo depois
 * dela é consentimento inequívoco pra fechar o pedido (backstop 11b). São âncoras: a
 * apresentação das cotações, o update de oferta e a pergunta explícita "quer fechar com X?".
 */
export function ehAncoraDeFechamento(textoDaXarlote: string | null | undefined): boolean {
  const f = fold(textoDaXarlote ?? '');
  if (!f.trim()) return false;
  // Pergunta de DUAS saídas ("quer fechar com o similar, OU prefere que eu procure…") não é
  // âncora: um "sim" solto não diz qual das duas — aí quem decide é o modelo, com o paciente.
  if (/\bou prefere\b/.test(f)) return false;
  return /consegui cotac(o|ao)es|novidade da \*|qual voce prefere|quer (que eu )?fech(e|ar)|posso fechar|fecho com|pode fechar\b|quer fechar com/.test(f);
}

/** O paciente ACEITOU o similar na fala dele? (gate do confirm em cotação substituta) */
export function aceitouSubstituto(textoDoPaciente: string | null | undefined): boolean {
  const f = fold(textoDoPaciente ?? '');
  if (!f.trim()) return false;
  if (/\b(nao|prefiro o original|so o original|so a marca|quero o original|procura o)\b/.test(f) && !/\bnao tem problema\b/.test(f)) return false;
  return /\b(similar|generico|concorrente|esse mesmo|pode ser (esse|o|a|ele|ela)|fecha(r)? com (o|a|esse|essa)|quero (o|a|esse|essa)|aceito|pode fechar|fecha ai|fechado|tudo bem (o|a|esse)|serve|tanto faz)\b/.test(f);
}

/**
 * O `total` que o modelo passa em record_quote_price às vezes já INCLUI o frete ("total 69,90,
 * frete 5, subtotal 64,90" — teste cego 13/09). O que a apresentação espera em `quotes.total` é o
 * preço dos REMÉDIOS sem frete (formatOrderTotal soma o frete por cima). Normaliza de forma
 * determinística: se subtotal + frete ≈ total, os remédios são o subtotal; se não há subtotal e
 * o total é maior que o total-base já registrado exatamente pelo frete, idem.
 */
export function normalizarPrecoDaCotacao(p: {
  total: number; subtotal?: number | null; deliveryFee?: number | null; totalJaRegistrado?: number | null;
}): { remedios: number; frete: number | null } {
  const fee = p.deliveryFee == null ? null : Number(p.deliveryFee);
  const total = Number(p.total);
  const sub = p.subtotal == null ? null : Number(p.subtotal);
  if (fee != null && fee > 0) {
    if (sub != null && Math.abs(sub + fee - total) < 0.011) return { remedios: sub, frete: fee };
    const base = p.totalJaRegistrado == null ? null : Number(p.totalJaRegistrado);
    if (base != null && Math.abs(base + fee - total) < 0.011) return { remedios: base, frete: fee };
  }
  return { remedios: total, frete: fee };
}
