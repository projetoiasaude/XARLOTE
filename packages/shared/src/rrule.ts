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
 *   FREQ=DAILY;BYHOUR=8,20;BYMINUTE=0         (VÁRIOS horários no mesmo dia)
 *   FREQ=WEEKLY;BYDAY=MO,QU;BYHOUR=9          (BYDAY default: qualquer dia)
 *   FREQ=MONTHLY;BYMONTHDAY=15;BYHOUR=10
 *   FREQ=HOURLY;INTERVAL=2                    (passo a partir do `from`)
 *   FREQ=MINUTELY;INTERVAL=30
 *   …;UNTIL=20260913T235959-03:00             (FIM por data — inclusive)
 *   …;COUNT=10                                (FIM por número de ocorrências — exige âncora)
 *
 * ─── AUDITORIA 08/09/2026: COUNT, UNTIL e BYHOUR múltiplo eram IGNORADOS ───────────
 * O parser lia os campos e os descartava. Consequências reais, todas em produção:
 *   • "Levofloxacino 500mg" (antibiótico, 10 comprimidos) com COUNT=10 → dispararia PARA
 *     SEMPRE; "Domperidona (45 dias)" com COUNT=45 → idem;
 *   • "Bexxi 35mg" com UNTIL=17/08 continuou tocando até ser cancelado à mão em 26/08;
 *   • "Bexxi" com BYHOUR=8,20: `parseInt("8,20")` = 8 → a dose das 20h NUNCA existiu.
 * O modelo emitia a sintaxe certa desde julho e o motor calava. Agora os três valem, e
 * `fimDaRecorrencia` diz ao resto do sistema QUANDO um lembrete acaba — pra ninguém mais
 * ter que inventar ("faltam X dias").
 */

export const REMINDER_TZ = 'America/Sao_Paulo';

const WEEKDAYS: Record<string, number> = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

export interface ParsedRrule {
  freq: 'MINUTELY' | 'HOURLY' | 'DAILY' | 'WEEKLY' | 'MONTHLY';
  interval: number;
  /** Primeiro horário (compat). Com vários horários, veja `byHours`. */
  byHour?: number;
  /** TODOS os horários do dia, em ordem crescente (BYHOUR=8,20 → [8, 20]). */
  byHours?: number[];
  byMinute?: number;
  byDays?: number[]; // 0=domingo … 6=sábado
  byMonthDay?: number;
  /** Número máximo de ocorrências (RFC 5545). Só tem efeito com uma âncora de início. */
  count?: number;
  /** Última ocorrência permitida (inclusive). Já resolvida pra um instante UTC. */
  until?: Date;
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
    // "8,20" é lista, não número: `parseInt` devolvia 8 e a dose das 20h sumia em silêncio.
    const hs = [...new Set(byHour.split(',')
      .map((h) => parseInt(h, 10))
      .filter((h) => !Number.isNaN(h) && h >= 0 && h <= 23))]
      .sort((a, b) => a - b);
    if (hs.length) {
      parsed.byHour = hs[0];
      if (hs.length > 1) parsed.byHours = hs;
    }
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
  const count = fields.get('COUNT');
  if (count !== undefined) {
    const c = parseInt(count, 10);
    if (!Number.isNaN(c) && c >= 1) parsed.count = c;
  }
  const until = fields.get('UNTIL');
  if (until !== undefined) {
    const u = parseUntil(until);
    if (u) parsed.until = u;
  }

  return parsed;
}

/**
 * UNTIL em todas as grafias que o modelo já emitiu em produção:
 *   20260717T235959-03:00 · 20260717T235959Z · 20260717 · 2026-08-17T20:59:59-03:00 · 2026-08-17
 * Data sem hora = fim do dia em Brasília (inclusive). Sem offset = Brasília, não UTC — é o
 * contrato de TODO horário deste arquivo. Lixo → undefined (o rrule segue sem fim, e o
 * chamador decide se isso é aceitável).
 */
export function parseUntil(raw: string, tz: string = REMINDER_TZ): Date | undefined {
  const s = raw.trim();
  const m = /^(\d{4})-?(\d{2})-?(\d{2})(?:T(\d{2}):?(\d{2})(?::?(\d{2}))?(Z|[+-]\d{2}:?\d{2})?)?$/i.exec(s);
  if (!m) return undefined;
  const y = Number(m[1]); const mo = Number(m[2]); const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return undefined;
  if (m[4] === undefined) {
    // Só data: o dia inteiro conta — a ocorrência das 20h do último dia ainda dispara.
    return zonedToUtc(tz, y, mo, d, 23, 59);
  }
  const h = Number(m[4]); const mi = Number(m[5]); const se = Number(m[6] ?? '0');
  if (h > 23 || mi > 59 || se > 59) return undefined;
  const off = m[7];
  if (!off) return zonedToUtc(tz, y, mo, d, h, mi);
  if (/^z$/i.test(off)) return new Date(Date.UTC(y, mo - 1, d, h, mi, se));
  const om = /^([+-])(\d{2}):?(\d{2})$/.exec(off);
  if (!om) return undefined;
  const sign = om[1] === '-' ? -1 : 1;
  const offMin = sign * (Number(om[2]) * 60 + Number(om[3]));
  return new Date(Date.UTC(y, mo - 1, d, h, mi, se) - offMin * 60_000);
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

export interface NextOccurrenceOpts {
  /**
   * Início da série — necessário pra COUNT ter sentido ("10 ocorrências a partir de
   * quando?"). O dispatcher passa `created_at`/`scheduled_at` do lembrete. Sem âncora,
   * COUNT é ignorado (como sempre foi) — mas UNTIL vale mesmo assim.
   */
  anchor?: Date | null;
}

/**
 * Próxima ocorrência ESTRITAMENTE depois de `from`, no horário de Brasília.
 * Retorna null se o rrule for inválido/não suportado (caller decide fallback) — e TAMBÉM
 * quando a série ACABOU (UNTIL passou, ou COUNT esgotado a partir da âncora). Pro
 * dispatcher, null depois de um disparo = "era o último": o lembrete vira `sent`.
 */
export function nextOccurrence(rrule: string, from: Date = new Date(), tz: string = REMINDER_TZ, opts: NextOccurrenceOpts = {}): Date | null {
  const rule = parseRrule(rrule);
  if (!rule) return null;
  const candidato = proximaSemFim(rule, from, tz);
  if (!candidato) return null;
  const fim = fimDaSerie(rule, tz, opts.anchor ?? null);
  if (fim && candidato.getTime() > fim.getTime()) return null;
  return candidato;
}

/**
 * Último instante em que a série ainda dispara, ou null se ela não tem fim.
 * UNTIL é direto; COUNT é "a N-ésima ocorrência a partir da âncora" (sem âncora, sem fim).
 * Quando os dois existem, vale o que acabar primeiro.
 */
function fimDaSerie(rule: ParsedRrule, tz: string, anchor: Date | null): Date | null {
  let fim: Date | null = rule.until ?? null;
  if (rule.count && anchor) {
    // A primeira ocorrência conta a partir da âncora INCLUSIVE: um lembrete criado às 13:30
    // pra "todo dia 13:30, 10 vezes" dispara hoje e mais 9 dias. `from` = âncora − 1 ms.
    let cursor = new Date(anchor.getTime() - 1);
    let ultimo: Date | null = null;
    for (let i = 0; i < rule.count; i++) {
      const prox = proximaSemFim(rule, cursor, tz);
      if (!prox) break;
      ultimo = prox;
      cursor = prox;
    }
    if (ultimo && (!fim || ultimo.getTime() < fim.getTime())) fim = ultimo;
  }
  return fim;
}

/**
 * Quando esta recorrência dispara pela última vez — o número que o resto do sistema usa
 * pra dizer "por 10 dias, até 13/09" sem inventar. null = sem fim definido.
 */
export function fimDaRecorrencia(rrule: string, anchor: Date | null | undefined, tz: string = REMINDER_TZ): Date | null {
  const rule = parseRrule(rrule);
  if (!rule) return null;
  return fimDaSerie(rule, tz, anchor ?? null);
}

/**
 * Reescreve o rrule com um fim EXPLÍCITO por data (UNTIL, em horário local com offset),
 * removendo COUNT — é a forma que sobrevive a qualquer leitor, inclusive o app. O
 * instante vira o fim do minuto em que cai, pra incluir a própria ocorrência.
 */
export function rruleComFim(rrule: string, until: Date, tz: string = REMINDER_TZ): string {
  const partes = rrule.trim().replace(/^RRULE:/i, '').split(';')
    .map((p) => p.trim())
    .filter((p) => p && !/^(COUNT|UNTIL)=/i.test(p));
  const wc = wallClockIn(tz, until);
  const pad = (n: number) => String(n).padStart(2, '0');
  const offMin = Math.round((Date.UTC(wc.year, wc.month - 1, wc.day, wc.hour, wc.minute, wc.second) - until.getTime()) / 60_000);
  const sign = offMin < 0 ? '-' : '+';
  const abs = Math.abs(offMin);
  const off = `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
  return [...partes, `UNTIL=${wc.year}${pad(wc.month)}${pad(wc.day)}T${pad(wc.hour)}${pad(wc.minute)}59${off}`].join(';');
}

/** 23:59 (local) do dia que está `dias` depois de `base`. É como "por N dias" vira UNTIL. */
export function fimDoDiaLocal(base: Date, dias: number, tz: string = REMINDER_TZ): Date {
  const wc = addDays(tz, wallClockIn(tz, base), Math.max(0, Math.floor(dias)));
  return zonedToUtc(tz, wc.year, wc.month, wc.day, 23, 59);
}

/**
 * Quantas vezes a série dispara a partir da âncora (inclusive) até o fim. null = sem fim.
 * Limitado a `max` pra nunca virar loop longo — 400 cobre um ano de dose diária.
 */
export function contarOcorrencias(rrule: string, anchor: Date, tz: string = REMINDER_TZ, max = 400): number | null {
  const rule = parseRrule(rrule);
  if (!rule) return null;
  const fim = fimDaSerie(rule, tz, anchor);
  if (!fim) return null;
  let n = 0;
  let cursor = new Date(anchor.getTime() - 1);
  while (n < max) {
    const prox = proximaSemFim(rule, cursor, tz);
    if (!prox || prox.getTime() > fim.getTime()) break;
    n++;
    cursor = prox;
  }
  return n;
}

/** Próxima ocorrência ignorando qualquer fim — a máquina de calendário pura. */
function proximaSemFim(rule: ParsedRrule, from: Date, tz: string): Date | null {

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
  const hours = rule.byHours ?? [rule.byHour ?? fromWc.hour];
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
      // Vários horários no dia: o primeiro que ainda está no futuro. No dia do `from`, as
      // 8h já passaram e as 20h não — é a dose das 20h que a versão antiga perdia.
      for (const hour of hours) {
        const candidate = zonedToUtc(tz, day.year, day.month, day.day, hour, minute);
        if (candidate.getTime() > from.getTime()) return candidate;
      }
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
    for (const hour of hours) {
      const candidate = zonedToUtc(tz, y, mo, targetDay, hour, minute);
      if (candidate.getTime() > from.getTime()) return candidate;
    }
  }
  return null;
}

/**
 * Resolve o primeiro disparo (next_run_at) de um lembrete a partir do que a LLM
 * mandou. Trata string vazia/whitespace como AUSENTE — a LLM costuma emitir
 * `scheduled_at: ""` junto do rrule num lembrete recorrente, e `"" ?? x`
 * devolve `""` (nullish coalescing NÃO trata string vazia como nulo). Esse
 * bug fazia o `nextOccurrence` nunca ser chamado → lembrete recusado em loop
 * (incidente Antônia Flávia). Sempre normalize os campos aqui.
 */
export function resolveReminderFirstRun(
  scheduledAt: string | null | undefined,
  rrule: string | null | undefined,
  from: Date = new Date(),
  tz: string = REMINDER_TZ,
): string | null {
  const sched = scheduledAt?.trim() ? scheduledAt.trim() : null;
  const rule = rrule?.trim() ? rrule.trim() : null;
  if (sched) return sched;
  if (rule) return nextOccurrence(rule, from, tz)?.toISOString() ?? null;
  return null;
}

/**
 * ⚠️ INCIDENTE GLAUBER (31/08/2026) — por que o SERVIDOR passa a calcular "dia N".
 *
 * Em 31/08 o Glauber pediu *"me lembrar no dia 02 de pegar o resultado"*. "Dia 02" a partir
 * de 31/08 é 02/09 — dois dias depois. O modelo escreveu `2026-10-02`: **32 dias de atraso**,
 * num lembrete de resultado de exame de paciente oncológico.
 *
 * O prompt até informava a data ("segunda-feira, 31/08/2026, 16:25"), mas em formato humano
 * e sem a trava que o agente de clínica tem ("NUNCA invente ano/mês — parta de hoje e some
 * os dias"). Endurecer o prompt reduz o erro; não o elimina. Aritmética de calendário é
 * exatamente o que um LLM erra às vezes e um servidor nunca erra.
 *
 * Então o modelo para de calcular: ele diz o DIA (`dia_do_mes: 2`) e a hora, e a data sai
 * daqui. Reusa `nextOccurrence` — a mesma máquina de fuso já exercitada pelos recorrentes —
 * em vez de aritmética nova, que é onde erro de timezone nasce.
 */
export function proximoDiaDoMes(
  dia: number,
  hora: { h: number; m: number },
  from: Date = new Date(),
  tz: string = REMINDER_TZ,
): string | null {
  if (!Number.isInteger(dia) || dia < 1 || dia > 31) return null;
  if (!Number.isInteger(hora.h) || hora.h < 0 || hora.h > 23) return null;
  if (!Number.isInteger(hora.m) || hora.m < 0 || hora.m > 59) return null;
  // MONTHLY + BYMONTHDAY devolve a PRÓXIMA ocorrência daquele dia. Em 31/08 pedindo dia 2,
  // a próxima é 02/09 — nunca outubro. Meses sem o dia 31 são pulados pela própria regra.
  const rr = `FREQ=MONTHLY;BYMONTHDAY=${dia};BYHOUR=${hora.h};BYMINUTE=${hora.m}`;
  return nextOccurrence(rr, from, tz)?.toISOString() ?? null;
}

/**
 * Extrai só HH:MM de um ISO que o modelo mandou. A HORA ele acerta — é o mês e o ano que
 * ele erra. Então aproveitamos a parte boa do palpite e recalculamos a data.
 * Lê os dígitos do texto de propósito: `new Date()` converteria pro fuso local e o "08:00"
 * que a pessoa pediu viraria outra hora.
 */
export function horaDeIso(iso: string | null | undefined): { h: number; m: number } | null {
  const m = /T(\d{2}):(\d{2})/.exec((iso ?? '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h >= 0 && h <= 23 && min >= 0 && min <= 59 ? { h, m: min } : null;
}
