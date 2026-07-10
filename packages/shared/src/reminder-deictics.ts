/**
 * Re-ancoragem de dêiticos temporais no body de lembretes (incidente Elizabeth 09/07).
 *
 * O `body` de um lembrete é REDIGIDO na criação mas LIDO no disparo. O LLM copia o
 * dêitico da fala do usuário ("me lembra da quimioterapia AMANHÃ às 7h") e o texto
 * congela: no dia seguinte, às 7h, a paciente recebeu "AMANHÃ é dia da quimioterapia"
 * — no exato dia da quimio. Caso real, paciente oncológica, 09/07/2026.
 *
 * O insight que resolve sem quebrar a véspera legítima: um dêitico escrito no dia D
 * denota uma DATA ABSOLUTA (amanhã→D+1, hoje→D, depois de amanhã→D+2). Resolvemos o
 * dêitico pra data absoluta usando o dia da AUTORIA e re-renderizamos relativo ao dia
 * do DISPARO:
 *   - Elizabeth: "amanhã"@08/07 → evento 09/07; dispara 09/07 → diff 0 → "hoje" ✓
 *   - Véspera com event_at: dispara 12/07, evento 13/07 → diff 1 → "amanhã" mantido ✓
 *   - Recorrentes ("você tomou a creatina hoje?"): criado dias antes → diff negativo
 *     → INALTERADO (o "hoje" genérico de recorrente é sempre correto no disparo) ✓
 *
 * Conservador por design: só reescreve quando o diff re-renderizado cai em
 * {hoje, amanhã, depois de amanhã}; qualquer coisa fora (negativo, >2, data inválida)
 * mantém o texto original — nunca piorar é mais importante que sempre corrigir.
 *
 * Aplicado em DOIS pontos (mesma função, idempotente):
 *   1. criação (handleCreateReminder) — corrige o que o LLM acabou de redigir;
 *   2. disparo (reminder-dispatcher) — corrige rows LEGADAS criadas antes do fix.
 */

export interface NormalizeReminderBodyOpts {
  /** Quando o body foi redigido (criação do lembrete). */
  authoredAtIso: string;
  /** Quando o body vai ser lido (next_run_at na criação; now no disparo). */
  fireAtIso: string;
  /** Data/hora do EVENTO em si (tool arg event_at), quando o LLM informou. */
  eventAtIso?: string | null;
  /** Fuso do usuário (default America/Sao_Paulo) — dias viram no fuso DELE. */
  timeZone?: string | null;
}

export interface NormalizeReminderBodyResult {
  body: string;
  changed: boolean;
}

const DEFAULT_TZ = 'America/Sao_Paulo';

/** Nº do dia civil (dias desde epoch) do instante `iso` no fuso `tz`. NaN se inválido. */
function civilDayNumber(iso: string, tz: string): number {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return NaN;
  // en-CA = YYYY-MM-DD; parse como UTC-midnight dá um ordinal estável pra subtração.
  // try/catch: users.timezone é text livre no banco — um tz não-IANA ("Brasilia") faz o
  // Intl LANÇAR RangeError, e no dispatcher isso rodava DEPOIS do claim (one-shot ficaria
  // 'sent' sem nunca ser enviado + tick abortado). NaN → fail-open (body intacto).
  try {
    const ymd = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date(t));
    return Math.floor(Date.parse(`${ymd}T00:00:00Z`) / 86_400_000);
  } catch {
    return NaN;
  }
}

// "depois de amanhã" antes de "amanhã" (contém); \b não cobre acento no fim → lookahead.
const DEICTIC_RE = /\bdepois\s+de\s+amanh[ãa](?![\p{L}\p{N}])|\bamanh[ãa](?![\p{L}\p{N}])|\bhoje\b/giu;

function deicticOffset(match: string): number {
  const m = match.toLowerCase();
  if (m.startsWith('depois')) return 2;
  if (m.startsWith('amanh')) return 1;
  return 0; // hoje
}

function renderDiff(diff: number): string | null {
  if (diff === 0) return 'hoje';
  if (diff === 1) return 'amanhã';
  if (diff === 2) return 'depois de amanhã';
  return null; // fora do alcance dêitico → não mexe
}

/** Preserva a capitalização do original ("Amanhã é..." → "Hoje é..."). */
function matchCase(replacement: string, original: string): string {
  if (/^\p{Lu}/u.test(original)) {
    return replacement.charAt(0).toUpperCase() + replacement.slice(1);
  }
  return replacement;
}

export function normalizeReminderBody(
  body: string | null | undefined,
  opts: NormalizeReminderBodyOpts,
): NormalizeReminderBodyResult {
  const original = (body ?? '').toString();
  if (!original.trim()) return { body: original, changed: false };

  const tz = opts.timeZone?.trim() || DEFAULT_TZ;
  const authoredDay = civilDayNumber(opts.authoredAtIso, tz);
  const fireDay = civilDayNumber(opts.fireAtIso, tz);
  if (Number.isNaN(authoredDay) || Number.isNaN(fireDay)) {
    return { body: original, changed: false };
  }

  // event_at (quando o LLM informou) ancora o dêitico — MAS só quando o body tem UM único
  // dêitico. Com dêiticos MISTOS ("Amanhã é a consulta! Hoje separa os exames"), aplicar o
  // event_at a todos corromperia o "hoje" da instrução de preparo (→ "amanhã") — nesse caso
  // cada dêitico infere sua própria data pela autoria, que resolve o caso misto correto
  // (review 10/07, achado #11).
  const deicticCount = (original.match(DEICTIC_RE) ?? []).length;
  const explicitEventDay = deicticCount === 1 && opts.eventAtIso?.trim()
    ? civilDayNumber(opts.eventAtIso, tz)
    : NaN;

  let changed = false;
  const rewritten = original.replace(DEICTIC_RE, (match) => {
    const eventDay = Number.isNaN(explicitEventDay)
      ? authoredDay + deicticOffset(match)
      : explicitEventDay;
    const replacement = renderDiff(eventDay - fireDay);
    if (replacement === null) return match; // conservador: fora do alcance, não mexe
    const cased = matchCase(replacement, match);
    if (cased !== match) changed = true;
    return cased;
  });

  return { body: rewritten, changed };
}
