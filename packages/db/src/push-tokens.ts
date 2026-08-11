/**
 * Persistência dos tokens de push (device_tokens). Service role only.
 */
import { db } from './client.js';

export interface DeviceToken {
  token: string;
  platform: 'ios' | 'android' | 'web';
}

/** Registra/atualiza um token pra um usuário (idempotente por token único). */
export async function registerDeviceToken(
  userId: string,
  token: string,
  platform: 'ios' | 'android' | 'web',
  appVersion?: string,
): Promise<void> {
  const now = new Date().toISOString();
  await db
    .from('device_tokens')
    .upsert(
      { user_id: userId, token, platform, app_version: appVersion ?? null, last_seen_at: now },
      { onConflict: 'token' },
    );
}

/** Remove um token (logout / desinstalação). */
export async function unregisterDeviceToken(token: string): Promise<void> {
  await db.from('device_tokens').delete().eq('token', token);
}

/**
 * Remove um token SÓ SE ele pertencer a este usuário.
 *
 * Existe porque `unregisterDeviceToken` apaga por token, sem dono — e numa rota
 * autenticada isso seria uma negação de notificação: quem descobrisse o token de push
 * de outro paciente poderia desligar os lembretes de remédio DELE. O `.eq('user_id')`
 * é o que torna a operação inofensiva contra terceiros.
 */
export async function unregisterDeviceTokenForUser(userId: string, token: string): Promise<void> {
  await db.from('device_tokens').delete().eq('token', token).eq('user_id', userId);
}

/** Remove tokens que o FCM reportou como mortos. */
export async function deleteDeviceTokens(tokens: string[]): Promise<void> {
  if (!tokens.length) return;
  await db.from('device_tokens').delete().in('token', tokens);
}

/** Tokens ativos de um usuário (pra enviar push). */
export async function listDeviceTokens(userId: string): Promise<DeviceToken[]> {
  const { data } = await db.from('device_tokens').select('token, platform').eq('user_id', userId);
  return (data ?? []) as DeviceToken[];
}
