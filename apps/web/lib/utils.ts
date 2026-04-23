import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { formatDistanceToNow, format } from 'date-fns';
import { ptBR } from 'date-fns/locale';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function timeAgo(date: string | Date) {
  return formatDistanceToNow(new Date(date), { addSuffix: true, locale: ptBR });
}

export function formatTime(date: string | Date) {
  return format(new Date(date), 'HH:mm', { locale: ptBR });
}

export function apiUrl(path: string): string {
  const base = process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001';
  return `${base}${path}`;
}
