import { createClient, type SupabaseClient } from '@supabase/supabase-js';

function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing env var: ${key}`);
  return val;
}

// Teto de tempo para TODA chamada ao PostgREST. Sem isso o supabase-js usa `fetch` sem timeout:
// uma conexão lenta/meio-aberta ao banco pendura o turno/tick INDEFINIDAMENTE (não há circuit-breaker
// pro banco, ao contrário do OpenRouter). Com o teto, o turno degrada com erro em vez de travar pra
// sempre. Configurável por env (SUPABASE_TIMEOUT_MS); default 15s.
// Validação defensiva: um valor inválido (ex.: "15s", "", "0") NÃO pode virar NaN/0 — senão
// AbortSignal.timeout(NaN) lança e derruba TODA chamada ao banco antes de tocar a rede (review).
const _timeoutEnv = Number(process.env['SUPABASE_TIMEOUT_MS']);
const DB_TIMEOUT_MS = Number.isFinite(_timeoutEnv) && _timeoutEnv > 0 ? _timeoutEnv : 15000;

/** Injeta o AbortSignal de timeout, combinando com o signal do chamador (.abortSignal()) se houver. */
function withDbTimeout(init?: RequestInit): RequestInit {
  const timeout = AbortSignal.timeout(DB_TIMEOUT_MS);
  const signal =
    init?.signal && typeof AbortSignal.any === 'function'
      ? AbortSignal.any([init.signal, timeout])
      : (init?.signal ?? timeout);
  return { ...init, signal };
}

let _adminClient: SupabaseClient | null = null;

export function getAdminClient(): SupabaseClient {
  if (!_adminClient) {
    _adminClient = createClient(
      requireEnv('SUPABASE_URL'),
      requireEnv('SUPABASE_SERVICE_ROLE_KEY'),
      {
        auth: { autoRefreshToken: false, persistSession: false },
        db: { schema: 'public' },
        global: { fetch: (input, init) => fetch(input, withDbTimeout(init as RequestInit)) },
      }
    );
  }
  return _adminClient;
}

export const db = new Proxy({} as SupabaseClient, {
  get(_target, prop) {
    return Reflect.get(getAdminClient(), prop);
  },
});
