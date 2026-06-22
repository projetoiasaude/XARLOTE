'use client';
import { useEffect, type ReactNode } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useXarloteApp } from '@/lib/xarlote/app-context';
import { XarloteLogo } from './XarloteLogo';

/**
 * Sem aparelho pareado → /app/entrar. Enquanto hidrata o localStorage,
 * mostra um splash com o mascote (evita flash de conteúdo errado).
 */
export function PairGuard({ children }: { children: ReactNode }) {
  const { phone, ready } = useXarloteApp();
  const pathname = usePathname();
  const router = useRouter();
  const onEntrar = pathname.startsWith('/app/entrar');

  useEffect(() => {
    if (ready && !phone && !onEntrar) router.replace('/app/entrar');
  }, [ready, phone, onEntrar, router]);

  if (!ready || (!phone && !onEntrar)) {
    return (
      <div className="relative z-10 flex h-full items-center justify-center">
        <XarloteLogo size={150} />
      </div>
    );
  }

  return <>{children}</>;
}
