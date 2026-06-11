/**
 * RRULE mínimo com timezone — o suficiente pros lembretes da Xarlote.
 *
 * Por que não a lib `rrule`: ela ignora timezone por padrão (tudo em UTC) e o
 * bug que matava os lembretes era exatamente esse — BYHOUR=8 disparando às 5h
 * do Brasil. Aqui TODO BYHOUR/BYMINUTE é interpretado em America/Sao_Paulo
 * (horário de Brasília), que é o contrato com a LLM (ver xarlote-tools).
 *
 * Suporta o que o sistema gera + o que a LLM costuma emitir:
 *   FREQ=DAILY;BYHOUR=8;BYMINUTE=0            (com INTERVAL opcional)
 *   FREQ=WEEKLY;BYDAY=MO,QU;BYHOUR=9          (BYDAY default: qualquer dia)
 *   FREQ=MONTHLY;BYMONTHDAY=15;BYHOUR=10
 *   FREQ=HOURLY;INTERVAL=2                    (passo a partir do `from`)
 *   FREQ=MINUTELY;INTERVAL=30
 */

export const REMINDER_TZ = 'America/Sao_Paulo';

const WEEKDAYS: Record<string, number> = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

export interface ParsedRrule {
  freq: 'MINUTELY' | 'HOURLY' | 'DAILY' | 'WEEKLY' | 'MONTHLY';
  interval: number;
  byHour?: number;
  byMinute?: number;
  byDays?: number[]; // 0=domingo … 6=sábado
  byMonthDay?: number;
}

export function parseRrule(rrule: string): ParsedRrule | null {
  const body = rrule.trim().replace(/^RRULE:/i, '');
  const fields = new Map<string, string>();
  for (const part of body.split(';')) {
    const [k, v] = part.split('=');
    if (k && v) fields.set(k.trim().toUpperCase(), v.trim().toUpperCase());
  }

  const freq = fields.get('FREQ') as ParsedRrule['freq'] | undefined;
  if (!freq || !['MINUTELY', 'HOURLY', 'DAILY', 'WEEKLY', 'MONTHLY'].includes(freq)) return null;

  const interval = Math.max(1, parseInt(fields.get('INTERVAL') ?? '1', 10) || 1);

  const parsed: ParsedRrule = { freq, interval };

  const byHour = fields.get('BYHOUR');
  if (byHour !== undefined) {
    const h = parseInt(byHour, 10);
    if (!Number.isNaN(h) && h >= 0 && h <= 23) parsed.byHour = h;
  }
  const byMinute = fields.get('BYMINUTE');
  if (byMinute !== undefined) {
    const m = parseInt(byMinute, 10);
    if (!Number.isNaN(m) && m >= 0 && m <= 59) parsed.byMinute = m;
  }
  const byDay = fields.get('BYDAY');
  if (byDay) {
    // Aceita também formas com ordinal tipo "1MO" — ignora o ordinal.
    const days = byDay
      .split(',')
      .map((d) => WEEKDAYS[d.replace(/^[+-]?\d+/, '')])
      .filter((d): d is number => d !== undefined);
    if (days.length) parsed.byDays = days;
  }
  const byMonthDay = fields.get('BYMONTHDAY');
  if (byMonthDay !== undefined) {
    const d = parseInt(byMonthDay, 10);
    if (!Number.isNaN(d) && d >= 1 && d <= 31) parsed.byMonthDay = d;
  }

  return parsed;
}

interface WallClock {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number; // 0=domingo
}

function wallClockIn(tz: string, date: Date): WallClock {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    weekday: 'short',
    hour12: false,
  });
  const parts: Record<string, string> = {};
  for (const p of dtf.formatToParts(date)) parts[p.type] = p.value;
  const wdMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    year: Number(parts['year']),
    month: Number(parts['month']),
    day: Number(parts['day']),
    hour: parts['hour'] === '24' ? 0 : Number(parts['hour']),
    minute: Number(parts['minute']),
    second: Number(parts['second']),
    weekday: wdMap[parts['weekday'] ?? 'Sun'] ?? 0,
  };
}

/**
 * Constrói o instante UTC correspondente a um wall-clock no timezone dado.
 * Duas passadas pra convergir em bordas de DST (Brasil não tem DST desde 2019,
 * mas o algoritmo fica correto pra qualquer tz).
 */
function zonedToUtc(tz: string, y: number, mo: number, d: number, h: number, mi: number): Date {
  let guess = Date.UTC(y, mo - 1, d, h, mi, 0, 0);
  for (let i = 0; i < 2; i++) {
    const wc = wallClockIn(tz, new Date(guess));
    const asUtc = Date.UTC(wc.year, wc.month - 1, wc.day, wc.hour, wc.minute, wc.second);
    const want = Date.UTC(y, mo - 1, d, h, mi, 0, 0);
    guess += want - asUtc;
  }
  return new Date(guess);
}

function addDays(tz: string, wc: WallClock, days: number): WallClock {
  // Soma em UTC ao meio-dia pra não escorregar de dia em borda de offset.
  const noon = new Date(Date.UTC(wc.year, wc.month - 1, wc.day + days, 12, 0, 0));
  const out = wallClockIn('UTC', noon);
  return { ...out, weekday: noon.getUTCDay() };
}

/**
 * Próxima ocorrência ESTRITAMENTE depois de `from`, no horário de Brasília.
 * Retorna null se o rrule for inválido/não suportado (caller decide fallback).
 */
export function nextOccurrence(rrule: string, from: Date = new Date(), tz: string = REMINDER_TZ): Date | null {
  const rule = parseRrule(rrule);
  if (!rule) return null;

  // Frequências de passo curto: avança a partir do `from`, alinhando BYMINUTE.
  if (rule.freq === 'MINUTELY') {
    return new Date(from.getTime() + rule.interval * 60_000);
  }
  if (rule.freq === 'HOURLY') {
    const next = new Date(from.getTime() + rule.interval * 3_600_000);
    if (rule.byMinute !== undefined) {
      next.setUTCMinutes(rule.byMinute, 0, 0);
      if (next.getTime() <= from.getTime()) next.setTime(next.getTime() + 3_600_000);
    } else {
      next.setUTCSeconds(0, 0);
    }
    return next;
  }

  const fromWc = wallClockIn(tz, from);
  // Sem BYHOUR explícito, mantém a hora do próprio `from` (ex: disparou 8h10 →
  // próximo dia 8h10) — melhor que inventar um default fixo.
  const hour = rule.byHour ?? fromWc.hour;
  const minute = rule.byMinute ?? (rule.byHour !== undefined ? 0 : fromWc.minute);

  if (rule.freq === 'DAILY' || rule.freq === 'WEEKLY') {
    // Caminhada dia a dia (limite 7 semanas — cobre WEEKLY de qualquer BYDAY).
    const stepOk = (offset: number): boolean => {
      if (rule.freq === 'DAILY') return offset % rule.interval === 0;
      return true; // WEEKLY: byDays decide; INTERVAL>1 sem anchor → tratado como 1
    };
    const wantedDays = rule.freq === 'WEEKLY' ? (rule.byDays ?? [fromWc.weekday]) : null;
    for (let offset = 0; offset <= 49; offset++) {
      if (!stepOk(offset)) continue;
      const day = addDays(tz, fromWc, offset);
      if (wantedDays && !wantedDays.includes(day.weekday)) continue;
      const candidate = zonedToUtc(tz, day.year, day.month, day.day, hour, minute);
      if (candidate.getTime() > from.getTime()) return candidate;
    }
    return null;
  }

  // MONTHLY
  const targetDay = rule.byMonthDay ?? fromWc.day;
  for (let i = 0; i <= 24; i += rule.interval) {
    const y = fromWc.year + Math.floor((fromWc.month - 1 + i) / 12);
    const mo = ((fromWc.month - 1 + i) % 12) + 1;
    const daysInMonth = new Date(Date.UTC(y, mo, 0)).getUTCDate();
    if (targetDay > daysInMonth) continue; // ex: dia 31 em fevereiro → pula o mês
    const candidate = zonedToUtc(tz, y, mo, targetDay, hour, minute);
    if (candidate.getTime() > from.getTime()) return candidate;
  }
  return null;
}
