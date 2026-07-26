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

/** Saudação correta agora, no fuso de Brasília. */
function expectedGreetingBR(): string {
  const h = Number(new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo', hour: '2-digit', hour12: false,
  }).format(new Date()));
  return h < 12 ? 'Bom dia' : h < 18 ? 'Boa tarde' : 'Boa noite';
}

describe('buildAgentClinicSystemPrompt — âncora de data', () => {
  it('injeta a data de HOJE (Brasília) na negociação', () => {
    const p = buildAgentClinicSystemPrompt(baseCtx);
    expect(p).toContain('DATA E HORA DE HOJE');
    expect(p).toContain(isoTodayBR());
  });

  it('injeta a data de HOJE também na confirmação de agendamento', () => {
    const p = buildAgentClinicSystemPrompt({ ...baseCtx, isAppointmentConfirmation: true });
    expect(p).toContain('DATA E HORA DE HOJE');
    expect(p).toContain(isoTodayBR());
  });
});

// Auditoria 26/07 (caso Ciro): a âncora só tinha DATA, então o modelo copiava o "Boa tarde!"
// dos exemplos do prompt e mandava isso às 07:43 da manhã pra secretária da clínica.
describe('buildAgentClinicSystemPrompt — âncora de HORA e saudação', () => {
  it('injeta a hora atual e manda usar a saudação correta', () => {
    const p = buildAgentClinicSystemPrompt(baseCtx);
    expect(p).toMatch(/Agora são \*\*\d{2}:\d{2}\*\*/);
    expect(p).toContain(`A saudação correta AGORA é **"${expectedGreetingBR()}"**`);
  });

  it('os EXEMPLOS de abertura usam a saudação da hora, não "Boa tarde" fixo', () => {
    const p = buildAgentClinicSystemPrompt(baseCtx);
    const greeting = expectedGreetingBR();
    // Fora do período da tarde, "Boa tarde" não pode sobrar em lugar nenhum do prompt.
    if (greeting !== 'Boa tarde') expect(p).not.toContain('Boa tarde!');
    expect(p).toContain(`${greeting}!`);
  });
});
