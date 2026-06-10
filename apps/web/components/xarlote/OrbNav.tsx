'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { AlarmClock, CircleUserRound, HeartPulse, MessageCircle, Zap, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useXarloteApp } from '@/lib/xarlote/app-context';
import { XarloteMascot } from './XarloteMascot';

interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
}

const ITEMS: NavItem[] = [
  { href: '/app', label: 'Conversa', icon: MessageCircle },
  { href: '/app/saude', label: 'Saúde', icon: HeartPulse },
  { href: '/app/lembretes', label: 'Lembretes', icon: AlarmClock },
  { href: '/app/atividade', label: 'Atividade', icon: Zap },
  { href: '/app/perfil', label: 'Perfil', icon: CircleUserRound },
];

// Arco do desabrochar: ~86° (cima) → ~190° (esquerda), orbe ancorado à direita.
// Raio e abertura calculados pra folga entre bolhas de 52px (sem sobreposição).
const RADIUS = 152;
const angleFor = (i: number, total: number) => 86 + (i * 104) / (total - 1);

/**
 * A Bolha da Xarlote — navegação radial. O mascote vive num orb de vidro
 * flutuante; tocar nele desabrocha as 5 bolhas em arco. O orb também é
 * indicador vivo: pulsa quando a Xarlote está digitando e mostra badge
 * quando há atividade em andamento (pedidos/consultas).
 */
export function OrbNav() {
  const pathname = usePathname();
  const router = useRouter();
  const reduced = useReducedMotion();
  const { typing, overview, phone } = useXarloteApp();
  const [open, setOpen] = useState(false);

  const activeCount = useMemo(() => {
    if (!overview) return 0;
    const liveOrders = overview.orders.filter((o) =>
      ['drafting', 'quoting', 'quoted', 'confirming'].includes(o.status),
    ).length;
    const liveConsults = overview.consultations.filter((c) =>
      ['searching', 'quoting', 'quoted', 'confirming'].includes(c.status),
    ).length;
    return liveOrders + liveConsults;
  }, [overview]);

  const toggle = useCallback(() => {
    navigator.vibrate?.(8);
    setOpen((v) => !v);
  }, []);

  const go = useCallback(
    (href: string) => {
      navigator.vibrate?.(6);
      setOpen(false);
      if (href !== pathname) router.push(href);
    },
    [pathname, router],
  );

  // Esc fecha · dígitos 1-5 navegam com o menu aberto
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
      const n = parseInt(e.key, 10);
      if (n >= 1 && n <= ITEMS.length) go(ITEMS[n - 1]!.href);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, go]);

  // Fecha ao trocar de rota por outros meios
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  if (!phone || pathname.startsWith('/app/entrar')) return null;

  const onChat = pathname === '/app';

  return (
    <>
      {/* Véu de blur */}
      <AnimatePresence>
        {open && (
          <motion.button
            aria-label="Fechar navegação"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.22 }}
            onClick={() => setOpen(false)}
            className="fixed inset-0 z-40 cursor-default bg-[#04041a]/55 backdrop-blur-md"
          />
        )}
      </AnimatePresence>

      <nav
        aria-label="Navegação da Xarlote"
        className="fixed right-5 z-50"
        style={{ bottom: `calc(env(safe-area-inset-bottom, 0px) + ${onChat ? '96px' : '24px'})` }}
      >
        {/* Bolhas radiais */}
        <AnimatePresence>
          {open &&
            ITEMS.map((item, i) => {
              const deg = angleFor(i, ITEMS.length);
              const a = (deg * Math.PI) / 180;
              const dx = Math.cos(a) * RADIUS;
              const dy = -Math.sin(a) * RADIUS;
              const labelAbove = deg < 100; // bolha no topo do arco → label acima
              const active = pathname === item.href;
              const Icon = item.icon;
              return (
                <motion.button
                  key={item.href}
                  initial={reduced ? { opacity: 0 } : { x: 0, y: 0, scale: 0.2, opacity: 0 }}
                  animate={
                    reduced
                      ? { opacity: 1, x: dx, y: dy }
                      : { x: dx, y: dy, scale: 1, opacity: 1 }
                  }
                  exit={reduced ? { opacity: 0 } : { x: 0, y: 0, scale: 0.2, opacity: 0 }}
                  transition={{ type: 'spring', stiffness: 400, damping: 26, delay: open ? i * 0.045 : 0 }}
                  whileHover={{ scale: 1.12 }}
                  whileTap={{ scale: 0.9 }}
                  onClick={() => go(item.href)}
                  aria-label={item.label}
                  className={cn(
                    'absolute bottom-2 right-2 flex h-[52px] w-[52px] items-center justify-center rounded-full border',
                    'focus:outline-none focus-visible:ring-2 focus-visible:ring-accent',
                    active
                      ? 'border-accent/60 bg-accent/85 text-white shadow-glow-accent'
                      : 'glass glass-spec text-white/85 hover:text-white',
                  )}
                >
                  <Icon size={20} />
                  <span
                    className={cn(
                      'pointer-events-none absolute whitespace-nowrap rounded-full border border-white/10 px-2.5 py-1 text-[11px] font-semibold',
                      'bg-[#0a0a24]/95 backdrop-blur-sm',
                      labelAbove
                        ? 'bottom-full left-1/2 mb-1.5 -translate-x-1/2'
                        : 'right-full top-1/2 mr-2 -translate-y-1/2',
                      active ? 'text-accent-hi' : 'text-white/85',
                    )}
                  >
                    {item.label}
                  </span>
                </motion.button>
              );
            })}
        </AnimatePresence>

        {/* O orb */}
        <motion.button
          onClick={toggle}
          aria-label={open ? 'Fechar navegação' : 'Abrir navegação'}
          aria-expanded={open}
          whileHover={{ scale: 1.06 }}
          whileTap={{ scale: 0.92 }}
          transition={{ type: 'spring', stiffness: 380, damping: 22 }}
          className={cn(
            'relative flex h-[68px] w-[68px] items-center justify-center rounded-full border border-white/20',
            'bg-white/10 backdrop-blur-glass animate-breathe',
            'focus:outline-none focus-visible:ring-2 focus-visible:ring-accent',
          )}
        >
          {/* anel de “digitando” */}
          {typing && (
            <span className="absolute inset-0 rounded-full border-2 border-accent/70 animate-pulse-ring" />
          )}
          <XarloteMascot size={54} mood={typing ? 'thinking' : open ? 'happy' : 'idle'} glow={false} />

          {activeCount > 0 && (
            <span className="absolute -right-0.5 -top-0.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-aurora-pink px-1 text-[10px] font-bold text-white shadow-glow-accent">
              {activeCount}
            </span>
          )}
        </motion.button>
      </nav>
    </>
  );
}
