/**
 * appointment-consent — a invariante: NINGUÉM fecha consulta no lugar do paciente.
 *
 * ─── O QUE QUEBROU (caso Duda, 24/08/2026) ────────────────────────────────────
 * Às 15:47 a recepção mandou "Quarta 26/Agosto 18h" com as condições de pagamento.
 * Às 15:48:02 o backstop determinístico gravou `scheduled`. Às 15:48:05 a paciente
 * recebeu "Confirmado, Duda! 🎉". Às 15:48:22 a clínica ainda perguntava
 * "Vamos agendar?" — porque nada tinha sido agendado.
 *
 * A Duda nunca escolheu horário nenhum. Trinta segundos antes ela tinha lido, da
 * própria Xarlote, "vou aguardar mais umas pra te trazer as melhores opções".
 *
 * ─── A RAIZ ───────────────────────────────────────────────────────────────────
 * O código tratava como um só três fatos distintos:
 *
 *   (A) a clínica OFERECEU um horário
 *   (B) o paciente ESCOLHEU aquele horário
 *   (C) a clínica RESERVOU o horário
 *
 * O caminho feliz — `confirm_consultation_selection` → `confirming` → reconfirmação —
 * exige (B). Mas os backstops determinísticos, criados em 04/08 pra salvar o caso da
 * Rita (a clínica confirmou, o LLM voltou vazio e ninguém registrou), viravam evidência
 * de (A) direto em (C), sem passar por (B). O remédio de um incidente abriu o outro.
 *
 * ─── A REGRA ──────────────────────────────────────────────────────────────────
 * `scheduled` exige consentimento REGISTRADO do paciente PARA AQUELE HORÁRIO. Sem ele,
 * a fala da clínica é OFERTA — vai pro paciente decidir, e nada se perde.
 *
 * Um "não" deste gate nunca descarta informação: quem chama recebe o motivo e é
 * obrigado a registrar a oferta. Falha nunca vira sucesso, e agora também não vira
 * silêncio.
 *
 * PURO: sem I/O, sem relógio. Testável frase a frase.
 */

/** De onde veio o fechamento. Espelha `CommitSource` do handler. */
export type ConsentSource = 'clinic_tool' | 'clinic_detected' | 'patient_selection' | 'integrity_worker';

/** O consentimento do paciente, como fica gravado em `consultations.preferences`. */
export interface PatientChoice {
  /** Cotação escolhida. `null` em contraproposta que ainda não virou cotação. */
  quoteId: string | null;
  /** Horário que ELE aceitou. É contra este que a fala da clínica é conferida. */
  iso: string | null;
  /** Quando escolheu (ISO). */
  at: string;
  /** `tool` = ele disse na conversa; `manual` = reparo humano, sempre auditado. */
  via: 'tool' | 'manual';
}

export interface ConsentState {
  status: string;
  selectedQuoteId: string | null;
  /** `scheduled_at` da consulta — o slot que já estava na mesa. */
  scheduledAt: string | null;
  patientChoice: PatientChoice | null;
}

export type ConsentDenial =
  | 'consulta_terminal'
  | 'sem_escolha_do_paciente'
  | 'escolha_de_outro_horario';

export type GateVerdict =
  | { allow: true; because: string }
  | { allow: false; reason: ConsentDenial; explain: string };

/** Tolerância pra casar dois horários vindos de caminhos diferentes. */
export const CONSENT_SLOT_TOLERANCE_MS = 60_000;

const TERMINAIS = new Set(['cancelled', 'completed']);

function mesmoSlot(a: string | null | undefined, b: string | null | undefined, tol: number): boolean {
  if (!a || !b) return false;
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return false;
  return Math.abs(ta - tb) <= tol;
}

/**
 * Chave da porta pra `scheduled`.
 *
 * Ordem das regras, e o porquê de cada posição:
 *  1. terminal — nada ressuscita consulta cancelada;
 *  2. idempotência — já fechada NESTE horário: reparo e re-commit passam, senão o
 *     worker de integridade não conseguiria consertar lembrete de consulta legítima;
 *  3. o próprio paciente — `patient_selection` É o consentimento;
 *  4. escolha registrada que CASA com o horário — o caminho normal;
 *  5. escolha registrada de OUTRO horário — a clínica mudou o combinado. Isso volta
 *     ao paciente; não é detalhe, é outra consulta pra vida dele;
 *  6. estado legado `confirming` + slot na mesa — cobre as consultas que entraram em
 *     `confirming` antes de `_patient_choice` existir. Sem esta regra, subir o gate
 *     quebraria toda consulta em andamento;
 *  7. resto — nega.
 */
export function mayDeclareScheduled(
  state: ConsentState,
  slotIso: string,
  source: ConsentSource,
  toleranceMs: number = CONSENT_SLOT_TOLERANCE_MS,
): GateVerdict {
  if (TERMINAIS.has(state.status)) {
    return { allow: false, reason: 'consulta_terminal', explain: `consulta está ${state.status}` };
  }

  if (state.status === 'scheduled' && mesmoSlot(state.scheduledAt, slotIso, toleranceMs)) {
    return { allow: true, because: 'já fechada neste mesmo horário (idempotente)' };
  }

  if (source === 'patient_selection') {
    return { allow: true, because: 'a origem é a escolha do próprio paciente' };
  }

  const escolha = state.patientChoice;
  if (escolha) {
    if (mesmoSlot(escolha.iso, slotIso, toleranceMs)) {
      return { allow: true, because: `o paciente escolheu este horário em ${escolha.at}` };
    }
    return {
      allow: false,
      reason: 'escolha_de_outro_horario',
      explain: `o paciente escolheu ${escolha.iso ?? '(sem horário)'} e a clínica está fechando ${slotIso} — mudança de combinado volta pra ele decidir`,
    };
  }

  if (state.status === 'confirming' && mesmoSlot(state.scheduledAt, slotIso, toleranceMs)) {
    return { allow: true, because: 'consulta em `confirming` no horário que o paciente já havia selecionado' };
  }

  return {
    allow: false,
    reason: 'sem_escolha_do_paciente',
    explain: `consulta em "${state.status}" e nenhuma escolha do paciente registrada pra ${slotIso} — a fala da clínica vale como OFERTA, não como fechamento`,
  };
}

/** Onde o consentimento mora dentro de `consultations.preferences`. */
export const CHAVE_ESCOLHA = '_patient_choice';

/** Lê o consentimento gravado. Tolerante a JSONB velho/torto — nunca lança. */
export function lerEscolhaDoPaciente(preferences: unknown): PatientChoice | null {
  if (!preferences || typeof preferences !== 'object') return null;
  const bruto = (preferences as Record<string, unknown>)[CHAVE_ESCOLHA];
  if (!bruto || typeof bruto !== 'object') return null;
  const o = bruto as Record<string, unknown>;
  const at = typeof o['at'] === 'string' ? o['at'] : null;
  if (!at) return null;
  return {
    quoteId: typeof o['quoteId'] === 'string' ? o['quoteId'] : null,
    iso: typeof o['iso'] === 'string' ? o['iso'] : null,
    at,
    via: o['via'] === 'manual' ? 'manual' : 'tool',
  };
}

/**
 * Devolve `preferences` com o consentimento gravado. Não muta a entrada — o chamador
 * grava o resultado, e é ele quem tem o lock/CAS.
 */
export function gravarEscolhaDoPaciente(
  preferences: unknown,
  escolha: PatientChoice,
): Record<string, unknown> {
  const base = (preferences && typeof preferences === 'object' ? preferences : {}) as Record<string, unknown>;
  return { ...base, [CHAVE_ESCOLHA]: escolha };
}
