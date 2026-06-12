import { apiUrl } from '@/lib/utils';
import type { XarOverview, XarReminder } from './types';

// O header x-admin-token é injetado pelo <ApiAuth /> (montado no layout do app).

async function parseError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: unknown; message?: string };
    if (typeof body.message === 'string') return body.message;
    if (typeof body.error === 'string') return body.error;
    return `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}

export async function fetchOverview(phone: string): Promise<XarOverview | null> {
  // POST com phone no body — telefone na URL vazaria pros access logs (LGPD).
  const res = await fetch(apiUrl('/app/overview'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone }),
    cache: 'no-store',
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(await parseError(res));
  return (await res.json()) as XarOverview;
}

export async function sendAppMessage(
  phone: string,
  text: string,
): Promise<{ ok: boolean; conversationId: string }> {
  const res = await fetch(apiUrl('/app/inbound'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone, text }),
  });
  if (!res.ok) throw new Error(await parseError(res));
  return (await res.json()) as { ok: boolean; conversationId: string };
}

export async function reminderAction(
  id: string,
  phone: string,
  action: 'done' | 'snooze' | 'cancel',
  minutes?: number,
): Promise<XarReminder> {
  const res = await fetch(apiUrl(`/app/reminders/${id}/action`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone, action, minutes }),
  });
  if (!res.ok) throw new Error(await parseError(res));
  const body = (await res.json()) as { reminder: XarReminder };
  return body.reminder;
}

/** Registra o token de push do aparelho (app nativo). Silencioso em falha. */
export async function registerPush(
  phone: string,
  token: string,
  platform: 'ios' | 'android' | 'web',
  appVersion?: string,
): Promise<void> {
  await fetch(apiUrl('/app/push/register'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone, token, platform, appVersion }),
  }).catch(() => {});
}

/** Dá baixa no token (logout). */
export async function unregisterPush(token: string): Promise<void> {
  await fetch(apiUrl('/app/push/unregister'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  }).catch(() => {});
}
