import { createClient, type SupabaseClient } from '@supabase/supabase-js';

function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing env var: ${key}`);
  return val;
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
