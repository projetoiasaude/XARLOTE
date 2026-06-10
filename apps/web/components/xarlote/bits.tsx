'use client';
import { useEffect, useState } from 'react';
import { motion, useMotionValueEvent, useReducedMotion, useSpring } from 'framer-motion';
import { cn } from '@/lib/utils';

/* ────── CountUp — número que “chega” com física de mola ────────────── */
export function CountUp({
  value,
  decimals = 0,
  suffix = '',
  className,
}: {
  value: number;
  decimals?: number;
  suffix?: string;
  className?: string;
}) {
  const reduced = useReducedMotion();
  const spring = useSpring(0, { stiffness: 90, damping: 22 });
  const [display, setDisplay] = useState('0');

  useEffect(() => {
    if (reduced) setDisplay(value.toFixed(decimals));
    else spring.set(value);
  }, [value, decimals, reduced, spring]);

  useMotionValueEvent(spring, 'change', (v) => setDisplay(v.toFixed(decimals)));

  return (
    <span className={cn('tabular-nums', className)}>
      {display}
      {suffix}
    </span>
  );
}

/* ────── ProgressRing — estoque de medicamento ──────────────────────── */
export function ProgressRing({
  pct,
  size = 60,
  stroke = 6,
  children,
}: {
  pct: number; // 0–100
  size?: number;
  stroke?: number;
  children?: React.ReactNode;
}) {
  const reduced = useReducedMotion();
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const color = pct >= 50 ? '#34d399' : pct >= 20 ? '#fbbf24' : '#fb7185';

  return (
    <div className="relative inline-flex items-center justify-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth={stroke} />
        <motion.circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={c}
          initial={{ strokeDashoffset: reduced ? c * (1 - pct / 100) : c }}
          animate={{ strokeDashoffset: c * (1 - pct / 100) }}
          transition={{ duration: 0.9, ease: [0.22, 1, 0.36, 1], delay: 0.15 }}
          style={{ filter: `drop-shadow(0 0 6px ${color}66)` }}
        />
      </svg>
      <div className="absolute inset-0 flex items-center justify-center">{children}</div>
    </div>
  );
}

/* ────── LiquidStepper — pipeline do pedido com fluxo aurora ────────── */
export function LiquidStepper({ steps, active }: { steps: string[]; active: number }) {
  const pct = steps.length > 1 ? (Math.min(active, steps.length - 1) / (steps.length - 1)) * 100 : 100;
  return (
    <div className="relative px-1">
      {/* trilho */}
      <div className="absolute left-3 right-3 top-[8px] h-1.5 rounded-full bg-white/10" />
      {/* preenchimento líquido */}
      <motion.div
        className="absolute left-3 top-[8px] h-1.5 rounded-full bg-aurora-flow animate-aurora-flow"
        initial={{ width: 0 }}
        animate={{ width: `calc(${pct}% - ${(pct / 100) * 24}px)` }}
        transition={{ duration: 0.8, ease: [0.22, 1, 0.36, 1] }}
      />
      <div className="relative flex justify-between">
        {steps.map((label, i) => {
          const done = i < active;
          const current = i === active;
          return (
            <div key={label} className="flex w-12 flex-col items-center gap-1.5">
              <motion.span
                initial={false}
                animate={{ scale: current ? 1.15 : 1 }}
                transition={{ type: 'spring', stiffness: 380, damping: 20 }}
                className={cn(
                  'relative flex h-[18px] w-[18px] items-center justify-center rounded-full border',
                  done || current
                    ? 'border-accent/60 bg-accent shadow-glow-accent'
                    : 'border-white/15 bg-[#11112c]',
                )}
              >
                {current && <span className="absolute inset-0 rounded-full border border-accent/70 animate-pulse-ring" />}
                {done && <span className="h-1.5 w-1.5 rounded-full bg-white" />}
              </motion.span>
              <span
                className={cn(
                  'text-center text-[9px] font-medium leading-tight',
                  current ? 'text-white' : done ? 'text-white/65' : 'text-white/35',
                )}
              >
                {label}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ────── Memória: badge de origem + barra de confiança ──────────────── */
export function SourceBadge({ source }: { source: string | null }) {
  const self = source === 'self_reported';
  return (
    <span
      className={cn(
        'rounded-full px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wide',
        self ? 'bg-emerald-400/15 text-emerald-300' : 'bg-accent/15 text-accent-hi',
      )}
    >
      {self ? 'você contou' : 'ela percebeu'}
    </span>
  );
}

export function ConfidenceBar({ value }: { value: number | null }) {
  const v = Math.round(((value ?? 0.7) as number) * 100);
  const color = v >= 80 ? 'bg-emerald-400' : v >= 60 ? 'bg-amber-400' : 'bg-rose-400';
  return (
    <div className="h-1 w-full overflow-hidden rounded-full bg-white/8">
      <motion.div
        className={cn('h-full rounded-full', color)}
        initial={{ width: 0 }}
        animate={{ width: `${v}%` }}
        transition={{ duration: 0.7, ease: [0.22, 1, 0.36, 1], delay: 0.2 }}
      />
    </div>
  );
}
