'use client';
import { useEffect, useState } from 'react';

const API = process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001';

/**
 * Portão de autenticação do dashboard (admin).
 *
 * Segurança: o token de admin NÃO fica no bundle. Após o login (cookie de sessão
 * httpOnly), este componente busca o token em /api/auth/token (validado server-
 * side pelo cookie) e o mantém só em memória, injetando `x-admin-token` em toda
 * chamada à API. Sem sessão válida → manda pro /login. Bloqueia a renderização
 * do dashboard até o token estar pronto (evita chamadas 401 na montagem).
 */
export function AdminAuthGate({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const orig = window.fetch.bind(window);

    (async () => {
      try {
        const res = await orig('/api/auth/token', { cache: 'no-store' });
        if (!res.ok) throw new Error(`auth ${res.status}`);
        const { token } = (await res.json()) as { token?: string };
        if (!token) throw new Error('no token');
        if (cancelled) return;

        const w = window as unknown as { __apiAuthPatched?: boolean };
        if (!w.__apiAuthPatched) {
          w.__apiAuthPatched = true;
          window.fetch = function patchedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
            try {
              const url =
                typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
              if (url && url.startsWith(API)) {
                const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
                if (!headers.has('x-admin-token')) headers.set('x-admin-token', token);
                return orig(input, { ...init, headers });
              }
            } catch {
              /* deixa passar sem header */
            }
            return orig(input, init);
          };
        }
        setReady(true);
      } catch {
        if (!cancelled) {
          const next = encodeURIComponent(window.location.pathname + window.location.search);
          window.location.href = `/login?next=${next}`;
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  if (!ready) {
    return (
      <div className="flex h-screen items-center justify-center bg-ink-base text-white/50">
        <div className="text-sm animate-pulse">Autenticando…</div>
      </div>
    );
  }
  return <>{children}</>;
}
