/**
 * QUANTIDADE QUE NINGUÉM DISSE NÃO ENTRA NO PEDIDO (caso Ludmila, 14/09/2026).
 *
 * A receita dizia "Espironolactona 50 mg, 1x ao dia" e "Neutrofer 300 mg, 3x ao dia por 3
 * meses". O modelo de visão preencheu "30 cápsulas" e "90 cápsulas" — aritmética de posologia
 * que a receita não pede e a paciente não falou. O ranqueador de catálogo leu "cápsulas" como
 * FORMA e puniu todo "Comprimidos": a Espironolactona 50mg que a Pague Menos tem virou "não
 * achei", e o Neutrofer 300mg virou "Neutrofer Colina DHA 60 Cápsulas". A farmácia de bairro
 * recebeu "(90 cápsulas)" como se fosse pedido.
 *
 * A regra: uma quantidade com número > 1 só sobrevive se esse número apareceu na fala do
 * paciente ou no texto lido da receita. "1 caixa"/"uma caixa" é o padrão e sempre pode ficar.
 * Quem decide o que a farmácia vende é a farmácia; quem decide quanto quer é o paciente.
 */

function fold(s: string): string {
  return (s ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

/** Números inteiros presentes num texto ("30 comprimidos", "cx c/ 60" → [30], [60]). */
function numeros(texto: string): Set<string> {
  const out = new Set<string>();
  for (const m of fold(texto).matchAll(/(?<![\d.,])(\d{1,4})(?![\d])/g)) out.add(String(Number(m[1])));
  return out;
}

const POR_EXTENSO: Record<string, number> = { um: 1, uma: 1, dois: 2, duas: 2, tres: 3, quatro: 4, cinco: 5, seis: 6 };

/** O número da quantidade ("30 cápsulas" → 30; "uma caixa" → 1; "caixa" → null). */
export function numeroDaQuantidade(quantity: string | null | undefined): number | null {
  const q = fold(quantity ?? '').trim();
  if (!q) return null;
  const d = /(\d{1,4})/.exec(q);
  if (d) return Number(d[1]);
  const w = q.split(/\s+/)[0] ?? '';
  return POR_EXTENSO[w] ?? null;
}

/**
 * A quantidade pode ficar no pedido? Sim quando: não tem número; o número é 1; ou o número
 * apareceu em alguma das falas (paciente ou leitura da receita).
 */
export function quantidadeFoiMencionada(falas: Array<string | null | undefined>, quantity: string | null | undefined): boolean {
  const n = numeroDaQuantidade(quantity);
  if (n == null || n <= 1) return true;
  const ditos = new Set<string>();
  for (const f of falas) for (const x of numeros(f ?? '')) ditos.add(x);
  return ditos.has(String(n));
}
