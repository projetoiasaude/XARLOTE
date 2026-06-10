'use client';
import { motion } from 'framer-motion';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

interface Props {
  title: ReactNode;
  subtitle?: ReactNode;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
}

export const screenStagger = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { staggerChildren: 0.055, delayChildren: 0.04 } },
};

export const screenItem = {
  hidden: { opacity: 0, y: 16, filter: 'blur(5px)' },
  show: {
    opacity: 1,
    y: 0,
    filter: 'blur(0px)',
    transition: { type: 'spring', stiffness: 300, damping: 28 },
  },
};

/** Casca padrão das telas internas — header grande + stagger + folga pro orb. */
export function Screen({ title, subtitle, right, children, className }: Props) {
  return (
    <main className={cn('flex-1 px-4 pt-safe', className)}>
      <motion.div variants={screenStagger} initial="hidden" animate="show" className="mx-auto w-full max-w-2xl pb-32 pt-6">
        <motion.header variants={screenItem} className="mb-5 flex items-end justify-between gap-3">
          <div>
            <h1 className="text-[26px] font-bold leading-tight tracking-tight">{title}</h1>
            {subtitle && <p className="mt-1 text-sm text-white/50">{subtitle}</p>}
          </div>
          {right}
        </motion.header>
        {children}
      </motion.div>
    </main>
  );
}
