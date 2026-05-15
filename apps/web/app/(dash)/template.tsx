'use client';
import { motion } from 'framer-motion';
import type { ReactNode } from 'react';

/**
 * Page transition consistente entre rotas do dashboard.
 * Next.js renderiza um <template> novo a cada navegação — por isso o
 * fade-up roda toda vez (diferente do layout.tsx que persiste).
 */
export default function DashTemplate({ children }: { children: ReactNode }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
    >
      {children}
    </motion.div>
  );
}
