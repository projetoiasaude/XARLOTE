/**
 * Decisão de fazer (ou não) as perguntas de conhecimento do paciente.
 *
 * Roda DEPOIS do onboarding existente — consentimento LGPD → nome → áudio de saudação —
 * que não é tocado por nada aqui: o gate exige `onboarding_status === 'active'`, estado que
 * só é atingido quando aquele fluxo terminou.
 *
 * O estado é DERIVADO do que já sabemos do paciente, não guardado numa máquina de estado
 * nova: cada pergunta desaparece sozinha quando o dado passa a existir. Isso evita migração,
 * evita flag pra corromper e é auto-corretivo (se o dado for apagado, a pergunta volta).
 *
 * ─── AUDITORIA 09/09/2026: A FEATURE EXISTIA E NUNCA DISPAROU ────────────────────────
 * Construída em 29/07 (`d6850d4`) e, em seis semanas com 6 pacientes elegíveis, a oferta
 * saiu **ZERO vezes** — "perguntinhas"/"conhecer melhor" não aparece em NENHUMA mensagem
 * da base. Duas causas, as duas corrigidas aqui:
 *
 *   1. A oferta dependia de o paciente "não trazer nada específico". Só que a própria
 *      saudação convidava o contrário ("Quer cotar algum remédio, tirar uma dúvida?"), e
 *      todos chegaram pedindo algo. A condição quase nunca existia. **Agora a oferta é
 *      PARTE da saudação determinística** (ver `saudacaoDeConhecimento`), não um "se".
 *   2. `alreadyOffered` matava o bloco inteiro. Como a saudação agora É a oferta, no turno
 *      seguinte — exatamente aquele em que a pessoa diz "sim" — o bloco sumiria e o modelo
 *      ficaria sem saber o que perguntar. **`alreadyOffered` deixou de ser gate**: virou
 *      um sinal que muda o TEXTO da orientação ("já ofereceu, não ofereça de novo").
 *
 * As 4 mudam O QUE ELA CONSEGUE FAZER, não são curiosidade:
 *   • alergia                   → é o dado de SEGURANÇA; ela cota remédio sem ele hoje
 *   • medicação de uso contínuo → destrava reposição automática e lembretes de rotina
 *   • condição acompanhada      → contexto clínico que ela nunca infere sozinha com segurança
 *   • convênio                  → permite priorizar clínicas que aceitam o plano
 *
 * ⚠️ Alergia entrou em 09/09 por decisão do fundador. Ela tinha ficado de fora em 29/07 pra
 * ser colhida "no 1º pedido de remédio, onde a pergunta é contextual" — mas as farmácias não
 * respondem, o 1º pedido raramente termina, e o resultado medido foi **1 de 25 pacientes
 * ativos com alergia registrada (4%)**. A hipótese era boa e a realidade a desmentiu.
 */

/** Ordem de valor: segurança primeiro. É a ordem em que a Xarlote pergunta. */
export type OnboardingTopic = 'allergy' | 'medication' | 'condition' | 'health_plan';

/** Janela em que o paciente ainda conta como "novo" pra receber as perguntas. */
export const ONBOARDING_QUESTIONS_WINDOW_MS = 14 * 24 * 60 * 60_000;

export interface OnboardingQuestionsInput {
  /** `not_started` | `consent_pending` | `profiling` | `active` — só `active` libera. */
  onboardingStatus?: string | null;
  createdAtIso?: string | null;
  nowMs: number;
  hasAllergies: boolean;
  hasMedications: boolean;
  hasConditions: boolean;
  hasHealthPlan: boolean;
  /**
   * A oferta já saiu nesta conversa (a saudação a contém). NÃO é mais gate — só muda a
   * orientação, pra ela não oferecer duas vezes e ir direto às perguntas com o "sim".
   */
  alreadyOffered: boolean;
  /** Recusou antes (users.metadata.onboarding_qs_declined) — parada durável. */
  declined: boolean;
  /** Este turno é a captura do nome: não interromper a saudação/áudio. */
  isProfilingTurn: boolean;
}

export interface OnboardingQuestionsDecision {
  ask: boolean;
  missing: OnboardingTopic[];
  /** Repassado pro call-site escolher o texto da orientação. */
  alreadyOffered: boolean;
}

export function shouldAskOnboardingQuestions(input: OnboardingQuestionsInput): OnboardingQuestionsDecision {
  const missing: OnboardingTopic[] = [];
  if (!input.hasAllergies) missing.push('allergy');
  if (!input.hasMedications) missing.push('medication');
  if (!input.hasConditions) missing.push('condition');
  if (!input.hasHealthPlan) missing.push('health_plan');

  const createdMs = input.createdAtIso ? new Date(input.createdAtIso).getTime() : NaN;
  const isNew = Number.isFinite(createdMs) && input.nowMs - createdMs < ONBOARDING_QUESTIONS_WINDOW_MS;

  const ask =
    input.onboardingStatus === 'active' // consentimento + nome já concluídos
    && isNew
    && missing.length > 0
    && !input.declined
    && !input.isProfilingTurn;

  return { ask, missing, alreadyOffered: input.alreadyOffered };
}

/**
 * A SAUDAÇÃO, montada pelo SERVIDOR (auditoria 09/09/2026).
 *
 * Por que não deixar o modelo escrever: este é o único turno cujo conteúdo certo é conhecido
 * de antemão, é o primeiro contato de voz da pessoa com a Xarlote, e é onde a oferta precisa
 * acontecer. Deixá-lo ao modelo custou caro — o **Rodrigo (24/08) recebeu como ÁUDIO de
 * boas-vindas a frase "Prontinho, já cuidei disso aqui! Precisa de mais alguma coisa?"**,
 * porque o modelo chamou `save_user_profile_fact` com payload VAZIO quatro vezes, não
 * escreveu texto, e o narrador genérico do turno só-tool virou a saudação. As outras quatro
 * saudações da base saíram com o texto IDÊNTICO — ou seja, o modelo já produzia uma frase
 * fixa. Fixá-la no servidor não perde nada e elimina a classe inteira de defeito.
 *
 * Sem travessão e sem vírgula depois de "Prazer": as duas são regra de persona, e a vírgula
 * cria pausa estranha no TTS.
 */
export function saudacaoDeConhecimento(nome: string | null | undefined): string {
  const n = (nome ?? '').trim();
  const abertura = n ? `Prazer ${n}!` : 'Prazer!';
  return `${abertura} Você já precisa de alguma coisa hoje? Ou posso te fazer algumas perguntinhas rápidas pra gente se conhecer melhor?`;
}

/** A oferta já saiu nesta conversa? Deriva do histórico, sem gravar nada. */
export const OFERTA_RE = /perguntinhas r[áa]pidas|(?:nos?|se|te|a gente) conhecer melhor/i;
