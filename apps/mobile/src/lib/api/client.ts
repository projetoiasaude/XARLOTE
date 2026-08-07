/**
 * O cliente HTTP do app. Uma porta só pra falar com a API.
 *
 * As três coisas que ele resolve e que ninguém deveria reimplementar por tela:
 *
 * 1. **Refresh em VOO ÚNICO.** O access token vive 15 minutos. Quando ele vence, é
 *    comum 4 telas dispararem juntas no mesmo instante (chat + lembretes + saúde +
 *    push). Sem trava, são 4 refreshes concorrentes — e como o backend ROTACIONA o
 *    refresh a cada uso e trata token antigo fora da graça como VAZAMENTO, o 4º
 *    request derrubaria a sessão inteira do paciente. Aqui só o primeiro chama; os
 *    outros esperam a MESMA promise.
 * 2. **Timeout de verdade.** `fetch` em rede móvel pode pendurar por minutos. Sem
 *    AbortController o app fica com spinner eterno e o paciente acha que travou.
 * 3. **Classificação única do erro** (ver ./errors.ts) — as telas leem `kind`,
 *    nunca o texto.
 *
 * O cliente NÃO conhece React. Quem liga os dois é o AuthProvider, que injeta os
 * tokens e recebe de volta a rotação e o "caiu a sessão".
 */
import Constants from 'expo-constants';
import { ApiError, classifyApiError, classifyTransportError } from './errors';

const DEFAULT_TIMEOUT_MS = 20_000;

/**
 * Timeout na mão em vez de `AbortSignal.timeout`.
 *
 * O estático `AbortSignal.timeout` é recente e NÃO é garantido no Hermes/RN — onde
 * faltar, ele é `undefined` e TODA chamada de rede morre num TypeError, o que na tela
 * aparece como "sem conexão" num aparelho com internet perfeita. AbortController +
 * setTimeout existe em todo lugar.
 */
function comTimeout(ms: number): { signal: AbortSignal; cancelar: () => void } {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(new Error('timeout')), ms);
  return { signal: ctrl.signal, cancelar: () => clearTimeout(id) };
}

function resolveBaseUrl(): string {
  const fromExtra = (Constants.expoConfig?.extra as { apiUrl?: string } | undefined)?.apiUrl;
  const url = process.env['EXPO_PUBLIC_API_URL'] ?? fromExtra;
  if (!url) throw new Error('EXPO_PUBLIC_API_URL/extra.apiUrl ausente — o app não sabe com quem falar.');
  return url.replace(/\/+$/, '');
}

export const API_BASE_URL = resolveBaseUrl();

// ── Ponte com o AuthProvider ──────────────────────────────────────────────────

interface AuthBridge {
  getAccessToken: () => string | null;
  getRefreshToken: () => string | null;
  /** Chamado quando a rotação dá certo — o provider persiste e atualiza o estado. */
  onRotated: (accessToken: string, refreshToken: string) => void;
  /** Refresh recusado: sessão morta (expirou, foi revogada, ou detectaram reuso). */
  onSignedOut: () => void;
}

let bridge: AuthBridge | null = null;

export function connectAuthBridge(b: AuthBridge): void {
  bridge = b;
}

// ── Refresh em voo único ──────────────────────────────────────────────────────

let inflightRefresh: Promise<string | null> | null = null;

async function performRefresh(): Promise<string | null> {
  const refreshToken = bridge?.getRefreshToken();
  if (!bridge || !refreshToken) return null;

  const t = comTimeout(DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch(`${API_BASE_URL}/app/auth/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
      signal: t.signal,
    });
    if (!res.ok) {
      // 401 aqui é definitivo (token inválido/reuso). 5xx é a API de pé mas doente:
      // derrubar a sessão por instabilidade de servidor seria punir o paciente por
      // um problema nosso — devolve null e o request original falha como 'unavailable'.
      if (res.status === 401) bridge.onSignedOut();
      return null;
    }
    const data = (await res.json()) as { accessToken?: string; refreshToken?: string };
    if (!data.accessToken || !data.refreshToken) {
      bridge.onSignedOut();
      return null;
    }
    bridge.onRotated(data.accessToken, data.refreshToken);
    return data.accessToken;
  } catch {
    // Falha de transporte: NÃO desloga. Rede volta, sessão continua válida.
    return null;
  } finally {
    t.cancelar();
  }
}

/** Garante um access token novo, com no máximo uma rotação em voo por vez. */
export function refreshAccessToken(): Promise<string | null> {
  if (!inflightRefresh) {
    inflightRefresh = performRefresh().finally(() => {
      inflightRefresh = null;
    });
  }
  return inflightRefresh;
}

// ── Request ───────────────────────────────────────────────────────────────────

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  /** Rota pública (login/OTP): não manda Bearer nem tenta refresh. */
  anonymous?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
}

async function parseBody(res: Response): Promise<unknown> {
  if (res.status === 204) return null;
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { message: text.slice(0, 200) };
  }
}

async function once<T>(path: string, opts: RequestOptions, accessToken: string | null): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (accessToken) headers['authorization'] = `Bearer ${accessToken}`;

  const t = comTimeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${API_BASE_URL}${path}`, {
      method: opts.method ?? 'GET',
      headers,
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
      // O sinal do chamador (cancelar ao sair da tela) NÃO substitui o timeout: os
      // dois valem. Antes, passar um signal desligava o timeout sem querer.
      signal: opts.signal ?? t.signal,
    });
  } catch (err) {
    throw new ApiError(classifyTransportError(err), 0);
  } finally {
    t.cancelar();
  }

  if (!res.ok) throw new ApiError(classifyApiError(res.status, await parseBody(res)), res.status);
  return (await parseBody(res)) as T;
}

export async function apiFetch<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  if (opts.anonymous) return once<T>(path, opts, null);

  try {
    return await once<T>(path, opts, bridge?.getAccessToken() ?? null);
  } catch (err) {
    if (!(err instanceof ApiError) || err.failure.kind !== 'unauthenticated') throw err;

    // Uma única segunda chance: rotaciona (ou espera quem já está rotacionando) e
    // repete. Se o retry falhar de novo com 401, a sessão morreu de verdade.
    const fresh = await refreshAccessToken();
    if (!fresh) throw err;
    try {
      return await once<T>(path, opts, fresh);
    } catch (retryErr) {
      if (retryErr instanceof ApiError && retryErr.failure.kind === 'unauthenticated') {
        bridge?.onSignedOut();
      }
      throw retryErr;
    }
  }
}
