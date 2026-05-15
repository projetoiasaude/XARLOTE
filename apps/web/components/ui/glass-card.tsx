'use client';
import { forwardRef, type HTMLAttributes, type ElementType } from 'react';
import { motion, type HTMLMotionProps } from 'framer-motion';
import { cn } from '@/lib/utils';

type GlassVariant = 'default' | 'hi' | 'lo';
type GlassRadius = 'lg' | 'xl' | '2xl' | '3xl';

interface GlassCardProps extends Omit<HTMLMotionProps<'div'>, 'ref'> {
  variant?: GlassVariant;
  radius?: GlassRadius;
  /** Adiciona efeito de hover (lift + brightness) */
  interactive?: boolean;
  /** Specular highlight no topo (padrão true) */
  spec?: boolean;
}

const VARIANT: Record<GlassVariant, string> = {
  default: 'glass',
  hi: 'glass glass-hi',
  lo: 'glass glass-lo',
};

const RADIUS: Record<GlassRadius, string> = {
  lg: 'rounded-xl',
  xl: 'rounded-2xl',
  '2xl': 'rounded-[20px]',
  '3xl': 'rounded-3xl',
};

/**
 * Painel de vidro padrão. Substitui `bg-wa-panel border border-wa-border rounded-xl`.
 *
 * Uso típico:
 *   <GlassCard className="p-5">conteúdo</GlassCard>
 *   <GlassCard variant="hi" interactive>opção destacada</GlassCard>
 */
export const GlassCard = forwardRef<HTMLDivElement, GlassCardProps>(
  ({ variant = 'default', radius = '2xl', interactive = false, spec = true, className, children, ...rest }, ref) => {
    return (
      <motion.div
        ref={ref}
        whileHover={interactive ? { y: -2, scale: 1.005 } : undefined}
        transition={{ type: 'spring', stiffness: 320, damping: 26 }}
        className={cn(
          VARIANT[variant],
          RADIUS[radius],
          spec && 'glass-spec',
          interactive && 'transition-shadow hover:shadow-glass-lg cursor-pointer',
          className,
        )}
        {...rest}
      >
        {children}
      </motion.div>
    );
  },
);
GlassCard.displayName = 'GlassCard';

interface GlassPanelProps extends HTMLAttributes<HTMLDivElement> {
  as?: ElementType;
  radius?: GlassRadius;
}

/**
 * Variante "estrutural" — sem animação, mais opaca, pra sidebar/drawer/headers.
 * Não usa motion (evita re-render extra em containers grandes).
 */
export const GlassPanel = forwardRef<HTMLDivElement, GlassPanelProps>(
  ({ as: Tag = 'div', radius = '3xl', className, children, ...rest }, ref) => {
    const Component = Tag as ElementType;
    return (
      <Component
        ref={ref}
        className={cn('glass glass-spec', RADIUS[radius], className)}
        {...rest}
      >
        {children}
      </Component>
    );
  },
);
GlassPanel.displayName = 'GlassPanel';
