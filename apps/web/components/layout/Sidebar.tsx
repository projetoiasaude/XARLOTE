'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { MessageCircle, ShoppingBag, Activity, Users, Store, Zap, SlidersHorizontal } from 'lucide-react';
import { cn } from '@/lib/utils';

const nav = [
  { href: '/',              label: 'Overview',    icon: Activity },
  { href: '/simulator',     label: 'Simulador WA', icon: Zap },
  { href: '/conversations', label: 'Conversas',   icon: MessageCircle },
  { href: '/orders',        label: 'Pedidos',     icon: ShoppingBag },
  { href: '/users',         label: 'Usuários',    icon: Users },
  { href: '/suppliers',     label: 'Farmácias',   icon: Store },
  { href: '/logs',          label: 'Logs',        icon: Activity },
  { href: '/prompts',       label: 'Prompts',     icon: SlidersHorizontal },
];

export function Sidebar() {
  const path = usePathname();
  return (
    <aside className="w-56 bg-wa-panel border-r border-wa-border flex flex-col shrink-0">
      <div className="px-5 py-4 border-b border-wa-border">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-full bg-brand-500 flex items-center justify-center text-white font-bold text-sm">X</div>
          <div>
            <p className="text-sm font-semibold text-white">IA da Saúde</p>
            <p className="text-xs text-gray-400">Dashboard Dev</p>
          </div>
        </div>
      </div>
      <nav className="flex-1 p-2 space-y-0.5">
        {nav.map(({ href, label, icon: Icon }) => (
          <Link
            key={href}
            href={href}
            className={cn(
              'flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors',
              path === href
                ? 'bg-wa-bubble_in text-white font-medium'
                : 'text-gray-400 hover:text-white hover:bg-wa-bubble_in/50'
            )}
          >
            <Icon size={16} />
            {label}
          </Link>
        ))}
      </nav>
      <div className="px-4 py-3 border-t border-wa-border">
        <p className="text-xs text-gray-500">Modo: simulador</p>
        <p className="text-xs text-gray-500">Xarlote + OpenRouter</p>
      </div>
    </aside>
  );
}
