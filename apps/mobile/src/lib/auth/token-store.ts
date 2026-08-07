/**
 * Onde os tokens moram.
 *
 * `expo-secure-store` = Keychain no iOS / Keystore no Android. Nunca MMKV, nunca
 * AsyncStorage: um refresh token de 180 dias que dá acesso a prontuário não pode
 * ficar num arquivo legível por qualquer backup ou por um root.
 *
 * `WHEN_UNLOCKED_THIS_DEVICE_ONLY` é deliberado: sem `THIS_DEVICE_ONLY` o item entra
 * no backup do iCloud e a sessão de saúde renasce num aparelho novo sem ninguém
 * autorizar. Perder a sessão ao trocar de celular é o comportamento CERTO aqui —
 * refazer o login custa 30 segundos.
 */
import * as SecureStore from 'expo-secure-store';

const ACCESS = 'xarlote.access';
const REFRESH = 'xarlote.refresh';
const USER = 'xarlote.user';
/** Preferências de cadeado não são segredo, mas ficam juntas pra sumirem no logout. */
const LOCK = 'xarlote.lock';

const OPTS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

export interface StoredUser {
  id: string;
  preferredName: string | null;
  phoneE164: string;
}

export interface StoredSession {
  accessToken: string;
  refreshToken: string;
  user: StoredUser;
}

async function get(key: string): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(key, OPTS);
  } catch {
    // Keychain indisponível (aparelho travado logo no arranque, item corrompido).
    // Tratar como "sem sessão" é fail-closed: pede login em vez de seguir sem token.
    return null;
  }
}

async function set(key: string, value: string): Promise<void> {
  await SecureStore.setItemAsync(key, value, OPTS);
}

async function del(key: string): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(key, OPTS);
  } catch {
    /* já não existia */
  }
}

export async function loadSession(): Promise<StoredSession | null> {
  const [accessToken, refreshToken, userRaw] = await Promise.all([get(ACCESS), get(REFRESH), get(USER)]);
  if (!accessToken || !refreshToken || !userRaw) return null;
  try {
    return { accessToken, refreshToken, user: JSON.parse(userRaw) as StoredUser };
  } catch {
    return null;
  }
}

export async function saveSession(session: StoredSession): Promise<void> {
  await Promise.all([
    set(ACCESS, session.accessToken),
    set(REFRESH, session.refreshToken),
    set(USER, JSON.stringify(session.user)),
  ]);
}

/** Só o par de tokens — o que a rotação do refresh atualiza a cada 15 minutos. */
export async function saveTokens(accessToken: string, refreshToken: string): Promise<void> {
  await Promise.all([set(ACCESS, accessToken), set(REFRESH, refreshToken)]);
}

export async function clearSession(): Promise<void> {
  await Promise.all([del(ACCESS), del(REFRESH), del(USER), del(LOCK)]);
}

export async function isLockEnabled(): Promise<boolean> {
  return (await get(LOCK)) === '1';
}

export async function setLockEnabled(enabled: boolean): Promise<void> {
  if (enabled) await set(LOCK, '1');
  else await del(LOCK);
}
