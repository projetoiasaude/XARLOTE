/**
 * Link de BUSCA no iFood — não é cotação. A API do iFood fica atrás do Cloudflare e nós não
 * passamos de proteção antirrobô (pesquisa de 28/09/2026). O link abre o app com o endereço salvo
 * da pessoa, e lá o próprio iFood mostra quais farmácias entregam agora, com prazo, frete e
 * estoque — em Goiânia, Drogasil, Pague Menos, DSP/Pacheco, Nissei e Santa Marta estão lá. O
 * caminho `/busca?q=` é permitido no robots.txt deles e aparece no sitemap.
 *
 * Por isso a mensagem NUNCA afirma preço, prazo ou estoque do iFood: só aponta o caminho.
 */
import { medNameForSearch } from './matching.js';

export function linkDeBuscaNoIfood(termo: string | null | undefined): string | null {
  const t = medNameForSearch(termo ?? '').trim();
  return t ? `https://www.ifood.com.br/busca?q=${encodeURIComponent(t)}` : null;
}
