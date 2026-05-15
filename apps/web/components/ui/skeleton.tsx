import { cn } from '@/lib/utils';

interface Props {
  variant?: 'card' | 'line' | 'circle';
  className?: string;
}

/**
 * Loading skeleton com shimmer animado.
 *
 * - card: bloco com altura ~120px (config via className)
 * - line: linha de texto (h-4)
 * - circle: avatar circular (default h-10 w-10)
 */
export function Skeleton({ variant = 'line', className }: Props) {
  const base =
    'relative overflow-hidden bg-white/[0.04] border border-white/5 ' +
    'before:absolute before:inset-0 before:-translate-x-full before:animate-shimmer ' +
    'before:bg-gradient-to-r before:from-transparent before:via-white/8 before:to-transparent';
  const variantCls =
    variant === 'card' ? 'h-32 rounded-2xl' :
    variant === 'circle' ? 'h-10 w-10 rounded-full' :
    'h-4 rounded-md';
  return <div className={cn(base, variantCls, className)} />;
}
