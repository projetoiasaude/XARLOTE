/**
 * As APRESENTAÇÕES REAIS de um remédio no catálogo das redes — pra que a pergunta "qual a
 * dose?" cite o que existe, e não o que o modelo lembra (caso Cefaliv, 28/09/2026: a Xarlote
 * ofereceu "10mg, 20mg e 40mg" de um remédio que só existe em 1mg + 100mg + 350mg).
 *
 * São as combinações distintas de dose nos nomes dos produtos que têm o remédio como
 * marca/princípio (a mesma régua de posição do `nomeExisteEm`). Volume (ml) não é dose — é o
 * tamanho do frasco — e fica fora. "1g" e "1000mg" são a mesma apresentação.
 */
import { nomeExisteEm } from '@iasaude/shared';
import { extractStrengths, canonStrength } from './matching.js';

const MASSA = /(mg|mcg|g|ui|%)$/;

export function apresentacoesDoCatalogo(
  token: string | null | undefined,
  nomesDeProdutos: readonly string[],
  max = 8,
): string[] {
  const vistas = new Map<string, { rotulo: string; ordem: number }>();
  for (const nome of nomesDeProdutos) {
    if (!nomeExisteEm(token, [nome])) continue;
    const doses = extractStrengths(nome).filter((s) => MASSA.test(s));
    if (!doses.length) continue;
    const assinatura = doses.map(canonStrength).sort().join('|');
    if (vistas.has(assinatura)) continue;
    const primeira = Number(canonStrength(doses[0]!).split(':')[1]);
    vistas.set(assinatura, {
      rotulo: doses.map((d) => d.replace('.', ',')).join(' + '),
      ordem: Number.isFinite(primeira) ? primeira : Number.MAX_SAFE_INTEGER,
    });
  }
  return [...vistas.values()].sort((a, b) => a.ordem - b.ordem).slice(0, max).map((v) => v.rotulo);
}
