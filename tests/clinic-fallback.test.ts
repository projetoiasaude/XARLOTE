import { describe, it, expect } from 'vitest';
import { pickClinicFallbackMessage } from '../apps/api/src/handlers/agent-clinic.js';

// Blinda o FALLBACK DETERMINÍSTICO da clínica (paridade c/ farmácia): quando o
// gpt-4.1-mini chama uma tool sem gerar texto, a Xarlote precisa responder à clínica
// mesmo assim — senão a recepção dá o horário e ouve silêncio.
describe('pickClinicFallbackMessage', () => {
  it('confirmação de agendamento tem prioridade máxima', () => {
    const msg = pickClinicFallbackMessage({ appointmentConfirmed: true, clarificationRequested: false });
    expect(msg.toLowerCase()).toContain('tudo certo');
    // mesmo se ambos setados, confirmação ganha
    expect(pickClinicFallbackMessage({ appointmentConfirmed: true, clarificationRequested: true })).toBe(msg);
  });

  it('pergunta ao paciente → "vou confirmar e já respondo" (sem "o paciente")', () => {
    const msg = pickClinicFallbackMessage({ appointmentConfirmed: false, clarificationRequested: true });
    expect(msg.toLowerCase()).toContain('confirmar isso aqui');
  });

  it('horário anotado (só cotação) → cortesia de "anotei o horário"', () => {
    const msg = pickClinicFallbackMessage({ appointmentConfirmed: false, clarificationRequested: false });
    expect(msg.toLowerCase()).toContain('anotei o horário');
    expect(msg.toLowerCase()).toContain('confirmar');
  });

  it('TOM HUMANO: nunca vaza IA/robô NEM os tells "o paciente"/"voltando"/"Show, anotei"', () => {
    for (const f of [
      { appointmentConfirmed: true, clarificationRequested: false },
      { appointmentConfirmed: false, clarificationRequested: true },
      { appointmentConfirmed: false, clarificationRequested: false },
    ]) {
      const msg = pickClinicFallbackMessage(f).toLowerCase();
      expect(msg).not.toMatch(/\b(ia|bot|rob[ôo]|sistema|automático|assistente virtual)\b/);
      expect(msg).not.toContain('o paciente');   // 3ª pessoa = cara de call-center
      expect(msg).not.toContain('voltando');       // ida-e-volta exposta
      expect(msg).not.toContain('volto pra fechar');
    }
  });
});
