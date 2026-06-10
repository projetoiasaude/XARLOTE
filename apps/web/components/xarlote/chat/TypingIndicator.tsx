'use client';
import { motion } from 'framer-motion';
import { LiquidCore } from '../LiquidCore';

/** “Xarlote está digitando” — núcleo líquido acelerado + pontos em onda. */
export function TypingIndicator() {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8, scale: 0.95 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 4, scale: 0.95 }}
      transition={{ type: 'spring', stiffness: 360, damping: 26 }}
      className="flex items-end gap-2"
    >
      <LiquidCore size={30} mode="thinking" />
      <div className="glass glass-spec flex items-center gap-1.5 rounded-3xl rounded-bl-lg px-4 py-3">
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className="h-1.5 w-1.5 animate-dot-wave rounded-full bg-accent-hi"
            style={{ animationDelay: `${i * 0.18}s` }}
          />
        ))}
      </div>
    </motion.div>
  );
}
