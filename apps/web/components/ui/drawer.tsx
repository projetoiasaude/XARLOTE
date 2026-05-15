'use client';
import { AnimatePresence, motion } from 'framer-motion';
import { useEffect, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

interface Props {
  open: boolean;
  onClose: () => void;
  side?: 'right' | 'left';
  width?: string;
  /** Renderiza o backdrop blur de fundo (default true) */
  backdrop?: boolean;
  className?: string;
  children: ReactNode;
}

/**
 * Drawer lateral animado com spring. Substitui drawers manuais com useState.
 *
 * - Esc fecha
 * - Click no backdrop fecha
 * - Animação spring: x: ±320 → 0 (entrada), inverso na saída
 */
export function Drawer({
  open,
  onClose,
  side = 'right',
  width = 'w-full max-w-md',
  backdrop = true,
  className,
  children,
}: Props) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  return (
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-50">
          {backdrop && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
              onClick={onClose}
              className="absolute inset-0 bg-black/40 backdrop-blur-sm"
            />
          )}
          <motion.aside
            initial={{ x: side === 'right' ? '100%' : '-100%' }}
            animate={{ x: 0 }}
            exit={{ x: side === 'right' ? '100%' : '-100%' }}
            transition={{ type: 'spring', stiffness: 360, damping: 36 }}
            className={cn(
              'absolute top-0 h-full',
              side === 'right' ? 'right-0' : 'left-0',
              width,
              'glass glass-spec border-y-0',
              side === 'right' ? 'border-r-0 rounded-l-3xl' : 'border-l-0 rounded-r-3xl',
              'shadow-glass-lg overflow-hidden flex flex-col',
              className,
            )}
          >
            {children}
          </motion.aside>
        </div>
      )}
    </AnimatePresence>
  );
}
