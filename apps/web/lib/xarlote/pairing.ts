// Pareamento do aparelho — MVP: telefone em localStorage, escopa todas as queries.
// Quando nascer auth real (Supabase Auth + OTP via WhatsApp), só este módulo muda.

const KEY = 'xarlote.app.phone';

export function getPairedPhone(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function setPairedPhone(phoneE164: string): void {
  try {
    window.localStorage.setItem(KEY, phoneE164);
  } catch {
    /* storage indisponível (modo privado) — sessão segue em memória */
  }
}

export function clearPairedPhone(): void {
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

/**
 * Normaliza entrada do usuário pra E.164.
 * - "+55 62 98888-7777" → "+5562988887777"
 * - "(62) 98888-7777"   → "+5562988887777" (assume BR)
 * - "62988887777"       → "+5562988887777"
 */
export function normalizePhoneInput(raw: string): string | null {
  const hasPlus = raw.trim().startsWith('+');
  const digits = raw.replace(/\D/g, '');
  if (!digits) return null;
  if (hasPlus) return digits.length >= 10 ? `+${digits}` : null;
  if (digits.startsWith('55') && digits.length >= 12) return `+${digits}`;
  if (digits.length === 10 || digits.length === 11) return `+55${digits}`;
  return null;
}

/** Exibição amigável: +5562988887777 → "+55 (62) 98888-7777" */
export function formatPhonePretty(e164: string): string {
  const m = /^\+55(\d{2})(\d{4,5})(\d{4})$/.exec(e164);
  if (m) return `+55 (${m[1]}) ${m[2]}-${m[3]}`;
  return e164;
}
