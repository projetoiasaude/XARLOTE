/**
 * Decisão de fazer (ou não) as 3 perguntas de conhecimento do paciente.
 *
 * Roda DEPOIS do onboarding existente — consentimento LGPD → nome → áudio de saudação —
 * que não é tocado por nada aqui: o gate exige `onboarding_status === 'active'`, estado que
 * só é atingido quando aquele fluxo terminou.
 *
 * O estado é DERIVADO do que já sabemos do paciente, não guardado numa máquina de estado
 * nova: cada pergunta desaparece sozinha quando o dado passa a existir. Isso evita migração,
 * evita flag pra corromper e é auto-corretivo (se o dado for apagado, a pergunta volta).
 *
 * As 3 foram escolhidas por MUDAREM O QUE ELA CONSEGUE FAZER, não por curiosidade:
 *   • medicação de uso contínuo → destrava reposição automática e lembretes de rotina
 *   • condição acompanhada      → contexto clínico que ela nunca infere sozinha com segurança
 *   • convênio                  → permite priorizar clínicas que aceitam o plano (no caso
 *     real, a clínica só revelou "não atendo plano" após 5h de ida e volta)
 *
 * Alergia ficou de fora de propósito (decisão do fundador): é colhida no primeiro pedido de
 * remédio, onde a pergunta é contextual e a taxa de resposta é maior que num questionário.
 */

export type OnboardingTopic = 'medication' | 'condition' | 'health_plan';

/** Janela em que o paciente ainda conta como "novo" pra receber as perguntas. */
export const ONBOARDING_QUESTIONS_WINDOW_MS = 14 * 24 * 60 * 60_000;

export interface OnboardingQuestionsInput {
  /** `not_started` | `consent_pending` | `profiling` | `active` — só `active` libera. */
  onboardingStatus?: string | null;
  createdAtIso?: string | null;
  nowMs: number;
  hasMedications: boolean;
  hasConditions: boolean;
  hasHealthPlan: boolean;
  /** Já ofereceu nesta conversa (derivado do histórico, sem gravar nada). */
  alreadyOffered: boolean;
  /** Recusou antes (users.metadata.onboarding_qs_declined) — parada durável. */
  declined: boolean;
  /** Este turno é a captura do nome: não interromper a saudação/áudio. */
  isProfilingTurn: boolean;
}

export interface OnboardingQuestionsDecision {
  ask: boolean;
  missing: OnboardingTopic[];
}

export function shouldAskOnboardingQuestions(input: OnboardingQuestionsInput): OnboardingQuestionsDecision {
  const missing: OnboardingTopic[] = [];
  if (!input.hasMedications) missing.push('medication');
  if (!input.hasConditions) missing.push('condition');
  if (!input.hasHealthPlan) missing.push('health_plan');

  const createdMs = input.createdAtIso ? new Date(input.createdAtIso).getTime() : NaN;
  const isNew = Number.isFinite(createdMs) && input.nowMs - createdMs < ONBOARDING_QUESTIONS_WINDOW_MS;

  const ask =
    input.onboardingStatus === 'active' // consentimento + nome já concluídos
    && isNew
    && missing.length > 0
    && !input.alreadyOffered
    && !input.declined
    && !input.isProfilingTurn;

  return { ask, missing };
}
