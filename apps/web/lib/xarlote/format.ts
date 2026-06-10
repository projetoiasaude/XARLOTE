import { format, isToday, isYesterday, differenceInDays } from 'date-fns';
import { ptBR } from 'date-fns/locale';

export function brl(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return '—';
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(n);
}

/** Separadores de dia no chat: "hoje" / "ontem" / "8 de junho" */
export function dayLabel(date: string | Date): string {
  const d = new Date(date);
  if (isToday(d)) return 'hoje';
  if (isYesterday(d)) return 'ontem';
  return format(d, "d 'de' MMMM", { locale: ptBR });
}

export function shortDate(date: string | Date): string {
  return format(new Date(date), "d MMM", { locale: ptBR });
}

export function fullDateTime(date: string | Date): string {
  return format(new Date(date), "d 'de' MMM 'às' HH:mm", { locale: ptBR });
}

/** "em 2h 14min" / "em 3 dias" / "agora" — countdown amigável */
export function countdown(target: string | Date): string {
  const diffMs = new Date(target).getTime() - Date.now();
  if (diffMs <= 30_000) return 'agora';
  const min = Math.round(diffMs / 60_000);
  if (min < 60) return `em ${min} min`;
  const h = Math.floor(min / 60);
  const restMin = min % 60;
  if (h < 24) return restMin > 0 ? `em ${h}h ${restMin}min` : `em ${h}h`;
  const days = differenceInDays(new Date(target), new Date());
  return `em ${Math.max(days, 1)} dia${days > 1 ? 's' : ''}`;
}

const WEEKDAYS: Record<string, string> = {
  MO: 'seg',
  TU: 'ter',
  WE: 'qua',
  TH: 'qui',
  FR: 'sex',
  SA: 'sáb',
  SU: 'dom',
};

/** Humaniza um RRULE simples: "FREQ=DAILY;BYHOUR=8;BYMINUTE=0" → "todo dia às 08:00" */
export function humanizeRrule(rrule: string | null): string | null {
  if (!rrule) return null;
  const parts = Object.fromEntries(
    rrule
      .replace(/^RRULE:/i, '')
      .split(';')
      .map((p) => p.split('=') as [string, string])
      .filter((p) => p[0] && p[1]),
  ) as Record<string, string>;

  const freq = (parts['FREQ'] ?? '').toUpperCase();
  const interval = parseInt(parts['INTERVAL'] ?? '1', 10);

  let base: string;
  switch (freq) {
    case 'HOURLY':
      base = interval > 1 ? `a cada ${interval} horas` : 'a cada hora';
      break;
    case 'DAILY':
      base = interval > 1 ? `a cada ${interval} dias` : 'todo dia';
      break;
    case 'WEEKLY': {
      const days = (parts['BYDAY'] ?? '')
        .split(',')
        .map((d) => WEEKDAYS[d.trim().toUpperCase()])
        .filter(Boolean);
      base = days.length ? `toda ${days.join(', ')}` : interval > 1 ? `a cada ${interval} semanas` : 'toda semana';
      break;
    }
    case 'MONTHLY':
      base = interval > 1 ? `a cada ${interval} meses` : 'todo mês';
      break;
    default:
      return rrule;
  }

  const hour = parts['BYHOUR'];
  if (hour != null) {
    const minute = parts['BYMINUTE'] ?? '0';
    const hh = hour.split(',')[0]!.padStart(2, '0');
    const mm = minute.split(',')[0]!.padStart(2, '0');
    base += ` às ${hh}:${mm}`;
  }
  return base;
}

/** % de estoque restante de um inventário (0–100) */
export function inventoryPct(remaining: number | null, perBox: number | null, boxes: number | null): number | null {
  if (remaining == null) return null;
  const total = (perBox ?? 0) * (boxes ?? 1);
  if (!total) return null;
  return Math.max(0, Math.min(100, Math.round((remaining / total) * 100)));
}
