'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { motion } from 'framer-motion';
import {
  MessageCircle, ShoppingBag, Activity, Users, Store, Zap, SlidersHorizontal,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useXarloteStatus } from '@/lib/hooks/use-xarlote-status';
import { StatusPing } from '@/components/ui';

interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
}

const nav: NavItem[] = [
  { href: '/', label: 'Overview', icon: Activity },
  { href: '/simulator', label: 'Simulador', icon: Zap },
  { href: '/conversations', label: 'Conversas', icon: MessageCircle },
  { href: '/orders', label: 'Pedidos', icon: ShoppingBag },
  { href: '/users', label: 'Usuários', icon: Users },
  { href: '/suppliers', label: 'Farmácias', icon: Store },
  { href: '/logs', label: 'Logs', icon: Activity },
  { href: '/prompts', label: 'Prompts', icon: SlidersHorizontal },
];

export function Sidebar() {
  const path = usePathname();
  const status = useXarloteStatus();
  // Cor do model — tira só o nome curto pra exibir
  const modelLabel = status.model?.split('/').at(-1) ?? '—';

  return (
    <aside className="my-4 ml-4 w-60 shrink-0">
      <div className="glass glass-spec rounded-3xl h-full flex flex-col p-3 shadow-glass-lg">
        {/* Logo + branding */}
        <Link href="/" className="flex items-center gap-3 px-2 py-3 rounded-2xl hover:bg-white/[0.04] transition-colors">
          <div className="relative h-10 w-10 shrink-0 rounded-2xl bg-gradient-to-br from-aurora-blue via-accent to-aurora-purple flex items-center justify-center text-white font-bold shadow-glass">
            <span className="relative z-10 drop-shadow text-lg">X</span>
            <span
              aria-hidden
              className="absolute inset-0 rounded-2xl"
              style={{
                background: 'linear-gradient(180deg, rgba(255,255,255,0.30) 0%, transparent 45%)',
              }}
            />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-white tracking-tight">Xarlote</p>
            <p className="text-[11px] text-white/45">IA da Saúde</p>
          </div>
        </Link>

        {/* Nav */}
        <nav className="mt-3 flex-1 flex flex-col gap-0.5 px-0.5">
          {nav.map(({ href, label, icon: Icon }) => {
            const active = href === '/' ? path === '/' : path?.startsWith(href);
            return (
              <Link
                key={href}
                href={href}
                className={cn(
                  'relative flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm transition-colors',
                  'focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
                  active ? 'text-white' : 'text-white/55 hover:text-white/90 hover:bg-white/[0.04]',
                )}
              >
                {active && (
                  <motion.div
                    layoutId="nav-active"
                    transition={{ type: 'spring', stiffness: 360, damping: 30 }}
                    className="absolute inset-0 rounded-xl bg-white/10 border border-white/15 shadow-glass"
                  />
                )}
                <Icon size={16} className={cn('relative z-10 shrink-0', active && 'text-accent-hi')} />
                <span className="relative z-10 font-medium">{label}</span>
              </Link>
            );
          })}
        </nav>

        {/* Footer status */}
        <div className="mt-3 border-t border-white/8 pt-3 px-1 space-y-2">
          <div className="flex items-center gap-2 px-2">
            <StatusPing tone={status.enabled ? 'success' : 'danger'} pulse={status.enabled} />
            <span className="text-xs font-medium text-white/75">
              {status.enabled ? 'Conectada' : 'Desconectada'}
            </span>
          </div>
          <div className="px-2 text-[10px] text-white/40 truncate font-mono">
            {modelLabel}
          </div>
        </div>
      </div>
    </aside>
  );
}
