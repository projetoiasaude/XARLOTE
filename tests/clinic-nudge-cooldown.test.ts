import { describe, it, expect } from 'vitest';
import { shouldPokeClinicAgain, CLINIC_NUDGE_COOLDOWN_MS } from '../apps/api/src/handlers/reach-out.js';

// Blinda o COOLDOWN do alô à clínica (incidente Rita/Dr. Rafael 31/07): dois turnos do
// paciente em 19s ("Tomei" + "Agenda com o Dr. Rafael Navarrete") fizeram a secretária
// receber a MESMA frase 2× em 10 segundos. O ONCE_PER_TURN protege DENTRO do turno;
// ENTRE turnos a decisão é esta função — e até 31/07, 100% dos nudges reais saíram em dupla.
const T0 = Date.parse('2026-07-31T12:00:00Z');
const iso = (deltaMs: number) => new Date(T0 + deltaMs).toISOString();

describe('shouldPokeClinicAgain', () => {
  it('nunca falamos com a clínica → 1º alô liberado', () => {
    const d = shouldPokeClinicAgain({ lastOutboundAt: null, lastClinicReplyAt: null, nowMs: T0 });
    expect(d.poke).toBe(true);
    expect(d.minutesSinceLastPoke).toBeNull();
  });

  it('alô há 10s sem resposta → BLOQUEIA (o caso Rita: 2ª msg em 10s)', () => {
    const d = shouldPokeClinicAgain({ lastOutboundAt: iso(-10_000), lastClinicReplyAt: null, nowMs: T0 });
    expect(d.poke).toBe(false);
    expect(d.minutesSinceLastPoke).toBe(1); // nunca "há 0 min" na observation
  });

  it('dentro do cooldown bloqueia; exatamente no cooldown libera', () => {
    expect(shouldPokeClinicAgain({
      lastOutboundAt: iso(-(CLINIC_NUDGE_COOLDOWN_MS - 60_000)), lastClinicReplyAt: null, nowMs: T0,
    }).poke).toBe(false);
    expect(shouldPokeClinicAgain({
      lastOutboundAt: iso(-CLINIC_NUDGE_COOLDOWN_MS), lastClinicReplyAt: null, nowMs: T0,
    }).poke).toBe(true);
  });

  it('clínica respondeu DEPOIS do nosso último envio → conversa viva, alô liberado', () => {
    const d = shouldPokeClinicAgain({
      lastOutboundAt: iso(-30 * 60_000), lastClinicReplyAt: iso(-5 * 60_000), nowMs: T0,
    });
    expect(d.poke).toBe(true);
  });

  it('resposta da clínica ANTERIOR ao nosso último envio não conta (seguimos sem resposta)', () => {
    const d = shouldPokeClinicAgain({
      lastOutboundAt: iso(-10 * 60_000), lastClinicReplyAt: iso(-60 * 60_000), nowMs: T0,
    });
    expect(d.poke).toBe(false);
    expect(d.minutesSinceLastPoke).toBe(10);
  });

  it('timestamp ilegível → fail-open (como nunca-enviado); no FUTURO (skew) → bloqueia', () => {
    expect(shouldPokeClinicAgain({ lastOutboundAt: 'garbage', lastClinicReplyAt: null, nowMs: T0 }).poke).toBe(true);
    const skew = shouldPokeClinicAgain({ lastOutboundAt: iso(60_000), lastClinicReplyAt: null, nowMs: T0 });
    expect(skew.poke).toBe(false);
    expect(skew.minutesSinceLastPoke).toBe(1); // nunca negativo
  });

  it('cooldownMs customizado é respeitado', () => {
    expect(shouldPokeClinicAgain({
      lastOutboundAt: iso(-2_000), lastClinicReplyAt: null, nowMs: T0, cooldownMs: 1_000,
    }).poke).toBe(true);
  });
});
