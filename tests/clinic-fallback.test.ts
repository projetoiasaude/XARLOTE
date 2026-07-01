import { describe, it, expect } from 'vitest';
import { pickClinicFallbackMessage } from '../apps/api/src/handlers/agent-clinic.js';

// Blinda o FALLBACK DETERMINÍSTICO da clínica (paridade c/ farmácia): quando o
// gpt-4.1-mini chama uma tool sem gerar texto, a Xarlote precisa responder à clínica
// mesmo assim — senão a recepção dá o horário e ouve silêncio.
describe('pickClinicFallbackMessage', () => {
  it('confirmação de agendamento tem prioridade máxima', () => {
    const msg = pickClinicFallbackMessage({ appointmentConfirmed: true, clarificationRequested: false });
    expect(msg).toContain('instruções pro paciente');
    // mesmo se ambos setados, confirmação ganha
    expect(pickClinicFallbackMessage({ appointmentConfirmed: true, clarificationRequested: true })).toBe(msg);
  });

  it('pergunta ao paciente → mensagem de "vou confirmar e já respondo"', () => {
    const msg = pickClinicFallbackMessage({ appointmentConfirmed: false, clarificationRequested: true });
    expect(msg.toLowerCase()).toContain('confirmar isso com o paciente');
  });

  it('horário anotado (só cotação) → cortesia de "anotei o horário"', () => {
    const msg = pickClinicFallbackMessage({ appointmentConfirmed: false, clarificationRequested: false });
    expect(msg.toLowerCase()).toContain('anotei o horário');
    expect(msg.toLowerCase()).toContain('confirmar com o paciente');
  });

  it('nunca vaza persona de IA/robô/sistema', () => {
    for (const f of [
      { appointmentConfirmed: true, clarificationRequested: false },
      { appointmentConfirmed: false, clarificationRequested: true },
      { appointmentConfirmed: false, clarificationRequested: false },
    ]) {
      const msg = pickClinicFallbackMessage(f).toLowerCase();
      expect(msg).not.toMatch(/\b(ia|bot|rob[ôo]|sistema|automático|assistente virtual)\b/);
    }
  });
});
