/**
 * placeholder — texto de preenchimento não é dado.
 *
 * ─── POR QUE (caso Duda, 24/08/2026) ──────────────────────────────────────────
 * O card de confirmação saiu com a linha `📍 Não informado · Dra Mayra Freitas Storti`.
 * Não era um bug de formatação: a coluna `clinics.address` guardava, literalmente, a
 * string "Não informado". Todo leitor a jusante testa `endereco ? … : …`, e uma string
 * não-vazia passa nesse teste — então o vazio disfarçado de dado atravessou o sistema
 * inteiro e foi impresso pra paciente como se fosse um endereço.
 *
 * A regra: rótulo de ausência vira `null` na fronteira. Quem lê depois só precisa
 * saber testar `null`, que é o que todo mundo já faz.
 */
import { foldPt } from './br-datetime.js';

/**
 * Rótulos de ausência vistos em campo (Places, captura manual, importação de planilha).
 * Comparados já normalizados: minúsculo, sem acento, sem pontuação de borda.
 */
const ROTULOS_DE_AUSENCIA = new Set([
  'nao informado', 'nao informada', 'nao informou', 'nao disponivel', 'nao consta',
  'sem endereco', 'sem informacao', 'a informar', 'a confirmar', 'a definir',
  'n/a', 'na', 'nd', 'null', 'undefined', 'none', 'nenhum', 'nenhuma',
  '-', '--', '---', '?', '...', 'x', 'xx', 'xxx', 'tbd',
]);

/**
 * Devolve o texto útil, ou `null` quando o que veio é vazio ou rótulo de ausência.
 *
 * Não tenta adivinhar: só rejeita o que é reconhecidamente placeholder. Um endereço
 * ruim de verdade ("Rua sem nome") continua passando — é dado ruim, não ausência, e
 * inventar critério aqui esconderia informação legítima.
 */
export function limparPlaceholder(valor: string | null | undefined): string | null {
  const t = (valor ?? '').trim();
  if (!t) return null;
  const chave = foldPt(t)
    .replace(/[.,;:!]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return ROTULOS_DE_AUSENCIA.has(chave) ? null : t;
}

/** `true` quando o valor não carrega informação nenhuma. */
export function ehPlaceholder(valor: string | null | undefined): boolean {
  return limparPlaceholder(valor) === null;
}
