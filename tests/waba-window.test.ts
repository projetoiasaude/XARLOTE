import { describe, expect, it } from 'vitest';
import { isWabaWindowOpen, WABA_WINDOW_MS } from '../packages/shared/src/waba-window.js';

const H = 60 * 60 * 1000;
const MIN = 60 * 1000;

describe('isWabaWindowOpen (janela 24h do WABA — incidente Elizabet + review 13/07)', () => {
  const now = Date.UTC(2026, 6, 14, 12, 0, 0);

  it('usuário mudo há 5 dias (Elizabet) → FECHADA', () => {
    expect(isWabaWindowOpen(now - 5 * 24 * H, now)).toBe(false);
  });

  it('sem inbound nenhum → FECHADA', () => {
    expect(isWabaWindowOpen(null, now)).toBe(false);
    expect(isWabaWindowOpen(undefined, now)).toBe(false);
  });

  it('respondeu há 1h → ABERTA', () => {
    expect(isWabaWindowOpen(now - 1 * H, now)).toBe(true);
  });

  // O CORAÇÃO do achado HIGH do review: lembrete diário (~24h) + replier RÁPIDO.
  // No disparo do dia seguinte, o inbound de ontem está a ~24h−L. Com L de poucos minutos,
  // a janela REAL do Meta ainda está aberta — a margem de 1h suprimia o usuário aderente.
  it('cadência diária + replier rápido (respondeu +5min ontem) → ABERTA no disparo de hoje', () => {
    // ontem o lembrete disparou; ela respondeu 5min depois. Hoje dispara 24h após o de ontem.
    const repliedAt = now - (24 * H - 5 * MIN); // 23h55 atrás
    expect(isWabaWindowOpen(repliedAt, now)).toBe(true);
  });

  it('replier +30min ontem → ABERTA hoje', () => {
    expect(isWabaWindowOpen(now - (24 * H - 30 * MIN), now)).toBe(true);
  });

  it('borda: exatamente no limite (24h−2min) → FECHADA (só < abre)', () => {
    expect(isWabaWindowOpen(now - WABA_WINDOW_MS, now)).toBe(false);
    expect(isWabaWindowOpen(now - WABA_WINDOW_MS + 1, now)).toBe(true);
  });

  it('margem é clock-skew (2min), não horas — 23h30 atrás ainda ABERTA', () => {
    expect(isWabaWindowOpen(now - 23.5 * H, now)).toBe(true);
  });
});
