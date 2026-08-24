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
  /**
   * Quando havia verbo de fechamento no texto e ele foi DERRUBADO, o que o derrubou.
   * `null` quando não havia verbo de fechamento nenhum (não há o que derrubar).
   *
   * Existe pro log dizer *por que* não fechou. Sem isto, "a clínica falou de horário e
   * nada aconteceu" é indistinguível de "o detector não viu nada" — e foi justamente
   * um fechamento indevido que custou a confiança da Duda em 24/08.
   */
  blockedBy: string | null;
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

/**
 * CONDIÇÃO SOBRE A RESERVA — prova do CONTRÁRIO, não mera ausência de prova.
 *
 * ─── CASO DUDA, 24/08/2026 ───────────────────────────────────────────────────
 * A recepção da Dra Mayra escreveu, na mesma mensagem que trazia o horário:
 *
 *   "Ressaltamos que a reserva do horário SÓ SERÁ CONFIRMADA após a realização do
 *    pagamento inicial."
 *
 * A palavra `confirmada` casou com o verbo de fechamento `confirmad[ao]s?`. Não havia
 * `?` na mensagem e nenhum marcador de oferta bateu, então o texto virou `commitment`,
 * o horário foi fechado e a paciente — que nunca escolheu nada — recebeu
 * "Confirmado, Duda! 🎉". A clínica, três segundos depois, ainda perguntava
 * "Vamos agendar?".
 *
 * A frase que dizia que a reserva NÃO estava confirmada foi exatamente a que fez o
 * sistema declará-la confirmada.
 *
 * ─── A REGRA ─────────────────────────────────────────────────────────────────
 * Quem escreve "só será confirmada após X" está afirmando, na MESMA oração, que ela
 * ainda não está. Análise léxica de verbo não enxerga polaridade nem modalidade: o
 * verbo aparece igual em "está confirmada" e em "será confirmada mediante depósito".
 * Estes marcadores capturam a modalidade — condicional, futuro condicionado e
 * cláusula de finalidade — e VETAM o fechamento.
 *
 * Falso positivo aqui custa uma pergunta a mais ao paciente. Falso negativo custa uma
 * consulta que ele acha que tem e não tem. A assimetria decide o desenho.
 */
const CONDITIONAL_MARKERS: Array<[RegExp, string]> = [
  // "só será confirmada", "somente após", "apenas mediante"
  [/\b(?:so|somente|apenas)\b[^.!?]{0,40}\b(?:apos|depois|mediante|quando|assim\s+que)\b/, 'só … após'],
  [/\b(?:so|somente|apenas)\s+(?:sera|serao|estara|estarao|fica|ficara)\b/, 'só será'],
  // Futuro sobre o ato de reservar: "será confirmada", "ficará reservado"
  [/\b(?:sera|serao|estara|estarao|ficara|ficarao)\b[^.!?]{0,30}\b(?:confirmad|reservad|garantid|agendad|marcad|efetivad)/, 'será confirmada'],
  // A reserva pendurada num pagamento/documento
  [/\b(?:apos|mediante|depois\s+d[aeo]|assim\s+que|somente\s+com|mmediante)\b[^.!?]{0,45}\b(?:pagament|deposit|transferenc|pix|comprovant|sinal|entrada|adiantament|agendament)\w*/, 'após o pagamento'],
  // Cláusula de finalidade: "para garantir seu agendamento, solicitamos…"
  [/\bpara\s+(?:garantir|confirmar|reservar|efetivar|assegurar)\b/, 'para garantir'],
  // Exigência explícita antes de reservar
  [/\b(?:precis\w+|necessario|solicitamos|pedimos|exigimos)\b[^.!?]{0,45}\b(?:pagament|deposit|pix|comprovant|sinal|entrada|foto|pedido|encaminhament|document|carteirinha|guia)\w*/, 'exige pagamento/documento'],
];

/**
 * NEGAÇÃO sobre o fechamento. "Ainda não está confirmado" tem o verbo de fechamento
 * dentro e significa o oposto dele.
 */
const NEGATION_MARKERS: Array<[RegExp, string]> = [
  [/\bnao\b[^.!?]{0,25}\b(?:confirmad|reservad|agendad|marcad|garantid|fechad)/, 'não confirmado'],
  [/\b(?:confirmad|reservad|agendad|marcad)\w*\b[^.!?]{0,15}\bnao\b/, 'confirmado … não'],
  [/\bainda\s+nao\b/, 'ainda não'],
  [/\b(?:sem|falta|faltando|pendente\s+de)\b[^.!?]{0,25}\b(?:confirmacao|reserva|pagament|deposit|comprovant)\w*/, 'sem confirmação'],
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
 * `commitment` exige verbo de fechamento E ausência de vocabulário de oferta E que a
 * frase não seja pergunta E que não haja condição nem negação sobre a reserva.
 * Qualquer dúvida cai em `offer` — que é reversível, porque volta ao paciente.
 */
export function readClinicSlotMessage(text: string, nowMs: number): ClinicSlotReading {
  const raw = (text ?? '').trim();
  const folded = foldPt(raw);
  const datetimes = parseBrDateTimes(raw, nowMs);

  const offer = firstMatch(folded, OFFER_MARKERS);
  const closing = firstMatch(folded, CLOSING_MARKERS);
  const conditional = firstMatch(folded, CONDITIONAL_MARKERS);
  const negated = firstMatch(folded, NEGATION_MARKERS);
  // Pergunta ("marcamos pra quarta?") NUNCA é fechamento — quem pergunta não fechou.
  const isQuestion = /\?/.test(raw);

  // Só faz sentido falar em "derrubado" se havia um verbo de fechamento pra derrubar.
  // A ordem é a da força da evidência contrária: negação explícita > condição > pergunta
  // > vocabulário de oferta na mesma frase.
  const blockedBy = closing
    ? (negated ?? conditional ?? (isQuestion ? 'pergunta' : null) ?? (offer ? `oferta (${offer})` : null))
    : null;

  if (closing && !blockedBy) {
    return { kind: 'commitment', datetimes, needsAnchor: datetimes.length === 0, matched: closing, blockedBy: null };
  }
  if (datetimes.length > 0) {
    return {
      kind: 'offer',
      datetimes,
      needsAnchor: false,
      matched: offer ?? (closing ? `${closing} (derrubado por: ${blockedBy}) → oferta` : null),
      blockedBy,
    };
  }
  return { kind: 'neither', datetimes: [], needsAnchor: false, matched: offer ?? closing, blockedBy };
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
