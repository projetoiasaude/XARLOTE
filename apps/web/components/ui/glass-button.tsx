'use client';
import { forwardRef } from 'react';
import { motion, type HTMLMotionProps } from 'framer-motion';
import { cn } from '@/lib/utils';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'success';
type Size = 'xs' | 'sm' | 'md' | 'lg';

interface GlassButtonProps extends Omit<HTMLMotionProps<'button'>, 'ref'> {
  variant?: Variant;
  size?: Size;
  iconOnly?: boolean;
}

const VARIANT: Record<Variant, string> = {
  primary:
    'bg-accent text-white border-accent/40 hover:bg-accent-hi hover:shadow-glow-accent active:bg-accent-lo',
  secondary:
    'glass glass-spec text-white hover:bg-white/10 hover:border-white/20',
  ghost:
    'text-gray-300 hover:text-white hover:bg-white/5 border-transparent',
  danger:
    'bg-red-500/85 text-white border-red-500/50 hover:bg-red-500 hover:shadow-glow-danger active:bg-red-600',
  success:
    'bg-emerald-500/85 text-white border-emerald-500/50 hover:bg-emerald-500 hover:shadow-glow-success active:bg-emerald-600',
};

const SIZE: Record<Size, string> = {
  xs: 'h-7 px-2.5 text-xs gap-1.5 rounded-lg',
  sm: 'h-8 px-3 text-xs gap-1.5 rounded-lg',
  md: 'h-10 px-4 text-sm gap-2 rounded-xl',
  lg: 'h-12 px-5 text-sm gap-2.5 rounded-2xl',
};

const ICON_SIZE: Record<Size, string> = {
  xs: 'w-7 px-0',
  sm: 'w-8 px-0',
  md: 'w-10 px-0',
  lg: 'w-12 px-0',
};

export const GlassButton = forwardRef<HTMLButtonElement, GlassButtonProps>(
  ({ variant = 'secondary', size = 'md', iconOnly = false, className, children, ...rest }, ref) => {
    return (
      <motion.button
        ref={ref}
        whileTap={{ scale: 0.96 }}
        transition={{ type: 'spring', stiffness: 420, damping: 22 }}
        className={cn(
          'inline-flex items-center justify-center font-medium border transition-colors duration-150',
          'focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-ink-base',
          'disabled:opacity-40 disabled:cursor-not-allowed disabled:pointer-events-none',
          VARIANT[variant],
          SIZE[size],
          iconOnly && ICON_SIZE[size],
          className,
        )}
        {...rest}
      >
        {children}
      </motion.button>
    );
  },
);
GlassButton.displayName = 'GlassButton';
