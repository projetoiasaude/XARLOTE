/**
 * O NOME DO REMÉDIO EXISTE? — checagem contra catálogo REAL antes de acionar farmácias
 * (caso Ludmila, 10/09/2026: "Aflor 1000 Flex" lido de uma receita manuscrita foi pra cinco
 * farmácias e pras grandes redes sem ninguém perguntar se "Aflor" era um remédio).
 *
 * Fonte: a busca pública das redes VTEX que já usamos pra cotar (Pague Menos, Drogal, São
 * João, Drogaria São Paulo). Quatro buscas em paralelo, ~0,5 s, sem CEP. O que decide é a
 * regra pura `nomeExisteEm` (palavra inteira, acento-insensível): a busca `ft=` é fuzzy e
 * devolve "Renovaflora" pra "aflor" — por isso a resposta bruta não vale, só a palavra.
 *
 * Três respostas, não duas: true (achou), false (nenhuma rede tem a palavra), null
 * (nenhuma rede respondeu — indisponibilidade de terceiro NUNCA trava um pedido). Cache no
 * Redis por token (30 dias): sob demanda alta o custo é uma busca por nome distinto, nunca
 * uma por pedido. Redis fora do ar = sem cache, segue funcionando.
 */

import { writeLog } from '@iasaude/db';
import { PLATFORM_REGISTRY, searchVtexProducts, apresentacoesDoCatalogo } from '@iasaude/integrations';
import { tokenPrincipal, nomeExisteEm } from '@iasaude/shared';
import { getRedisClient } from '../queue-config.js';

const REDES_DE_REFERENCIA = ['pague-menos', 'drogal', 'sao-joao', 'drogaria-sao-paulo'];
const CACHE_TTL_S = 30 * 24 * 60 * 60;
const TIMEOUT_MS = Number(process.env['NOME_REMEDIO_TIMEOUT_MS'] ?? 5000);

export interface ExistenciaDoRemedio {
  token: string | null;
  /** true = achou; false = nenhuma rede tem a palavra; null = não deu pra checar. */
  existe: boolean | null;
  /** Nomes de produtos que provam a existência (pra log/observação), no máximo 3. */
  exemplos: string[];
  /**
   * As apresentações REAIS no catálogo ("1mg + 100mg + 350mg"; "25mg", "50mg", "100mg") —
   * é daqui que sai a pergunta de dose, nunca da memória do modelo (caso Cefaliv, 28/09).
   * null = não deu pra saber (redes fora do ar).
   */
  apresentacoes: string[] | null;
  fonte: 'cache' | 'busca' | 'inconclusivo' | 'sem_token';
}

export async function verificarExistenciaDoRemedio(nome: string, traceId?: string): Promise<ExistenciaDoRemedio> {
  const token = tokenPrincipal(nome);
  if (!token) return { token: null, existe: null, exemplos: [], apresentacoes: null, fonte: 'sem_token' };

  // v2 (28/09): o cache guarda também as apresentações. A chave antiga ('1'/'0') não as tem
  // e morre sozinha em 30 dias; até lá, uma busca a mais por nome distinto.
  const chave = `remedio:existe:v2:${token}`;
  try {
    const cached = await getRedisClient().get(chave);
    if (cached) {
      const c = JSON.parse(cached) as { e?: boolean; a?: string[] };
      if (typeof c.e === 'boolean') {
        return { token, existe: c.e, exemplos: [], apresentacoes: Array.isArray(c.a) ? c.a : null, fonte: 'cache' };
      }
    }
  } catch { /* Redis fora ou valor estranho → segue sem cache */ }

  const redes = PLATFORM_REGISTRY.filter((n) => n.access === 'rest' && n.enabled && REDES_DE_REFERENCIA.includes(n.id));
  const resultados = await Promise.all(redes.map(async (net) => {
    try {
      const produtos = await searchVtexProducts(net, token, { limit: 8, timeoutMs: TIMEOUT_MS, retries: 1 });
      return { ok: true as const, nomes: produtos.map((p) => p.productName) };
    } catch {
      return { ok: false as const, nomes: [] as string[] };
    }
  }));
  const respondeu = resultados.filter((r) => r.ok);
  if (!respondeu.length) {
    await writeLog('warn', 'pharmacy', `Verificação de nome INCONCLUSIVA (nenhuma rede respondeu) — seguindo sem verificar "${token}"`, { traceId });
    return { token, existe: null, exemplos: [], apresentacoes: null, fonte: 'inconclusivo' };
  }
  const nomes = respondeu.flatMap((r) => r.nomes);
  const existe = nomeExisteEm(token, nomes);
  const exemplos = nomes.filter((n) => nomeExisteEm(token, [n])).slice(0, 3);
  const apresentacoes = apresentacoesDoCatalogo(token, nomes);
  try { await getRedisClient().set(chave, JSON.stringify({ e: existe, a: apresentacoes }), 'EX', CACHE_TTL_S); } catch { /* sem cache */ }
  return { token, existe, exemplos, apresentacoes, fonte: 'busca' };
}
