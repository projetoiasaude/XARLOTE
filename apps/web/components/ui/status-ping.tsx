import { cn } from '@/lib/utils';

type Tone = 'success' | 'warn' | 'danger' | 'neutral' | 'accent';

const TONE: Record<Tone, string> = {
  success: 'bg-emerald-400',
  warn: 'bg-amber-400',
  danger: 'bg-rose-400',
  neutral: 'bg-white/40',
  accent: 'bg-accent',
};

interface Props {
  tone?: Tone;
  size?: 'sm' | 'md';
  /** Liga halo pulsante */
  pulse?: boolean;
  className?: string;
}

/**
 * Bolinha indicadora de status. Quando pulse=true mostra anel
 * expansivo (similar a "live" do iOS).
 */
export function StatusPing({ tone = 'success', size = 'sm', pulse = true, className }: Props) {
  const dotSize = size === 'md' ? 'h-2 w-2' : 'h-1.5 w-1.5';
  return (
    <span className={cn('relative inline-flex', className)}>
      <span className={cn(dotSize, 'rounded-full', TONE[tone])} />
      {pulse && (
        <span
          className={cn(
            dotSize,
            'absolute inset-0 rounded-full animate-pulse-ring',
            TONE[tone],
          )}
        />
      )}
    </span>
  );
}
