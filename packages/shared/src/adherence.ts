/**
 * Adesão ao tratamento — a série diária do gráfico e o número agregado.
 *
 * ## A regra é COPIADA do banco, não inventada
 *
 * Já existe uma definição canônica em produção: a função SQL `calc_adherence_score`,
 * que o `adherence-scorer.worker` roda e grava em `users.adherence_score_30d`:
 *
 *   taken / total   — onde `total` é TODA linha de medication_log na janela
 *                     (`snoozed` conta no denominador e não no numerador)
 *                     e o resultado é NULL quando não há nenhuma linha.
 *
 * Este módulo reproduz isso à risca. Se ele calculasse "melhor", o gráfico mostraria
 * uma curva e o número do topo da tela mostraria outro valor — e o paciente não tem
 * como saber qual dos dois acreditar. Uma definição, dois consumidores.
 *
 * ## O que a série NÃO faz: preencher dia vazio com zero
 *
 * Dia sem nenhuma dose registrada tem `ratio: null`, não `0`. Não é a mesma coisa:
 * zero significa "tinha remédio pra tomar e não tomou"; null significa "não havia
 * nada agendado (ou nada foi registrado)". Um gráfico que desenha zero em dia vazio
 * inventa uma queda de adesão que nunca existiu — e num app de saúde isso pode levar
 * um médico a mudar conduta com base em nada.
 *
 * ## Fuso: -03:00 fixo, sem Intl
 *
 * O dia é o dia DO PACIENTE, não o dia UTC. Uma dose das 22h de Goiânia é 01h UTC do
 * dia seguinte — contada em UTC ela migra pro dia errado e o gráfico fica torto.
 * O deslocamento é fixo porque o Brasil aboliu o horário de verão em 2019, e ser fixo
 * é o que torna esta função segura no Hermes (`Intl` com timeZone é justamente o que o
 * portão de shared-smoke.ts vigia).
 */

/** Deslocamento de Brasília em ms. Fixo desde o fim do horário de verão (2019). */
const BRT_OFFSET_MS = -3 * 60 * 60 * 1000;

/** Uma linha de `medication_log`. */
export interface DoseLogEntry {
  scheduledAt: string;
  /** 'taken' | 'skipped' | 'snoozed' | 'no_response' — texto livre no banco. */
  status: string;
}

export interface AdherenceDay {
  /** 'AAAA-MM-DD' no fuso de Brasília. */
  day: string;
  taken: number;
  /** Todas as doses registradas no dia (o denominador do banco). */
  total: number;
  /** `taken/total` arredondado em 2 casas, ou null quando não houve registro. */
  ratio: number | null;
}

/** 'AAAA-MM-DD' do dia de Brasília em que este instante caiu. */
export function brDayKey(ms: number): string {
  return new Date(ms + BRT_OFFSET_MS).toISOString().slice(0, 10);
}

/** Igual ao `ROUND(x, 2)` do Postgres. */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Série de `days` dias terminando no dia de HOJE (Brasília), do mais antigo pro mais
 * recente. Dias sem registro aparecem com `ratio: null` — presentes na série, porque
 * o gráfico precisa do eixo contínuo, mas sem valor inventado.
 */
export function adherenceSeries(
  entries: readonly DoseLogEntry[],
  opts: { days: number; nowMs: number },
): AdherenceDay[] {
  const porDia = new Map<string, { taken: number; total: number }>();

  // Semeia TODOS os dias da janela, inclusive os vazios: sem isso o gráfico pularia
  // buracos e comprimiria o eixo do tempo, dando impressão de continuidade falsa.
  for (let i = opts.days - 1; i >= 0; i--) {
    porDia.set(brDayKey(opts.nowMs - i * 86_400_000), { taken: 0, total: 0 });
  }

  for (const e of entries) {
    const ms = Date.parse(e.scheduledAt);
    if (!Number.isFinite(ms)) continue; // linha corrompida não derruba o gráfico
    const dia = porDia.get(brDayKey(ms));
    if (!dia) continue; // fora da janela pedida
    dia.total += 1;
    if (e.status === 'taken') dia.taken += 1;
  }

  return [...porDia.entries()].map(([day, d]) => ({
    day,
    taken: d.taken,
    total: d.total,
    ratio: d.total === 0 ? null : round2(d.taken / d.total),
  }));
}

/**
 * O número agregado da janela — o MESMO que `calc_adherence_score` devolve.
 *
 * Calculado a partir das entradas cruas, e não da média das razões diárias: média de
 * médias pesaria igual um dia de 1 dose e um dia de 8, e daria um número diferente do
 * que está gravado em `users.adherence_score_30d`.
 */
export function adherenceScore(
  entries: readonly DoseLogEntry[],
  opts: { days: number; nowMs: number },
): number | null {
  const inicio = opts.nowMs - opts.days * 86_400_000;
  let taken = 0;
  let total = 0;
  for (const e of entries) {
    const ms = Date.parse(e.scheduledAt);
    if (!Number.isFinite(ms) || ms < inicio) continue;
    total += 1;
    if (e.status === 'taken') taken += 1;
  }
  return total === 0 ? null : round2(taken / total);
}

/**
 * Rótulo curto pro paciente. Deliberadamente SEM juízo de valor ("ruim", "péssimo") —
 * a Xarlote não repreende; ela acompanha. E `null` não vira 0%: vira "sem registro".
 */
export function adherenceLabel(ratio: number | null): string {
  if (ratio === null) return 'sem registro ainda';
  const pct = Math.round(ratio * 100);
  if (pct >= 90) return `${pct}% — em dia`;
  if (pct >= 70) return `${pct}% — quase sempre`;
  return `${pct}% — vamos ajustar juntos`;
}
