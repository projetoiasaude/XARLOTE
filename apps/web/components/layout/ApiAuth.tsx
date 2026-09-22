'use client';
import { useEffect } from 'react';

const API = process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001';
// SÓ o token de APP (escopo /app), nunca o de admin.
//
// O fallback pro `NEXT_PUBLIC_ADMIN_API_TOKEN` saiu em 22/09/2026: qualquer
// `NEXT_PUBLIC_*` citado num componente de cliente é embutido no bundle que vai pro
// navegador de qualquer visitante — bastava um build sem o token de app pra publicar o
// token de ADMIN (que abre `/admin/*` inteiro) em JS público. Um deploy com a env errada
// não pode ter esse preço. Em dev, defina `NEXT_PUBLIC_APP_API_TOKEN` no
// `apps/web/.env.local` se for reabrir o `/app` (ver `NEXT_PUBLIC_APP_WEB_ENABLED`).
const TOKEN = process.env['NEXT_PUBLIC_APP_API_TOKEN'] ?? '';

/**
 * Injeta o header `x-admin-token` em TODA chamada fetch destinada à API
 * (apenas URLs que começam com a base da API — chamadas ao Supabase/realtime
 * passam intactas). Cobre as dezenas de `fetch` espalhados pelo dashboard sem
 * precisar reescrever cada call site.
 *
 * Só é montado pelo layout do `/app` (hoje fechado pelo middleware). O token vem de
 * NEXT_PUBLIC_APP_API_TOKEN, que é público por natureza — a defesa real é o servidor
 * exigir o token e o escopo dele ser só `/app`. O cutover pra API autenticada (OTP +
 * JWT, como no app nativo) aposenta este arquivo.
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
