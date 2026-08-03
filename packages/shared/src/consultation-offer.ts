/**
 * VALIDADE DE UMA OFERTA DE HORÁRIO — predicado puro.
 *
 * ## A raiz
 * `consultation_quotes.proposed_datetime` era validado UMA vez, na escrita, e só quanto a
 * "é parseável" (`safeParseISO`). Nunca era revalidado no momento do USO. Em produção
 * (03/08) as 5 cotações "confirmáveis" do banco tinham data no passado — a mais recente
 * era 27/07, uma semana antes.
 *
 * Pior: o predicado "esta oferta vale" existia em TRÊS formulações independentes
 * (`countRealReplies`, o gate de apresentação, o filtro de confirmável), nenhuma com
 * componente temporal. Três lugares para apodrecer em silêncio.
 *
 * ## O que uma oferta vencida liberava
 * - Contava como "resposta real da clínica" → o rescue nunca alcançava o teste de falha →
 *   consulta com oferta podre virava IMORTAL.
 * - O ranking mascarava o sinal: `Math.max(0, hoursAway)` colapsava passado em 0, dando à
 *   data vencida o mesmo score de "dentro de 1h".
 * - O nudge afirmava "as opções ainda estão de pé" sem ler data nenhuma.
 * - Confirmada, mandava à clínica "pode marcar pra 27/07?" e gravava `scheduled_at` no
 *   passado; os lembretes 1d/2h não eram criados, em silêncio. Quando a clínica respondia
 *   "confirmado", o worker de feedback disparava perguntando "como foi sua consulta?" de
 *   uma consulta que nunca aconteceu, e a marcava `completed` — irreversível.
 *
 * ## A regra
 * Uma oferta vale enquanto o horário não passou. `graceMs` existe porque "a consulta é em
 * 10 minutos" ainda é confirmável na prática — e porque relógio de servidor e de secretária
 * não são o mesmo. Fora isso, passado é passado.
 */

/** Tolerância padrão: consulta que já começou há pouco ainda é confirmável. */
export const OFFER_GRACE_MS = 30 * 60_000;

/**
 * O horário oferecido ainda é confirmável?
 * ISO ausente/inválido → `false`: sem horário não há o que confirmar (é o caso
 * `unavailable`/`timeout`, em que a clínica nunca deu data).
 */
export function isOfferStillValid(
  proposedIso: string | null | undefined,
  nowMs: number,
  graceMs: number = OFFER_GRACE_MS,
): boolean {
  if (!proposedIso) return false;
  const t = Date.parse(proposedIso);
  if (!Number.isFinite(t)) return false;
  return t >= nowMs - graceMs;
}

/**
 * Filtra as cotações que a clínica de fato ofertou E cujo horário ainda vale.
 *
 * Este é o predicado ÚNICO que substitui as três formulações espalhadas. `statuses` é
 * parametrizável porque "ofertável ao paciente" (`offered`) e "confirmável agora"
 * (`pending`/`offered`/`selected`) não são o mesmo conjunto.
 */
export function pickValidOffers<T extends { status: string; proposed_datetime: string | null }>(
  quotes: T[] | null | undefined,
  nowMs: number,
  statuses: readonly string[] = ['offered'],
  graceMs: number = OFFER_GRACE_MS,
): T[] {
  return (quotes ?? []).filter(
    (q) => statuses.includes(q.status) && isOfferStillValid(q.proposed_datetime, nowMs, graceMs),
  );
}
