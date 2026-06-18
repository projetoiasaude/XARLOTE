'use client';
import { motion, useReducedMotion } from 'framer-motion';

/** Transição líquida entre telas — emerge da água: sobe, desfoca → foca. */
export default function XarloteTemplate({ children }: { children: React.ReactNode }) {
  const reduced = useReducedMotion();
  return (
    <motion.div
      initial={reduced ? { opacity: 0 } : { opacity: 0, y: 14, filter: 'blur(8px)', scale: 0.985 }}
      animate={reduced ? { opacity: 1 } : { opacity: 1, y: 0, filter: 'blur(0px)', scale: 1 }}
      transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
      className="flex min-h-svh flex-col"
    >
      {children}
    </motion.div>
  );
}
