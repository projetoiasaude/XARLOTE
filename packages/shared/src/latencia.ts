/**
 * latencia — quando a lentidão do LLM merece acordar o fundador.
 *
 * ─── O ALERTA QUE NÃO SIGNIFICAVA NADA (25/08/2026) ───────────────────────────
 * Às 09:45 chegou no WhatsApp do fundador, severidade alta: "LLM p95 alto". Os dados
 * reais das 6 horas anteriores: NOVE chamadas, mediana de 5,8 s, uma de 57 s.
 *
 * O detector exigia 10 amostras e calculava `p95Idx = floor(n × 0,95)`. Com n = 10 isso
 * dá índice 9 — o MÁXIMO. Ou seja: em volume baixo, "p95" era literalmente a chamada
 * mais lenta da janela. Uma única chamada ruim num sistema com 26 pacientes bastava pra
 * disparar alerta de severidade alta.
 *
 * O problema não é o limiar, é a estatística: p95 só quer dizer alguma coisa quando há
 * amostra pra sustentá-lo. Abaixo disso, o número existe mas não informa — e um alerta
 * que não informa treina quem o recebe a ignorá-lo, inclusive no dia em que for real.
 *
 * ─── O QUE ESTE MÓDULO FAZ ────────────────────────────────────────────────────
 * Duas perguntas separadas, cada uma respondida com a evidência que ela exige:
 *
 *   1. "A distribuição piorou?" — exige amostra (≥30). É o alerta de p95.
 *   2. "Houve chamadas absurdas?" — não exige amostra nenhuma: contar chamadas acima de
 *      um limiar duro é válido com 9 ou com 9.000. É o que serve em volume baixo.
 *
 * Uma chamada lenta isolada não é incidente. Três são.
 *
 * PURO: sem I/O, sem relógio.
 */

/** Abaixo disto, p95 não tem amostra pra significar nada. */
export const AMOSTRA_MINIMA_P95 = 30;

/** p95 acima disto, COM amostra, é degradação real da distribuição. */
export const LIMIAR_P95_MS = 30_000;

/** Chamada individual acima disto é absurda em qualquer volume. */
export const LIMIAR_CHAMADA_LENTA_MS = 45_000;

/** Uma lenta é azar; três viram padrão. */
export const MIN_LENTAS_PARA_ALERTA = 3;

/**
 * Percentil por POSTO (nearest-rank), com o índice preso ao fim do array.
 *
 * `floor(n × p)` estourava pro máximo em amostras pequenas — era a raiz do alerta falso.
 * `ceil(n × p) − 1` é a definição padrão e não passa do último elemento.
 */
export function percentilPorPosto(ordenadas: readonly number[], p: number): number | null {
  if (ordenadas.length === 0) return null;
  const posto = Math.ceil(ordenadas.length * p);
  const idx = Math.min(ordenadas.length - 1, Math.max(0, posto - 1));
  return ordenadas[idx] ?? null;
}

export type VeredictoLatencia =
  | { alertar: false; motivo: 'sem_dados' | 'amostra_insuficiente' | 'saudavel' }
  | { alertar: true; tipo: 'p95'; p95Ms: number; n: number }
  | { alertar: true; tipo: 'chamadas_lentas'; lentas: number; n: number; piorMs: number };

/**
 * Vale acordar alguém por causa destas durações?
 *
 * A ordem importa: a degradação de distribuição (quando há amostra) é o sinal mais forte
 * e vem primeiro. O contador de chamadas lentas é a rede que funciona em volume baixo —
 * exatamente o regime em que este produto vive hoje.
 */
export function avaliarLatencia(duracoesMs: readonly number[]): VeredictoLatencia {
  const validas = duracoesMs.filter((n) => Number.isFinite(n) && n > 0).slice().sort((a, b) => a - b);
  const n = validas.length;
  if (n === 0) return { alertar: false, motivo: 'sem_dados' };

  const lentas = validas.filter((d) => d > LIMIAR_CHAMADA_LENTA_MS).length;

  if (n >= AMOSTRA_MINIMA_P95) {
    const p95 = percentilPorPosto(validas, 0.95);
    if (p95 !== null && p95 > LIMIAR_P95_MS) return { alertar: true, tipo: 'p95', p95Ms: p95, n };
  }

  if (lentas >= MIN_LENTAS_PARA_ALERTA) {
    return { alertar: true, tipo: 'chamadas_lentas', lentas, n, piorMs: validas[n - 1]! };
  }

  return { alertar: false, motivo: n < AMOSTRA_MINIMA_P95 ? 'amostra_insuficiente' : 'saudavel' };
}

/** Texto do alerta, na forma que diz o que foi medido — e sobre quantas chamadas. */
export function descreverLatencia(v: VeredictoLatencia): string | null {
  if (!v.alertar) return null;
  const s = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
  return v.tipo === 'p95'
    ? `Últimos 30min: p95=${s(v.p95Ms)} sobre ${v.n} chamadas (esperado <10s).`
    : `Últimos 30min: ${v.lentas} chamadas acima de ${s(LIMIAR_CHAMADA_LENTA_MS)} (pior: ${s(v.piorMs)}) em ${v.n} no total.`;
}
