import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let _publicClient: SupabaseClient | null = null;

export function getPublicClient(): SupabaseClient {
  if (!_publicClient) {
    const url = process.env['NEXT_PUBLIC_SUPABASE_URL'] ?? process.env['SUPABASE_URL'] ?? '';
    const key = process.env['NEXT_PUBLIC_SUPABASE_ANON_KEY'] ?? process.env['SUPABASE_ANON_KEY'] ?? '';
    _publicClient = createClient(url, key);
  }
  return _publicClient;
}
