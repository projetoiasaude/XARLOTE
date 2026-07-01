import { describe, it, expect } from 'vitest';
import { buildAgentClinicSystemPrompt, type AgentClinicContext } from '../packages/llm/src/prompts/agent-clinic.system.js';

// Blinda a ÂNCORA DE DATA: sem hoje no prompt, o gpt-4.1-mini "chuta" o ano/mês ao
// converter "amanhã"/"quinta" em ISO (visto ao vivo: gravou 2024-06-05 pra um
// "amanhã" de 2026). O prompt precisa injetar a data de referência de Brasília.
const baseCtx: AgentClinicContext = {
  specialty: 'dermatologia',
  urgency: 'rotina',
  modality: 'presencial',
  patientCity: 'Goiânia - GO',
  plan: 'particular',
  patientName: 'Teste',
  preferredTime: null,
};

function isoTodayBR(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

describe('buildAgentClinicSystemPrompt — âncora de data', () => {
  it('injeta a data de HOJE (Brasília) na negociação', () => {
    const p = buildAgentClinicSystemPrompt(baseCtx);
    expect(p).toContain('DATA DE HOJE');
    expect(p).toContain(isoTodayBR());
  });

  it('injeta a data de HOJE também na confirmação de agendamento', () => {
    const p = buildAgentClinicSystemPrompt({ ...baseCtx, isAppointmentConfirmation: true });
    expect(p).toContain('DATA DE HOJE');
    expect(p).toContain(isoTodayBR());
  });
});
