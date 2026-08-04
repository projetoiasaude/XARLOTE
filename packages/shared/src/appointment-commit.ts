/**
 * appointment-commit — classifica o que a RECEPÇÃO acabou de dizer sobre um horário:
 * ela está OFERECENDO ("tenho disponível amanhã às 8:30") ou FECHANDO
 * ("ficou então para o dia 26/08 às 10 horas")? PURO e testável.
 *
 * POR QUE ISTO EXISTE (auditoria 04/08):
 * às 18:20 de 03/08 a Rita escreveu "Ficou então para o dia 26/08 quarta feira ás 10
 * horas, obrigada" — a confirmação da PRIMEIRA consulta agendada da história do
 * sistema. O LLM do agente-clínica voltou COMPLETAMENTE vazio (sem texto e sem tool),
 * e o único detector de confirmação que existia era um teste de ESTADO
 * (`quote='selected'` + consulta em `confirming`), estado que aquela consulta nunca
 * alcançou. Resultado: a clínica confirmou, o banco não registrou nada, e quem avisou
 * o paciente foi um humano no terminal.
 *
 * A regra deste módulo é assimetria de risco: dizer ao paciente "está confirmado"
 * quando não está é MUITO pior que não detectar. Então só é `commitment` com verbo de
 * FECHAMENTO explícito. Vocabulário de oferta e pergunta derrubam a classificação.
 *
 * O módulo NÃO decide sozinho: afirmação seca ("ok", "sim") só vale como confirmação
 * combinada com estado, e essa combinação é do handler — aqui ela sai separada em
 * `isBareAffirmation`.
 */
import { parseBrDateTimes, foldPt, type BrDateTimeHit } from './br-datetime.js';

export type ClinicSlotIntent = 'commitment' | 'offer' | 'neither';

export interface ClinicSlotReading {
  kind: ClinicSlotIntent;
  /** Data/horas encontradas no texto, na ordem em que aparecem. */
  datetimes: BrDateTimeHit[];
  /**
   * `true` quando é fechamento SEM data no texto ("confirmado!", "está agendado") —
   * o horário tem que vir da cotação que estava na mesa. Nunca inventar.
   */
  needsAnchor: boolean;
  /** Marcador que decidiu a classificação — vai pro log, pra auditoria ser legível. */
  matched: string | null;
}

/**
 * Verbos de FECHAMENTO. A recepção está afirmando um agendamento como FATO.
 * Deliberadamente estreito: cada entrada aqui é uma frase que só se escreve quando
 * a vaga já foi reservada.
 */
const CLOSING_MARKERS: Array<[RegExp, string]> = [
  [/\bfic(?:ou|a|amos)\b[^.!?]{0,20}\b(?:pra|para)\b/, 'ficou para'],
  [/\b(?:esta|ta|estara)\s+(?:marcad|agendad|reservad|confirmad)/, 'está marcado'],
  [/\b(?:marquei|agendei|reservei|encaixei|confirmei)\b/, 'marquei/agendei'],
  [/\b(?:marcad|agendad|reservad|confirmad)[ao]s?\b/, 'marcado/confirmado'],
  [/\banotei\b[^.!?]{0,20}\b(?:pra|para|o dia|no dia)\b/, 'anotei para'],
  [/\bdeixei\b[^.!?]{0,20}\b(?:marcad|agendad|reservad)/, 'deixei marcado'],
  [/\bconsegui\s+encaixar\b/, 'consegui encaixar'],
  [/\bfechad[ao]\b[^.!?]{0,20}\b(?:pra|para)\b/, 'fechado para'],
  [/\b(?:pode|podem)\s+(?:vir|comparecer)\b/, 'pode vir'],
  [/\b(?:te|o|a|lhe)\s+esperamos\b/, 'esperamos'],
];

/**
 * Vocabulário de OFERTA. Se aparece, a recepção está colocando opções na mesa —
 * não fechando. Vence o fechamento em caso de empate (conservador de propósito).
 */
const OFFER_MARKERS: Array<[RegExp, string]> = [
  [/\b(?:tenho|temos|tem|ha|havia)\b[^.!?]{0,24}\b(?:horario|vaga|disponibilidade|disponivel|disponiveis)\b/, 'tenho horário'],
  [/\bdisponi(?:vel|veis|bilidade)\b/, 'disponível'],
  [/\bteria(?:mos)?\b/, 'teria'],
  [/\b(?:qual|quais)\b[^.!?]{0,24}\b(?:prefere|melhor|serve|fica)\b/, 'qual prefere'],
  [/\b(?:pode|poderia)\s+ser\b/, 'pode ser'],
  [/\b(?:vagas?|encaixe)\b/, 'vaga'],
  [/\bopc(?:ao|oes)\b/, 'opção'],
  [/\bou\s+ent[ao]{1,2}\b/, 'ou então'],
];

/** Afirmações secas — só valem como confirmação SOMADAS a estado (ver doc do módulo). */
const BARE_AFFIRMATIONS = new Set([
  'ok', 'okay', 'ok!', 'isso', 'isso mesmo', 'sim', 'certo', 'perfeito', 'combinado',
  'pode', 'pode sim', 'claro', 'tudo bem', 'blz', 'beleza', 'ta bom', 'esta bom',
]);

/** `true` se o texto é só um "ok"/"isso"/"sim" (com ou sem pontuação/emoji). */
export function isBareAffirmation(text: string): boolean {
  const f = foldPt(text)
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!f || f.length > 22) return false;
  return BARE_AFFIRMATIONS.has(f);
}

function firstMatch(folded: string, table: Array<[RegExp, string]>): string | null {
  for (const [re, label] of table) if (re.test(folded)) return label;
  return null;
}

/**
 * Lê a mensagem da recepção e classifica.
 *
 * `commitment` exige verbo de fechamento E ausência de vocabulário de oferta E que
 * a frase não seja pergunta. Qualquer dúvida cai em `offer` — que é reversível.
 */
export function readClinicSlotMessage(text: string, nowMs: number): ClinicSlotReading {
  const raw = (text ?? '').trim();
  const folded = foldPt(raw);
  const datetimes = parseBrDateTimes(raw, nowMs);

  const offer = firstMatch(folded, OFFER_MARKERS);
  const closing = firstMatch(folded, CLOSING_MARKERS);
  // Pergunta ("marcamos pra quarta?") NUNCA é fechamento — quem pergunta não fechou.
  const isQuestion = /\?\s*$/.test(raw) || /\?/.test(raw);

  if (closing && !offer && !isQuestion) {
    return { kind: 'commitment', datetimes, needsAnchor: datetimes.length === 0, matched: closing };
  }
  if (datetimes.length > 0) {
    return { kind: 'offer', datetimes, needsAnchor: false, matched: offer ?? (closing ? `${closing} (ambíguo → tratado como oferta)` : null) };
  }
  return { kind: 'neither', datetimes: [], needsAnchor: false, matched: offer ?? closing };
}

/** Tolerância pra casar duas datas "iguais" vindas de caminhos diferentes. */
export const SLOT_MATCH_TOLERANCE_MS = 60_000;

/** `true` se duas data/horas representam o MESMO slot (tolera segundos de diferença). */
export function sameSlot(a: string | null | undefined, b: string | null | undefined, toleranceMs = SLOT_MATCH_TOLERANCE_MS): boolean {
  if (!a || !b) return false;
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return false;
  return Math.abs(ta - tb) <= toleranceMs;
}

/**
 * Decide QUAL horário um fechamento confirmou.
 *
 * Preferência: (1) data no próprio texto que casa com um slot já na mesa — a prova
 * mais forte que existe, a recepção repetiu o que combinamos; (2) data no texto sem
 * casar com nada — vale, é o que ela escreveu, mas o chamador registra como novo;
 * (3) sem data no texto → a âncora (o slot que estava na mesa).
 */
export function resolveCommittedSlot(
  reading: ClinicSlotReading,
  slotsOnTable: Array<string | null | undefined>,
  anchorIso: string | null | undefined,
): { iso: string; source: 'text-matched' | 'text-new' | 'anchor' } | null {
  if (reading.kind !== 'commitment') return null;

  for (const hit of reading.datetimes) {
    if (slotsOnTable.some((s) => sameSlot(s, hit.iso))) {
      return { iso: hit.iso, source: 'text-matched' };
    }
  }
  const first = reading.datetimes[0];
  if (first) return { iso: first.iso, source: 'text-new' };
  if (anchorIso) return { iso: anchorIso, source: 'anchor' };
  return null;
}
