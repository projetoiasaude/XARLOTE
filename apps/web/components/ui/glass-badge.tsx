import { forwardRef, type HTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

export type BadgeTone =
  | 'success'
  | 'warn'
  | 'danger'
  | 'info'
  | 'neutral'
  | 'accent'
  | 'live';

interface GlassBadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
  size?: 'xs' | 'sm';
  dot?: boolean;
}

const TONE: Record<BadgeTone, string> = {
  success: 'bg-emerald-400/15 text-emerald-300 border-emerald-400/25',
  warn: 'bg-amber-400/15 text-amber-300 border-amber-400/25',
  danger: 'bg-rose-400/15 text-rose-300 border-rose-400/25',
  info: 'bg-sky-400/15 text-sky-300 border-sky-400/25',
  neutral: 'bg-white/8 text-white/70 border-white/12',
  accent: 'bg-accent/15 text-accent-hi border-accent/30',
  live: 'bg-emerald-400/20 text-emerald-200 border-emerald-400/30',
};

const DOT_TONE: Record<BadgeTone, string> = {
  success: 'bg-emerald-400',
  warn: 'bg-amber-400',
  danger: 'bg-rose-400',
  info: 'bg-sky-400',
  neutral: 'bg-white/40',
  accent: 'bg-accent',
  live: 'bg-emerald-400',
};

export const GlassBadge = forwardRef<HTMLSpanElement, GlassBadgeProps>(
  ({ tone = 'neutral', size = 'sm', dot = false, className, children, ...rest }, ref) => (
    <span
      ref={ref}
      className={cn(
        'inline-flex items-center gap-1.5 font-medium border rounded-full',
        size === 'xs' ? 'h-5 px-2 text-[10px]' : 'h-6 px-2.5 text-xs',
        TONE[tone],
        className,
      )}
      {...rest}
    >
      {dot && (
        <span className="relative inline-flex">
          <span className={cn('h-1.5 w-1.5 rounded-full', DOT_TONE[tone])} />
          {tone === 'live' && (
            <span
              className={cn(
                'absolute inset-0 h-1.5 w-1.5 rounded-full animate-pulse-ring',
                DOT_TONE[tone],
              )}
            />
          )}
        </span>
      )}
      {children}
    </span>
  ),
);
GlassBadge.displayName = 'GlassBadge';
