/**
 * As perguntas de conhecimento do paciente — e a saudação que as oferece.
 *
 * ─── POR QUE ESTES TESTES MUDARAM (auditoria 09/09/2026) ─────────────────────────
 * A feature foi construída em 29/07 e, em SEIS SEMANAS com 6 pacientes elegíveis, a oferta
 * saiu **zero vezes**: "perguntinhas"/"conhecer melhor" não aparece em nenhuma mensagem da
 * base inteira. Os testes antigos passavam — eles cobriam a decisão pura, e a decisão estava
 * certa. O que não existia era teste do que fazia a oferta CHEGAR na pessoa.
 *
 * Duas causas, as duas travadas aqui:
 *   1. a oferta dependia de o paciente "não trazer nada específico", e a saudação convidava
 *      justamente o contrário → agora a oferta É a saudação, montada pelo servidor;
 *   2. `alreadyOffered` matava o bloco no turno seguinte — exatamente aquele em que a pessoa
 *      diz "sim" → deixou de ser gate.
 */
import { describe, expect, it } from 'vitest';
import {
  shouldAskOnboardingQuestions, saudacaoDeConhecimento, OFERTA_RE, ONBOARDING_QUESTIONS_WINDOW_MS,
} from '../packages/shared/src/onboarding.js';

const NOW = Date.UTC(2026, 8, 9, 12, 0, 0);
const hojeIso = new Date(NOW - 60_000).toISOString();

/** Paciente novo, onboarding concluído, nada sabido ainda → caso feliz. */
const base = {
  onboardingStatus: 'active',
  createdAtIso: hojeIso,
  nowMs: NOW,
  hasAllergies: false,
  hasMedications: false,
  hasConditions: false,
  hasHealthPlan: false,
  alreadyOffered: false,
  declined: false,
  isProfilingTurn: false,
};

describe('quando PERGUNTAR', () => {
  it('paciente novo e nada sabido → as 4, com ALERGIA primeiro', () => {
    const d = shouldAskOnboardingQuestions(base);
    expect(d.ask).toBe(true);
    expect(d.missing).toEqual(['allergy', 'medication', 'condition', 'health_plan']);
  });
  it('cada dado que existe some da lista', () => {
    expect(shouldAskOnboardingQuestions({ ...base, hasAllergies: true }).missing).toEqual(['medication', 'condition', 'health_plan']);
    expect(shouldAskOnboardingQuestions({ ...base, hasMedications: true, hasConditions: true }).missing).toEqual(['allergy', 'health_plan']);
  });
  it('sabe tudo → não pergunta nada', () => {
    const d = shouldAskOnboardingQuestions({ ...base, hasAllergies: true, hasMedications: true, hasConditions: true, hasHealthPlan: true });
    expect(d.ask).toBe(false);
    expect(d.missing).toEqual([]);
  });
});

describe('🔴 a regressão de 29/07: alreadyOffered NÃO pode matar o bloco', () => {
  it('a oferta já saiu (está na saudação) e o bloco CONTINUA — é o turno do "sim"', () => {
    const d = shouldAskOnboardingQuestions({ ...base, alreadyOffered: true });
    expect(d.ask).toBe(true);
    expect(d.alreadyOffered).toBe(true); // repassado pro call-site trocar o texto da conduta
    expect(d.missing[0]).toBe('allergy');
  });
});

describe('quando PARAR (anti-fricção)', () => {
  it('recusa durável → nunca mais', () => {
    expect(shouldAskOnboardingQuestions({ ...base, declined: true }).ask).toBe(false);
  });
  it('turno da captura do nome → não interrompe a saudação/áudio', () => {
    expect(shouldAskOnboardingQuestions({ ...base, isProfilingTurn: true }).ask).toBe(false);
  });
  it('onboarding incompleto (consent/profiling) → não pergunta', () => {
    for (const st of ['not_started', 'consent_pending', 'profiling', null, undefined]) {
      expect(shouldAskOnboardingQuestions({ ...base, onboardingStatus: st }).ask).toBe(false);
    }
  });
  it('paciente ANTIGO fica de fora (decisão do fundador, 09/09) — os 25 de antes da feature', () => {
    const velho = new Date(NOW - ONBOARDING_QUESTIONS_WINDOW_MS - 1).toISOString();
    expect(shouldAskOnboardingQuestions({ ...base, createdAtIso: velho }).ask).toBe(false);
  });
  it('data de criação ilegível não vira "novo" por acidente', () => {
    expect(shouldAskOnboardingQuestions({ ...base, createdAtIso: 'lixo' }).ask).toBe(false);
    expect(shouldAskOnboardingQuestions({ ...base, createdAtIso: null }).ask).toBe(false);
  });
});

describe('a saudação do servidor', () => {
  it('cumprimenta pelo nome, oferece os DOIS caminhos e contém a oferta detectável', () => {
    const s = saudacaoDeConhecimento('Rodrigo');
    expect(s).toContain('Prazer Rodrigo!');
    expect(s).toMatch(/j[áa] precisa de alguma coisa/i);   // caminho "quero pedir"
    expect(OFERTA_RE.test(s)).toBe(true);                   // caminho "vamos nos conhecer"
    // Redação escolhida pelo fundador (09/09): as duas opções PARALELAS numa pergunta só,
    // em vez de "se preferir…" com cauda. Menos palavra = áudio melhor.
    expect(s).toMatch(/Ou posso te fazer algumas perguntinhas r[áa]pidas/);
  });
  it('sem vírgula depois de "Prazer" (pausa estranha no TTS) e sem travessão (regra de persona)', () => {
    const s = saudacaoDeConhecimento('Maria');
    expect(s).not.toMatch(/Prazer,/);
    expect(s).not.toContain('—');
  });
  it('sem nome capturado, ainda saúda e ainda oferece', () => {
    for (const n of [null, undefined, '', '   ']) {
      const s = saudacaoDeConhecimento(n);
      expect(s.startsWith('Prazer!')).toBe(true);
      expect(OFERTA_RE.test(s)).toBe(true);
    }
  });
  it('curta o bastante pra virar áudio de boas-vindas', () => {
    expect(saudacaoDeConhecimento('Rodrigo').length).toBeLessThan(220);
  });
  it('NUNCA é o narrador genérico — a frase que o Rodrigo ouviu em 24/08', () => {
    expect(saudacaoDeConhecimento('Rodrigo')).not.toContain('já cuidei disso');
  });
});

describe('OFERTA_RE reconhece a oferta no histórico', () => {
  it('pega a saudação nova e a redação antiga do prompt', () => {
    expect(OFERTA_RE.test(saudacaoDeConhecimento('Ana'))).toBe(true);
    expect(OFERTA_RE.test('Posso te fazer duas ou três perguntinhas rápidas pra te conhecer melhor?')).toBe(true);
    expect(OFERTA_RE.test('pra gente se conhecer melhor?')).toBe(true);
  });
  it('não confunde com conversa normal', () => {
    expect(OFERTA_RE.test('Anotado, Glauber ✅ Tô por aqui 💙')).toBe(false);
    expect(OFERTA_RE.test('Me conta, como posso te ajudar hoje?')).toBe(false);
  });
});
