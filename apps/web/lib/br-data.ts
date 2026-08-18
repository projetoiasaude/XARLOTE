/**
 * Datas em pt-BR para a página do médico — sem depender do relógio de quem abre.
 *
 * ## Por que não usar `lib/xarlote/format.ts`
 *
 * Aquele módulo já trata o off-by-one da coluna DATE, mas parseando como hora LOCAL
 * (`new Date('2026-08-01T00:00:00')`), o que amarra o resultado ao fuso do aparelho. Numa
 * página que é lida por um médico que pode estar com o telefone em qualquer fuso — e cujo
 * conteúdo é clínico — a data não pode mudar conforme o aparelho. Aqui o deslocamento é
 * FIXO em -3h (o Brasil não tem horário de verão desde 2019). Ele também não arrasta
 * `date-fns` para o pacote desta rota, que é a única página pública de conteúdo.
 *
 * ## O bug que este arquivo existe para não repetir
 *
 * `onset_date` e `exam_date` são colunas `DATE` do Postgres: chegam como `2026-08-01`,
 * sem hora e sem fuso. `Date.parse` disso dá meia-noite **UTC**; subtrair 3h joga para
 * 21h do dia **anterior**. Visto em produção em 18/08/2026: um exame de `2026-08-01`
 * aparecia para o médico como **31/07/2026**, e uma condição iniciada em `2019-04-01`
 * como `31/03/2019`. Num documento clínico isso não é cosmético — é informação errada.
 *
 * Data pura não tem fuso para converter. Então não se converte: formata-se como veio.
 */

/** `YYYY-MM-DD` puro — coluna DATE, sem hora e sem fuso. */
const SO_DATA = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Brasil sem horário de verão desde 2019: UTC-3 o ano inteiro. */
const BRT_MS = 3 * 3_600_000;

/**
 * `2026-08-01` → `01/08/2026` · `2026-08-01T23:30:00Z` → `01/08/2026` (já em BRT).
 * Entrada vazia ou impossível de ler vira string vazia — a tela decide o que mostrar.
 */
export function dataBr(iso: string | null | undefined): string {
  if (!iso) return '';

  const puro = SO_DATA.exec(iso);
  if (puro) return `${puro[3]}/${puro[2]}/${puro[1]}`;

  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  const d = new Date(ms - BRT_MS);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`;
}
