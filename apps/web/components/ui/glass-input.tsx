'use client';
import { forwardRef, type InputHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

interface GlassInputProps extends InputHTMLAttributes<HTMLInputElement> {
  /** Mostra um shimmer/glow no focus */
  glowOnFocus?: boolean;
}

const baseInput =
  'w-full bg-white/[0.04] border border-white/10 rounded-xl px-3.5 py-2.5 text-sm text-white placeholder:text-white/30 ' +
  'transition-colors duration-150 ' +
  'focus:outline-none focus:bg-white/[0.07] focus:border-accent/60 focus:ring-2 focus:ring-accent/20 ' +
  'disabled:opacity-50 disabled:cursor-not-allowed';

export const GlassInput = forwardRef<HTMLInputElement, GlassInputProps>(
  ({ className, glowOnFocus, ...rest }, ref) => (
    <input ref={ref} className={cn(baseInput, glowOnFocus && 'focus:shadow-glow-accent', className)} {...rest} />
  ),
);
GlassInput.displayName = 'GlassInput';

interface GlassTextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {}

export const GlassTextarea = forwardRef<HTMLTextAreaElement, GlassTextareaProps>(
  ({ className, ...rest }, ref) => (
    <textarea
      ref={ref}
      className={cn(baseInput, 'resize-y font-mono leading-relaxed', className)}
      {...rest}
    />
  ),
);
GlassTextarea.displayName = 'GlassTextarea';
