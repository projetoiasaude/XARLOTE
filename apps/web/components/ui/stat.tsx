import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

interface Props {
  label: ReactNode;
  value: ReactNode;
  hint?: ReactNode;
  trend?: 'up' | 'down' | 'neutral';
  icon?: ReactNode;
  className?: string;
}

const TREND_COLOR: Record<NonNullable<Props['trend']>, string> = {
  up: 'text-emerald-300',
  down: 'text-rose-300',
  neutral: 'text-white/50',
};

/**
 * Stat pill — número grande + label pequeno + trend opcional.
 * Pra hero de Overview e perfil 360.
 */
export function Stat({ label, value, hint, trend, icon, className }: Props) {
  return (
    <div
      className={cn(
        'glass glass-spec rounded-2xl px-4 py-3 min-w-[120px]',
        className,
      )}
    >
      <div className="flex items-center gap-2 text-[11px] uppercase tracking-wider text-white/45 font-medium">
        {icon}
        {label}
      </div>
      <div className="mt-1 text-2xl font-semibold text-white tabular-nums tracking-tight">
        {value}
      </div>
      {hint && (
        <div className={cn('mt-0.5 text-[11px]', trend ? TREND_COLOR[trend] : 'text-white/45')}>
          {hint}
        </div>
      )}
    </div>
  );
}
