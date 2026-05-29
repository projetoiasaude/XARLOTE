'use client';
import { useEffect } from 'react';

const API = process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001';
const TOKEN = process.env['NEXT_PUBLIC_ADMIN_API_TOKEN'] ?? '';

/**
 * Injeta o header `x-admin-token` em TODA chamada fetch destinada à API
 * (apenas URLs que começam com a base da API — chamadas ao Supabase/realtime
 * passam intactas). Cobre as dezenas de `fetch` espalhados pelo dashboard sem
 * precisar reescrever cada call site.
 *
 * O token vem de NEXT_PUBLIC_ADMIN_API_TOKEN (embutido no bundle). Como o
 * dashboard é uma ferramenta local/interna, isso é aceitável pra F0 — a defesa
 * real é o servidor exigir o token. F1 troca por Supabase Auth + RBAC.
 */
export function ApiAuth() {
  useEffect(() => {
    if (!TOKEN) return;
    const w = window as unknown as { __apiAuthPatched?: boolean; fetch: typeof fetch };
    if (w.__apiAuthPatched) return;
    const orig = window.fetch.bind(window);
    w.__apiAuthPatched = true;

    window.fetch = function patchedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      try {
        const url =
          typeof input === 'string' ? input :
          input instanceof URL ? input.href :
          (input as Request).url;
        if (url && url.startsWith(API)) {
          const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
          if (!headers.has('x-admin-token')) headers.set('x-admin-token', TOKEN);
          return orig(input, { ...init, headers });
        }
      } catch { /* deixa passar sem header */ }
      return orig(input, init);
    };

    return () => { window.fetch = orig; w.__apiAuthPatched = false; };
  }, []);

  return null;
}
