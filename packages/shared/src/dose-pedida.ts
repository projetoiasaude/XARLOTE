/**
 * DOSE QUE NINGUÉM DISSE NÃO ENTRA NO PEDIDO (caso Hiago/Cefaliv, 28/09/2026).
 *
 * "Um cefaliv" → a Xarlote respondeu *"Cefaliv tem 10mg, 20mg e 40mg, qual é a sua?"* (Cefaliv
 * só existe em 1mg + 100mg + 350mg) e, depois de um áudio que só corrigia o endereço, decidiu
 * sozinha: *"Cefaliv 20mg é a dosagem mais comum, vou com essa"*. O pedido nasceu com "20mg";
 * o ranqueador de catálogo — que recusa dose divergente DE PROPÓSITO (vender 1g no lugar de
 * 500mg é o erro grave) — descartou o Cefaliv verdadeiro em todas as redes, e sobraram três
 * farmácias de bairro que não responderam. A entrega na hora nunca teve chance.
 *
 * A regra, irmã da `quantidadeFoiMencionada`: uma dose só entra no pedido se algum número dela
 * foi DITO — pelo paciente (texto ou áudio), lido da receita, ou já conhecido do prontuário
 * dele (remédio em uso, receita, pedido anterior). Número solto não é dose: "Rua 20",
 * "2 caixas" e "de 8 em 8 horas" não provam "20mg", "2mg" nem "8mg".
 *
 * E quando a dose não foi dita, quem diz se é preciso perguntar é o CATÁLOGO, não a memória do
 * modelo: uma apresentação só (Cefaliv) → segue sem perguntar; várias (Losartana 25/50/100) →
 * pergunta citando SÓ as reais (`doseAPerguntar`).
 */

import { tokenPrincipal } from './produto-cotado.js';

function fold(s: string): string {
  return (s ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

function escapar(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** "0,5" → "0.5"; "05" → "5" (zero à esquerda em inteiro é estilo); "1.000" → "1000" (milhar). */
export function normalizarNumero(bruto: string): string | null {
  let s = (bruto ?? '').trim();
  if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
  s = s.replace(',', '.');
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? String(n) : null;
}

/** Massa canônica em mg, pra "1g" casar com "1000mg" e "500mcg" com "0,5mg". */
function emMg(numero: string, unidade: string): string | null {
  const v = Number(numero);
  if (!Number.isFinite(v)) return null;
  const u = unidade.toLowerCase();
  if (u === 'g' || u.startsWith('grama')) return `m:${v * 1000}`;
  if (u === 'mg' || u.startsWith('miligrama')) return `m:${v}`;
  if (u === 'mcg' || u === 'ug' || u === 'µg' || u.startsWith('micrograma')) return `m:${v / 1000}`;
  return null;
}

const NUMERO = /\d+(?:[.,]\d+)*/g;
const UNIDADE = /^\s*(mg|mcg|µg|ug|g|ml|ui|%|miligramas?|microgramas?|gramas?)(?![a-z])/;
/** Depois do número, estas palavras dizem que ele é quantidade, frequência, dinheiro ou tempo. */
const DEPOIS_NAO_E_DOSE = /^\s*(x(?![a-z])|vez|vezes|caixas?|cx|comprimidos?|comp(?![a-z])|cps?(?![a-z])|capsulas?|unidades?|un(?![a-z])|frascos?|horas?|h(?![a-z])|hs(?![a-z])|dias?|reais|real|minutos?|min(?![a-z])|anos?|meses|mes(?![a-z])|semanas?|km|metros?|\/)/;
/**
 * Antes do número, estas PALAVRAS (inteiras) dizem que ele é endereço, data, hora ou preço:
 * "Rua 20", "Qd. B8, Lt. 20", "nº 180", "no dia 20", "às 20", "R$ 20".
 */
const ANTES_NAO_E_DOSE = /(?:(?:^|[^a-z0-9])(?:rua|r\.|av\.?|avenida|alameda|qd\.?|quadra|lt\.?|lote|casa|apto|ap\.?|apartamento|bloco|bl\.?|n[º°o]?\.?|numero|cep|km|sala|edificio|ed\.?|torre|setor|dia|dias|as|ate|hora|horas)|r\$)\s*$/;

/**
 * As doses que ESTA fala afirma — como conjunto de valores comparáveis ("50", "m:50"):
 *  • número com unidade de dose ("50mg", "1 g", "500 miligramas");
 *  • número logo depois do nome do remédio ("cefaliv 20", "losartana de 50");
 *  • numa resposta CURTA (até 5 palavras: "50", "a de 20", "é o de 50 mesmo"), o número solto —
 *    é a resposta à pergunta da dose.
 * Nunca: número de endereço, de quantidade, de horário/frequência, de preço.
 */
export function dosesNaFala(fala: string | null | undefined, tokenDoRemedio?: string | null): Set<string> {
  const texto = fold(fala ?? '');
  const out = new Set<string>();
  if (!texto.trim()) return out;
  const curta = texto.trim().split(/\s+/).length <= 5;
  const token = fold(tokenDoRemedio ?? '').trim();
  const aposONome = token.length >= 3 ? new RegExp(`(^|[^a-z0-9])${escapar(token)}(?:\\s+[a-z]+){0,3}\\s*$`) : null;
  for (const m of texto.matchAll(NUMERO)) {
    const i = m.index ?? 0;
    const n = normalizarNumero(m[0]);
    if (!n) continue;
    const depois = texto.slice(i + m[0].length, i + m[0].length + 16);
    const antes = texto.slice(Math.max(0, i - 16), i);
    const unidade = UNIDADE.exec(depois);
    if (unidade) {
      out.add(n);
      const mg = emMg(n, unidade[1]!);
      if (mg) out.add(mg);
      continue;
    }
    if (DEPOIS_NAO_E_DOSE.test(depois) || ANTES_NAO_E_DOSE.test(antes)) continue;
    if (aposONome && aposONome.test(texto.slice(Math.max(0, i - 48), i))) { out.add(n); continue; }
    if (curta) out.add(n);
  }
  return out;
}

/** Os valores de uma dose pedida: "1mg + 100mg + 350mg" → {1, m:1, 100, m:100, 350, m:350}. */
export function valoresDaDose(dosage: string | null | undefined): Set<string> {
  const texto = fold(dosage ?? '');
  const out = new Set<string>();
  for (const m of texto.matchAll(NUMERO)) {
    const n = normalizarNumero(m[0]);
    if (!n) continue;
    out.add(n);
    const unidade = UNIDADE.exec(texto.slice((m.index ?? 0) + m[0].length));
    const mg = unidade ? emMg(n, unidade[1]!) : null;
    if (mg) out.add(mg);
  }
  return out;
}

/**
 * A dose pode ficar no pedido? Sim quando não tem número (nada a provar) ou quando algum valor
 * dela aparece como DOSE nas evidências: falas do paciente, leitura da receita/áudio, e o que o
 * prontuário dele já sabe desse remédio ("Losartana 50mg" em uso).
 */
export function doseFoiDita(
  evidencias: Array<string | null | undefined>,
  dosage: string | null | undefined,
  nomeDoRemedio: string | null | undefined,
): boolean {
  const pedidos = valoresDaDose(dosage);
  if (!pedidos.size) return true;
  const token = tokenPrincipal(nomeDoRemedio ?? '');
  for (const e of evidencias) {
    for (const v of dosesNaFala(e, token)) if (pedidos.has(v)) return true;
  }
  return false;
}

const DOSE_NO_NOME = /\s*\d+(?:[.,]\d+)?\s*(?:mg|mcg|µg|g|ui)(?:\s*\/\s*ml)?(?:\s*\+\s*\d+(?:[.,]\d+)?\s*(?:mg|mcg|µg|g|ui)(?:\s*\/\s*ml)?)*(?![a-z])/i;

/**
 * Dose escrita DENTRO do nome ("Cefaliv 20mg", "Amoxicilina + Clavulanato 875mg + 125mg") vira
 * o campo de dose — senão ela passaria por fora da guarda e o ranqueador a usaria do mesmo jeito.
 * Número sem unidade fica no nome ("Neutrofer 300", "Vitamina D3"): não dá pra saber se é dose.
 */
export function separarDoseDoNome(nome: string | null | undefined): { nome: string; dose: string | null } {
  const original = (nome ?? '').trim();
  const m = DOSE_NO_NOME.exec(original);
  if (!m) return { nome: original, dose: null };
  const resto = (original.slice(0, m.index) + ' ' + original.slice(m.index + m[0].length)).replace(/\s+/g, ' ').trim();
  if (!resto) return { nome: original, dose: null };
  return { nome: resto, dose: m[0].trim() };
}

export interface PerguntaDeDose {
  nome: string;
  /** Apresentações REAIS do catálogo das redes ("25mg", "50mg", "1mg + 100mg + 350mg"). */
  opcoes: string[];
}

/**
 * Sem dose dita, o catálogo decide se precisa perguntar: nenhuma ou uma apresentação só → segue
 * (o ranqueador acha o produto pelo nome); duas ou mais → pergunta, com as opções reais.
 * Com dose (dita), segue — a palavra do paciente vence o catálogo, que pode estar incompleto.
 */
export function doseAPerguntar(
  item: { name: string; dosage?: string | null },
  apresentacoes: string[] | null | undefined,
): PerguntaDeDose | null {
  if ((item.dosage ?? '').trim()) return null;
  if (!apresentacoes || apresentacoes.length < 2) return null;
  return { nome: item.name, opcoes: apresentacoes };
}

function listar(opcoes: string[]): string {
  if (opcoes.length <= 1) return opcoes.join('');
  return `${opcoes.slice(0, -1).join(', ')} ou ${opcoes[opcoes.length - 1]}`;
}

/** A instrução pro modelo quando o pedido NÃO nasce porque falta a dose. */
export function instrucaoDePerguntaDeDose(perguntas: PerguntaDeDose[]): string {
  const linhas = perguntas.map((p) => `• ${p.nome}: ${listar(p.opcoes)}`).join('\n');
  return (
    'NENHUM pedido foi criado: o paciente não disse a dose e ela varia no catálogo das redes. ' +
    `Opções REAIS (do catálogo, não da memória):\n${linhas}\n` +
    'Pergunte qual ele usa citando SÓ essas opções, numa frase curta. NUNCA cite outra dose de memória e NUNCA escolha por ele ' +
    '("a mais comum" é inventar). Quando ele responder, chame start_pharmacy_order de novo com a dose que ele disse.'
  );
}
