/**
 * As 3 perguntas de conhecimento do paciente.
 *
 * O risco aqui é dos dois lados: perguntar a quem não devia (fricção, cara de formulário,
 * paciente antigo sendo interrogado) OU nunca perguntar (a feature não existe na prática).
 * Estes testes travam as duas bordas — e sobretudo garantem que NADA do onboarding que já
 * funciona (consentimento → nome → áudio) é interrompido.
 */
import { describe, expect, it } from 'vitest';
import { shouldAskOnboardingQuestions, ONBOARDING_QUESTIONS_WINDOW_MS } from '../packages/shared/src/onboarding.js';

const NOW = Date.UTC(2026, 6, 29, 12, 0, 0);
const hojeIso = new Date(NOW - 60_000).toISOString();

/** Paciente novo, onboarding concluído, nada sabido ainda → caso feliz. */
const base = {
  onboardingStatus: 'active',
  createdAtIso: hojeIso,
  nowMs: NOW,
  hasMedications: false,
  hasConditions: false,
  hasHealthPlan: false,
  alreadyOffered: false,
  declined: false,
  isProfilingTurn: false,
};

describe('shouldAskOnboardingQuestions — quando PERGUNTAR', () => {
  it('paciente novo com onboarding concluído e nada sabido → pergunta as 3', () => {
    const d = shouldAskOnboardingQuestions(base);
    expect(d.ask).toBe(true);
    expect(d.missing).toEqual(['medication', 'condition', 'health_plan']);
  });

  it('pergunta SÓ o que falta — o que já sabemos nunca é re-perguntado', () => {
    const d = shouldAskOnboardingQuestions({ ...base, hasMedications: true, hasConditions: true });
    expect(d.ask).toBe(true);
    expect(d.missing).toEqual(['health_plan']);
  });
});

describe('shouldAskOnboardingQuestions — NÃO interromper o que já funciona', () => {
  // Estas 3 são a garantia de que o fluxo existente (consentimento → nome → áudio)
  // continua intocado: antes de `active` a Xarlote nunca vê o bloco.
  it('antes do aceite LGPD → NÃO pergunta', () => {
    expect(shouldAskOnboardingQuestions({ ...base, onboardingStatus: 'consent_pending' }).ask).toBe(false);
  });

  it('durante a captura do nome (profiling) → NÃO pergunta', () => {
    expect(shouldAskOnboardingQuestions({ ...base, onboardingStatus: 'profiling' }).ask).toBe(false);
  });

  it('no turno da saudação/áudio (isProfilingTurn) → NÃO pergunta', () => {
    // O turno que dispara o áudio "Prazer, Hiago!" tem que sair limpo, sem enxerto.
    expect(shouldAskOnboardingQuestions({ ...base, isProfilingTurn: true }).ask).toBe(false);
  });

  it('status ausente/desconhecido → NÃO pergunta (fail-safe)', () => {
    expect(shouldAskOnboardingQuestions({ ...base, onboardingStatus: null }).ask).toBe(false);
    expect(shouldAskOnboardingQuestions({ ...base, onboardingStatus: 'not_started' }).ask).toBe(false);
  });
});

describe('shouldAskOnboardingQuestions — quando PARAR (anti-fricção)', () => {
  it('já sabemos as 3 coisas → não há o que perguntar', () => {
    const d = shouldAskOnboardingQuestions({ ...base, hasMedications: true, hasConditions: true, hasHealthPlan: true });
    expect(d.ask).toBe(false);
    expect(d.missing).toEqual([]);
  });

  it('já ofereceu nesta conversa → não repete', () => {
    expect(shouldAskOnboardingQuestions({ ...base, alreadyOffered: true }).ask).toBe(false);
  });

  it('recusou antes → NUNCA mais pergunta (parada durável, vale entre dias)', () => {
    expect(shouldAskOnboardingQuestions({ ...base, declined: true }).ask).toBe(false);
  });

  it('paciente ANTIGO não é interrogado do nada', () => {
    const antigo = new Date(NOW - (ONBOARDING_QUESTIONS_WINDOW_MS + 86_400_000)).toISOString();
    expect(shouldAskOnboardingQuestions({ ...base, createdAtIso: antigo }).ask).toBe(false);
  });

  it('dentro da janela ainda pergunta; um instante depois, não', () => {
    const dentro = new Date(NOW - (ONBOARDING_QUESTIONS_WINDOW_MS - 60_000)).toISOString();
    const fora = new Date(NOW - (ONBOARDING_QUESTIONS_WINDOW_MS + 60_000)).toISOString();
    expect(shouldAskOnboardingQuestions({ ...base, createdAtIso: dentro }).ask).toBe(true);
    expect(shouldAskOnboardingQuestions({ ...base, createdAtIso: fora }).ask).toBe(false);
  });

  it('created_at ausente ou corrompido → NÃO pergunta (nunca cai em NaN)', () => {
    expect(shouldAskOnboardingQuestions({ ...base, createdAtIso: null }).ask).toBe(false);
    expect(shouldAskOnboardingQuestions({ ...base, createdAtIso: 'não-é-data' }).ask).toBe(false);
  });
});
