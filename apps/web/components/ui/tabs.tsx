'use client';
import { motion } from 'framer-motion';
import { cn } from '@/lib/utils';

interface TabOption {
  value: string;
  label: string;
  count?: number;
}

interface Props {
  options: TabOption[];
  value: string;
  onChange: (v: string) => void;
  /** Identidade do layoutId — único por grupo de tabs */
  id?: string;
  size?: 'sm' | 'md';
  className?: string;
}

/**
 * Tabs com indicador animado (Framer layoutId) — pill desliza
 * fluido entre os items, estilo iOS Tab Bar.
 */
export function Tabs({ options, value, onChange, id = 'tabs', size = 'md', className }: Props) {
  return (
    <div
      role="tablist"
      className={cn(
        'inline-flex items-center gap-1 rounded-2xl p-1',
        'bg-white/5 border border-white/10 backdrop-blur-glass',
        className,
      )}
    >
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            role="tab"
            aria-selected={active}
            onClick={() => onChange(opt.value)}
            className={cn(
              'relative flex items-center gap-1.5 rounded-xl font-medium transition-colors',
              'focus:outline-none focus-visible:ring-2 focus-visible:ring-accent',
              size === 'sm' ? 'h-7 px-2.5 text-xs' : 'h-9 px-3.5 text-sm',
              active ? 'text-white' : 'text-white/55 hover:text-white/85',
            )}
          >
            {active && (
              <motion.div
                layoutId={`tab-active-${id}`}
                transition={{ type: 'spring', stiffness: 380, damping: 30 }}
                className="absolute inset-0 rounded-xl bg-white/12 border border-white/15 shadow-glass"
              />
            )}
            <span className="relative z-10">{opt.label}</span>
            {opt.count != null && (
              <span
                className={cn(
                  'relative z-10 rounded-full px-1.5 text-[10px] font-semibold',
                  active ? 'bg-white/15 text-white' : 'bg-white/8 text-white/60',
                )}
              >
                {opt.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
