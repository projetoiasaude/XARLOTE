import { describe, it, expect } from 'vitest';
import { buildAgentClinicSystemPrompt, type AgentClinicContext } from '../packages/llm/src/prompts/agent-clinic.system.js';
import { matchHealthPlan } from '../apps/api/src/handlers/clarification.js';
import { looksLikeImage } from '../apps/api/src/handlers/inbound-user.js';

// Blinda a frente de CONSULTA DE ALVO ÚNICO (incidente Vadivino 22/07): o paciente deu o contato
// direto do consultório → não se substitui médico, agenda distante NÃO é 'unavailable' (vira
// decisão do paciente), e a clínica-agent responde dados que já sabe (convênio/carteirinha).
const base: AgentClinicContext = {
  specialty: 'neurocirurgia', urgency: 'rotina', modality: 'presencial',
  patientCity: 'Goiânia - GO', plan: null, patientName: 'Vadivino', preferredTime: null,
};

describe('agent-clinic — ALVO ÚNICO', () => {
  it('renderiza o bloco ALVO ÚNICO quando singleTarget=true', () => {
    const p = buildAgentClinicSystemPrompt({ ...base, singleTarget: true, requestedProfessional: 'Dr. Valdivino José Vieira Júnior' });
    expect(p).toContain('ALVO ÚNICO');
    expect(p).toContain('Dr. Valdivino José Vieira Júnior');
    // agenda distante vira request_clarification, NUNCA unavailable silencioso
    expect(p).toContain('request_clarification');
    expect(p.toLowerCase()).toContain('pode ser');
  });

  it('NÃO renderiza o bloco ALVO ÚNICO numa busca ampla (singleTarget ausente)', () => {
    const p = buildAgentClinicSystemPrompt(base);
    expect(p).not.toContain('🎯 ALVO ÚNICO');
  });

  it('CASO C trata vaga distante como decisão do paciente (não unavailable silencioso)', () => {
    const p = buildAgentClinicSystemPrompt({ ...base, singleTarget: true });
    // O caso C deve orientar request_clarification pra vaga distante, não só record_clinic_unavailable
    expect(p).toMatch(/vaga distante|só daqui|pode ser/i);
    expect(p).toContain('request_clarification');
  });
});

describe('agent-clinic — DADOS DO PACIENTE (não re-pergunta)', () => {
  it('injeta convênio + carteirinha e manda corrigir convênio errado (Ipasgo→Unimed)', () => {
    const p = buildAgentClinicSystemPrompt({
      ...base, singleTarget: true,
      knownData: { healthPlan: 'Unimed', planCardNumber: '00640621001572009', cpf: '425.018.221-53', birthDate: '20/06/1967', phone: '+556299754679', fullName: 'Valdivino José Vieira Júnior' },
    });
    expect(p).toContain('DADOS DO PACIENTE');
    expect(p).toContain('Unimed');
    expect(p).toContain('00640621001572009');
    // corrige convênio errado quando o plano é conhecido
    expect(p).toContain('Ipasgo');
    expect(p.toLowerCase()).toContain('corrija');
  });

  it('NÃO renderiza a correção de convênio quando o plano é desconhecido', () => {
    const p = buildAgentClinicSystemPrompt({
      ...base, singleTarget: true,
      knownData: { cpf: '425.018.221-53' }, // só CPF, sem plano
    });
    expect(p).toContain('DADOS DO PACIENTE');
    expect(p).not.toContain('Ipasgo');
    // sem plano conhecido, não há "corrija (Não, é [plano])" sem sentido
    expect(p).not.toMatch(/corrija na hora/i);
  });

  it('injeta as respostas JÁ dadas pelo paciente (não re-pergunta)', () => {
    const p = buildAgentClinicSystemPrompt({
      ...base, singleTarget: true,
      clientAnswers: ['Tem convênio? → É Unimed', 'Qual o CPF? → 425.018.221-53'],
    });
    expect(p).toContain('JÁ RESPONDEU');
    expect(p).toContain('É Unimed');
  });
});

describe('agent-clinic — abertura nunca vira "consulta de consulta"', () => {
  it('especialidade genérica + médico nomeado → abre pelo NOME do médico', () => {
    const p = buildAgentClinicSystemPrompt({ ...base, specialty: 'consulta', singleTarget: true, requestedProfessional: 'Dr. Valdivino' });
    expect(p).not.toContain('consulta de consulta');
    expect(p).toContain('Dr. Valdivino');
  });

  it('especialidade genérica + sem médico → "consulta médica" (não "consulta de consulta")', () => {
    const p = buildAgentClinicSystemPrompt({ ...base, specialty: 'consulta' });
    expect(p).not.toContain('consulta de consulta');
    expect(p).toContain('uma consulta médica');
  });
});

describe('matchHealthPlan — detecção de convênio BR', () => {
  it('detecta Unimed e Ipasgo', () => {
    expect(matchHealthPlan('é pelo convênio Unimed sim')).toBe('Unimed');
    expect(matchHealthPlan('Você disse que ele tem ipasgo?')).toBe('Ipasgo');
    expect(matchHealthPlan('tenho Bradesco Saúde')).toBe('Bradesco Saúde');
  });
  it('devolve null quando não há convênio conhecido', () => {
    expect(matchHealthPlan('vai ser particular mesmo')).toBeNull();
    expect(matchHealthPlan('00640621001572009')).toBeNull();
  });
});

describe('looksLikeImage — magic bytes (anti-alucinação de visão)', () => {
  it('reconhece JPEG e PNG', () => {
    expect(looksLikeImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]))).toBe(true);
    expect(looksLikeImage(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]))).toBe(true);
  });
  it('rejeita corpo NÃO-imagem (HTML/JSON de erro do lookaside) e vazio', () => {
    expect(looksLikeImage(Buffer.from('<html><body>error 401</body></html>'))).toBe(false);
    expect(looksLikeImage(Buffer.from('{"error":"token expired"}'))).toBe(false);
    expect(looksLikeImage(Buffer.from([]))).toBe(false);
    expect(looksLikeImage(null)).toBe(false);
  });
});
