import { describe, it, expect } from 'vitest';
import { buildAgentClinicSystemPrompt, type AgentClinicContext } from '../packages/llm/src/prompts/agent-clinic.system.js';

// Blinda a CONDUÇÃO da clínica (pedido do fundador): foco em profissional/horário/
// valor/local, e NUNCA falar da região/bairro do paciente pra clínica (≠ farmácia).
const particular: AgentClinicContext = {
  specialty: 'dermatologia', urgency: 'rotina', modality: 'presencial',
  patientCity: 'Goiânia - GO', plan: 'particular', patientName: 'Teste', preferredTime: null,
};
const comPlano: AgentClinicContext = { ...particular, plan: 'Unimed' };

describe('agent-clinic — condução (foco + sem região)', () => {
  it('tem a seção FOCO com profissional/horário/valor/local', () => {
    const p = buildAgentClinicSystemPrompt(particular);
    expect(p).toContain('## FOCO');
    expect(p).toMatch(/Profissional/);
    expect(p).toMatch(/Valor/);
    expect(p).toMatch(/Local/);
  });

  it('proíbe mencionar a região/bairro do paciente pra clínica', () => {
    const p = buildAgentClinicSystemPrompt(particular);
    expect(p.toLowerCase()).toContain('nunca mencione a região');
    // não deve empurrar a cidade do paciente pra clínica na modalidade presencial
    expect(p).not.toContain('em Goiânia - GO ou região');
  });

  it('abertura particular já avisa que é particular (não pergunta de plano)', () => {
    const p = buildAgentClinicSystemPrompt(particular);
    expect(p.toLowerCase()).toContain('particular');
  });

  it('abertura com plano manda perguntar se a clínica atende aquele plano', () => {
    const p = buildAgentClinicSystemPrompt(comPlano);
    expect(p).toContain('Unimed');
    expect(p.toLowerCase()).toContain('atende esse plano');
  });

  it('captura o endereço da clínica (address) pra passar ao paciente', () => {
    const p = buildAgentClinicSystemPrompt(particular);
    expect(p).toContain('address');
  });
});
