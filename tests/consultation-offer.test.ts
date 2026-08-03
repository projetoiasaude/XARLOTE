import { describe, it, expect } from 'vitest';
import { isOfferStillValid, pickValidOffers, OFFER_GRACE_MS } from '../packages/shared/src/consultation-offer.js';

/**
 * Blinda a validade da oferta de horário.
 *
 * Em 03/08 as 5 cotações "confirmáveis" do banco de produção tinham data no PASSADO — a
 * mais recente era 27/07 (a do Ciro), a mais antiga 06/07. O predicado "esta oferta vale"
 * existia em três formulações independentes, nenhuma com componente temporal, e uma oferta
 * vencida: contava como resposta real da clínica (tornando a consulta imortal), era
 * apresentada numerada ao paciente, era confirmável, e ao ser confirmada mandava à clínica
 * "pode marcar pra 27/07?" e disparava o worker de feedback perguntando "como foi sua
 * consulta?" sobre algo que nunca aconteceu.
 */
const AGORA = Date.parse('2026-08-03T12:00:00Z');
const emHoras = (h: number) => new Date(AGORA + h * 3_600_000).toISOString();

describe('isOfferStillValid', () => {
  it('horário no futuro vale', () => {
    expect(isOfferStillValid(emHoras(1), AGORA)).toBe(true);
    expect(isOfferStillValid(emHoras(24 * 7), AGORA)).toBe(true);
  });

  it('🔴 horário no passado NÃO vale (o caso Ciro: oferta de 27/07 vista em 03/08)', () => {
    expect(isOfferStillValid('2026-07-27T17:30:00Z', AGORA)).toBe(false);
    expect(isOfferStillValid(emHoras(-24), AGORA)).toBe(false);
    expect(isOfferStillValid(emHoras(-1), AGORA)).toBe(false);
  });

  it('tolerância: consulta que começou há poucos minutos ainda é confirmável', () => {
    // Relógio de servidor e de secretária não são o mesmo, e "a consulta é em 10 min"
    // segue sendo confirmável na prática.
    expect(isOfferStillValid(new Date(AGORA - 5 * 60_000).toISOString(), AGORA)).toBe(true);
    expect(isOfferStillValid(new Date(AGORA - OFFER_GRACE_MS + 1_000).toISOString(), AGORA)).toBe(true);
    // Passada a tolerância, não vale mais.
    expect(isOfferStillValid(new Date(AGORA - OFFER_GRACE_MS - 60_000).toISOString(), AGORA)).toBe(false);
  });

  it('fronteira exata: o próprio instante vale', () => {
    expect(isOfferStillValid(new Date(AGORA).toISOString(), AGORA)).toBe(true);
  });

  it('sem horário ou ISO inválido não vale (é unavailable/timeout, não oferta)', () => {
    expect(isOfferStillValid(null, AGORA)).toBe(false);
    expect(isOfferStillValid(undefined, AGORA)).toBe(false);
    expect(isOfferStillValid('', AGORA)).toBe(false);
    expect(isOfferStillValid('amanhã às 9h', AGORA)).toBe(false);
    expect(isOfferStillValid('2026-13-45T99:99:99Z', AGORA)).toBe(false);
  });

  it('tolerância customizada é respeitada', () => {
    const meiaHoraAtras = new Date(AGORA - 30 * 60_000).toISOString();
    expect(isOfferStillValid(meiaHoraAtras, AGORA, 60 * 60_000)).toBe(true);
    expect(isOfferStillValid(meiaHoraAtras, AGORA, 5 * 60_000)).toBe(false);
  });
});

describe('pickValidOffers', () => {
  const quotes = [
    { id: 'futura', status: 'offered', proposed_datetime: emHoras(48) },
    { id: 'vencida', status: 'offered', proposed_datetime: emHoras(-48) },
    { id: 'sem-horario', status: 'offered', proposed_datetime: null },
    { id: 'pendente-futura', status: 'pending', proposed_datetime: emHoras(72) },
    { id: 'recusada', status: 'unavailable', proposed_datetime: null },
    { id: 'expirada', status: 'withdrawn', proposed_datetime: emHoras(-72) },
  ];

  it('por padrão só `offered` com horário válido — é o que é apresentável ao paciente', () => {
    expect(pickValidOffers(quotes, AGORA).map((q) => q.id)).toEqual(['futura']);
  });

  it('conjunto de status parametrizável (confirmável ≠ apresentável)', () => {
    expect(pickValidOffers(quotes, AGORA, ['pending', 'offered']).map((q) => q.id))
      .toEqual(['futura', 'pendente-futura']);
  });

  it('🔴 nunca devolve oferta vencida, em nenhum conjunto de status', () => {
    const todos = ['pending', 'offered', 'selected', 'withdrawn', 'unavailable', 'timeout'];
    const ids = pickValidOffers(quotes, AGORA, todos).map((q) => q.id);
    expect(ids).not.toContain('vencida');
    expect(ids).not.toContain('expirada');
  });

  it('lista nula/vazia devolve vazio (nunca lança)', () => {
    expect(pickValidOffers(null, AGORA)).toEqual([]);
    expect(pickValidOffers(undefined, AGORA)).toEqual([]);
    expect(pickValidOffers([], AGORA)).toEqual([]);
  });

  it('cenário real do Ciro: única oferta é de 27/07 → ZERO respostas reais', () => {
    // Este é o predicado que `countRealReplies` passou a usar. Com ele em zero, o rescue
    // finalmente alcança o horizonte de falha em vez de dar `continue` pra sempre.
    const ciro = [{ id: 'f42bd73b', status: 'offered', proposed_datetime: '2026-07-27T17:30:00+00:00' }];
    expect(pickValidOffers(ciro, AGORA)).toHaveLength(0);
  });
});
