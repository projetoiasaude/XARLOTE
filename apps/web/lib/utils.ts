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

/**
 * GET numa rota da API (admin) e devolve o JSON tipado. O header `x-admin-token`
 * é injetado pelo AdminAuthGate (patch no window.fetch). As telas do dashboard
 * usam isto em vez de Supabase anônimo direto — o RLS (is_staff) bloqueia leitura
 * anônima de PII (LGPD), então a leitura tem que passar pela API (service role).
 */
export async function adminGet<T>(path: string): Promise<T> {
  const res = await fetch(apiUrl(path), { cache: 'no-store' });
  if (!res.ok) throw new Error(`API ${res.status}`);
  return (await res.json()) as T;
}
