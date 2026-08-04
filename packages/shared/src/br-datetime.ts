/**
 * br-datetime — leitura de data/hora em português BRASILEIRO de texto livre de
 * recepção de clínica/farmácia. PURO e testável (nowMs sempre injetado).
 *
 * POR QUE ISTO EXISTE (auditoria 04/08, caso Ciro × Rita):
 * a recepcionista escreveu "Eu tenho um horário disponível amanhã às 08:30, na
 * quarta feira ás 10 horas ou então na quinta feira ás 08 horas" — TRÊS horários —
 * e o sistema registrou ZERO. Depois escreveu "Ficou então para o dia 26/08 quarta
 * feira ás 10 horas" — a confirmação do único agendamento da história do produto — e
 * o sistema também registrou ZERO. Nos dois casos o LLM voltou vazio e não havia
 * NENHUM caminho determinístico: a informação estava na tela e morria ali.
 *
 * Este módulo não substitui o LLM. Ele é o piso: o que a recepção escreveu em
 * português claro tem que ser legível por código, para que o turno vazio de um
 * modelo nunca mais custe uma consulta.
 *
 * Fuso: Brasil não tem horário de verão desde 2019 → America/Sao_Paulo é -03:00
 * fixo. Isso é o que permite montar o ISO por string sem biblioteca de timezone.
 */

/** Offset fixo do Brasil (sem DST desde 2019). */
const BR_OFFSET_MS = 3 * 60 * 60_000;
const BR_OFFSET_SUFFIX = '-03:00';

/** Uma data/hora encontrada no texto, com a evidência que a produziu. */
export interface BrDateTimeHit {
  /** ISO em UTC (já convertido a partir de -03:00). */
  iso: string;
  /** Trecho do texto que gerou o hit — vai pro log/auditoria, nunca inventado. */
  evidence: string;
  /** Índice no texto original (usado para ordenar e para pareamento). */
  index: number;
  /** `true` quando a DATA foi explícita (26/08, amanhã, quarta). `false` = herdada. */
  dateExplicit: boolean;
}

/** Normaliza para comparação: minúsculas, sem acento. */
export function foldPt(s: string): string {
  return (s ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

const WEEKDAYS: Record<string, number> = {
  domingo: 0,
  segunda: 1,
  terca: 2,
  quarta: 3,
  quinta: 4,
  sexta: 5,
  sabado: 6,
};

const MONTHS: Record<string, number> = {
  janeiro: 1, fevereiro: 2, marco: 3, abril: 4, maio: 5, junho: 6,
  julho: 7, agosto: 8, setembro: 9, outubro: 10, novembro: 11, dezembro: 12,
};

/** Partes da data local (São Paulo) de um instante. */
function brParts(nowMs: number): { y: number; m: number; d: number; dow: number } {
  const shifted = new Date(nowMs - BR_OFFSET_MS);
  return {
    y: shifted.getUTCFullYear(),
    m: shifted.getUTCMonth() + 1,
    d: shifted.getUTCDate(),
    dow: shifted.getUTCDay(),
  };
}

/** Monta o ISO UTC a partir de data+hora LOCAIS do Brasil. */
function brToIso(y: number, m: number, d: number, hh: number, mm: number): string | null {
  if (m < 1 || m > 12 || d < 1 || d > 31 || hh > 23 || mm > 59) return null;
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  const iso = `${p(y, 4)}-${p(m)}-${p(d)}T${p(hh)}:${p(mm)}:00${BR_OFFSET_SUFFIX}`;
  const dt = new Date(iso);
  if (isNaN(dt.getTime())) return null;
  // Rejeita rollover (31/02 viraria 03/03 em silêncio e agendaria o dia errado).
  const back = brParts(dt.getTime());
  if (back.d !== d || back.m !== m) return null;
  return dt.toISOString();
}

/** Soma dias a uma data local sem cair em armadilha de fim de mês. */
function addDaysBr(y: number, m: number, d: number, days: number): { y: number; m: number; d: number } {
  const base = new Date(`${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}T12:00:00Z`);
  const moved = new Date(base.getTime() + days * 86_400_000);
  return { y: moved.getUTCFullYear(), m: moved.getUTCMonth() + 1, d: moved.getUTCDate() };
}

/**
 * Quão ESPECÍFICA é a âncora. Importa porque a recepção escreve o dia da semana como
 * REFORÇO de uma data exata — "dia 26/08 quarta feira ás 10 horas". Pareando a hora
 * com a âncora mais próxima (a "quarta"), 26/08 virava a próxima quarta-feira: era
 * exatamente a mensagem que confirmou a consulta do Ciro, lida com 3 semanas de erro.
 * Quanto maior, mais específica.
 */
const SPECIFICITY = { weekday: 1, relative: 2, bareday: 3, date: 4 } as const;
type AnchorKind = keyof typeof SPECIFICITY;

/** Até onde olhar pra trás por uma âncora mais específica na MESMA oração. */
const REINFORCE_WINDOW = 26;

interface DateAnchor {
  y: number | null; // null = ano a inferir
  m: number | null; // null = mês a inferir
  d: number | null; // null = resolver por dia-da-semana
  dow: number | null;
  offsetDays: number | null; // hoje=0, amanhã=1
  kind: AnchorKind;
  index: number;
  evidence: string;
}

interface TimeToken {
  hh: number;
  mm: number;
  index: number;
  evidence: string;
}

/** Varre âncoras de DATA no texto (na ordem em que aparecem). */
function scanDateAnchors(folded: string, raw: string): DateAnchor[] {
  const out: DateAnchor[] = [];
  const push = (a: DateAnchor) => {
    // Não empilha duas âncoras que se sobrepõem no mesmo trecho (ex.: "dia 26/08"
    // casaria como data-completa E como dia-solto). A primeira (mais específica) vence.
    if (out.some((p) => Math.abs(p.index - a.index) < 3)) return;
    out.push(a);
  };

  // 26/08, 26-08, 26/08/2026 — com ou sem "dia" na frente.
  const reNumeric = /(?:dia\s+)?(\d{1,2})\s*[/\-]\s*(\d{1,2})(?:\s*[/\-]\s*(\d{2,4}))?/g;
  for (let m = reNumeric.exec(folded); m; m = reNumeric.exec(folded)) {
    const d = Number(m[1]);
    const mo = Number(m[2]);
    let y: number | null = null;
    if (m[3]) {
      const n = Number(m[3]);
      y = n < 100 ? 2000 + n : n;
    }
    if (d >= 1 && d <= 31 && mo >= 1 && mo <= 12) {
      push({ y, m: mo, d, dow: null, offsetDays: null, kind: 'date', index: m.index, evidence: raw.slice(m.index, m.index + m[0].length) });
    }
  }

  // "26 de agosto" / "dia 3 de setembro"
  const reMonthName = new RegExp(`(?:dia\\s+)?(\\d{1,2})\\s+de\\s+(${Object.keys(MONTHS).join('|')})`, 'g');
  for (let m = reMonthName.exec(folded); m; m = reMonthName.exec(folded)) {
    const d = Number(m[1]);
    const mo = MONTHS[m[2] as keyof typeof MONTHS];
    if (d >= 1 && d <= 31 && mo) {
      push({ y: null, m: mo, d, dow: null, offsetDays: null, kind: 'date', index: m.index, evidence: raw.slice(m.index, m.index + m[0].length) });
    }
  }

  // "depois de amanhã" ANTES de "amanhã" (senão o prefixo mais curto rouba o match).
  const reAfterTomorrow = /depois\s+de\s+amanha/g;
  for (let m = reAfterTomorrow.exec(folded); m; m = reAfterTomorrow.exec(folded)) {
    push({ y: null, m: null, d: null, dow: null, offsetDays: 2, kind: 'relative', index: m.index, evidence: raw.slice(m.index, m.index + m[0].length) });
  }
  const reTomorrow = /\bamanha\b/g;
  for (let m = reTomorrow.exec(folded); m; m = reTomorrow.exec(folded)) {
    if (folded.slice(Math.max(0, m.index - 12), m.index).includes('depois de')) continue;
    push({ y: null, m: null, d: null, dow: null, offsetDays: 1, kind: 'relative', index: m.index, evidence: raw.slice(m.index, m.index + m[0].length) });
  }
  const reToday = /\bhoje\b/g;
  for (let m = reToday.exec(folded); m; m = reToday.exec(folded)) {
    push({ y: null, m: null, d: null, dow: null, offsetDays: 0, kind: 'relative', index: m.index, evidence: raw.slice(m.index, m.index + m[0].length) });
  }

  // Dias da semana ("quarta", "quarta-feira", "quarta feira").
  const reDow = new RegExp(`\\b(${Object.keys(WEEKDAYS).join('|')})(?:[\\s-]*feira)?\\b`, 'g');
  for (let m = reDow.exec(folded); m; m = reDow.exec(folded)) {
    const dow = WEEKDAYS[m[1] as keyof typeof WEEKDAYS];
    if (dow === undefined) continue;
    // "a segunda opção", "na terceira vez": ordinal, não dia da semana. Sem esta
    // guarda, "a segunda opção é às 10h" agendaria pra uma segunda-feira.
    const after = folded.slice(m.index + m[0].length, m.index + m[0].length + 12);
    if (/^\s*(opcao|opção|vez|alternativa)/.test(after)) continue;
    push({ y: null, m: null, d: null, dow, offsetDays: null, kind: 'weekday', index: m.index, evidence: raw.slice(m.index, m.index + m[0].length) });
  }

  // "dia 26" solto (sem mês). Último, para não competir com os acima.
  const reBareDay = /\bdia\s+(\d{1,2})\b(?!\s*[/\-])/g;
  for (let m = reBareDay.exec(folded); m; m = reBareDay.exec(folded)) {
    const d = Number(m[1]);
    if (d >= 1 && d <= 31) {
      push({ y: null, m: null, d, dow: null, offsetDays: null, kind: 'bareday', index: m.index, evidence: raw.slice(m.index, m.index + m[0].length) });
    }
  }

  return out.sort((a, b) => a.index - b.index);
}

/** Varre HORAS no texto. */
function scanTimes(folded: string, raw: string): TimeToken[] {
  const out: TimeToken[] = [];
  const push = (t: TimeToken) => {
    if (out.some((p) => Math.abs(p.index - t.index) < 2)) return;
    out.push(t);
  };

  // 10:30, 10h30, 8h00 — hora com minutos.
  const reHm = /\b(\d{1,2})\s*[:h]\s*(\d{2})\b/g;
  for (let m = reHm.exec(folded); m; m = reHm.exec(folded)) {
    const hh = Number(m[1]);
    const mm = Number(m[2]);
    if (hh <= 23 && mm <= 59) push({ hh, mm, index: m.index, evidence: raw.slice(m.index, m.index + m[0].length) });
  }

  // "10h", "10 horas", "às 10", "as 8" — hora cheia.
  const reH = /\b(\d{1,2})\s*(?:h\b|horas?\b)/g;
  for (let m = reH.exec(folded); m; m = reH.exec(folded)) {
    const hh = Number(m[1]);
    if (hh <= 23) push({ hh, mm: 0, index: m.index, evidence: raw.slice(m.index, m.index + m[0].length) });
  }
  // "às 10" sem "h"/"horas" (esses dois já foram pegos acima; o lookahead evita
  // empilhar um segundo token pro MESMO horário e produzir hit duplicado).
  const reAs = /\bas\s+(\d{1,2})\b(?!\s*[:h])(?!\s*horas?)(?!\s*[/\-])/g;
  for (let m = reAs.exec(folded); m; m = reAs.exec(folded)) {
    const hh = Number(m[1]);
    if (hh <= 23) push({ hh, mm: 0, index: m.index, evidence: raw.slice(m.index, m.index + m[0].length) });
  }

  return out.sort((a, b) => a.index - b.index);
}

/** Resolve uma âncora em data local concreta, olhando pra frente a partir de `nowMs`. */
function resolveAnchor(a: DateAnchor, nowMs: number): { y: number; m: number; d: number } | null {
  const today = brParts(nowMs);

  if (a.offsetDays != null) return addDaysBr(today.y, today.m, today.d, a.offsetDays);

  if (a.dow != null) {
    // Próxima ocorrência daquele dia da semana, HOJE incluído (a recepção que diz
    // "quarta às 10h" numa quarta de manhã quer hoje). O filtro de passado lá em
    // `pickFuture` descarta se a hora já passou.
    const delta = (a.dow - today.dow + 7) % 7;
    return addDaysBr(today.y, today.m, today.d, delta);
  }

  if (a.d != null) {
    const m = a.m ?? today.m;
    // Ano: o que coloca a data no futuro próximo. Sem isso, "26/08" em janeiro
    // agendaria pro agosto que já passou.
    for (const y of a.y != null ? [a.y] : [today.y, today.y + 1]) {
      const probe = brToIso(y, m, a.d, 12, 0);
      if (!probe) continue;
      if (a.y != null) return { y, m, d: a.d };
      // tolera até 1 dia atrás (fuso/borda) antes de pular pro ano seguinte
      if (Date.parse(probe) >= nowMs - 86_400_000) return { y, m, d: a.d };
    }
    return null;
  }

  return null;
}

/**
 * Extrai TODAS as data/horas do texto, na ordem em que aparecem.
 *
 * Pareamento: cada HORA é associada à âncora de DATA mais próxima ANTES dela
 * ("amanhã às 08:30", "quarta feira ás 10 horas"). Se a hora vem antes de qualquer
 * âncora e existe exatamente UMA no texto, usa essa ("às 10h do dia 26").
 * Hora sem âncora nenhuma NÃO produz hit — `dateExplicit` nunca é forjado.
 */
export function parseBrDateTimes(text: string, nowMs: number): BrDateTimeHit[] {
  const raw = text ?? '';
  const folded = foldPt(raw);
  if (!folded.trim()) return [];

  const anchors = scanDateAnchors(folded, raw);
  const times = scanTimes(folded, raw);
  if (times.length === 0) return [];

  const hits: BrDateTimeHit[] = [];
  for (const t of times) {
    const before = anchors.filter((a) => a.index < t.index);
    let anchor = before.length > 0 ? (before[before.length - 1] ?? null) : null;

    // REFORÇO: "dia 26/08 quarta feira ás 10 horas" — a âncora mais PRÓXIMA da hora é
    // a "quarta", mas ela só repete o que "26/08" já disse. Olha pra trás dentro da
    // mesma oração e deixa a âncora mais específica ganhar. Sem isto, a confirmação
    // real da consulta do Ciro seria lida como a próxima quarta (3 semanas errada).
    // O discriminador é a HORA no meio: duas âncoras SEM hora entre elas descrevem o
    // mesmo dia ("dia 26/08 quarta feira" → reforço); com uma hora entre elas são
    // slots distintos ("amanhã às 08:30, na quarta feira ás 10 horas" → 2 dias).
    if (anchor) {
      for (const cand of before) {
        if (cand === anchor) continue;
        if (anchor.index - cand.index > REINFORCE_WINDOW) continue;
        if (SPECIFICITY[cand.kind] <= SPECIFICITY[anchor.kind]) continue;
        const horaNoMeio = times.some((o) => o.index > cand.index && o.index < anchor!.index);
        if (horaNoMeio) continue;
        anchor = cand;
      }
    }
    if (!anchor && anchors.length === 1) anchor = anchors[0] ?? null;
    if (!anchor) continue;

    const date = resolveAnchor(anchor, nowMs);
    if (!date) continue;
    const iso = brToIso(date.y, date.m, date.d, t.hh, t.mm);
    if (!iso) continue;

    const from = Math.min(anchor.index, t.index);
    const to = Math.max(anchor.index + anchor.evidence.length, t.index + t.evidence.length);
    const ev = raw.slice(from, to).replace(/\s+/g, ' ').trim();
    if (hits.some((h) => h.iso === iso)) continue;
    hits.push({ iso, evidence: ev, index: from, dateExplicit: true });
  }
  return hits;
}

/** Só os hits que ainda estão no futuro (com tolerância pra borda de minuto). */
export function pickFutureBrDateTimes(text: string, nowMs: number, toleranceMs = 60_000): BrDateTimeHit[] {
  return parseBrDateTimes(text, nowMs).filter((h) => Date.parse(h.iso) >= nowMs - toleranceMs);
}
