'use client';
import { motion, useReducedMotion } from 'framer-motion';
import { cn } from '@/lib/utils';

interface Props {
  size?: number;
  className?: string;
  /** brilho aurora atrás da logo (default: true) — dá vida aos estados vazios */
  glow?: boolean;
  /** flutuação suave (default: true) */
  float?: boolean;
}

/**
 * Logo OFICIAL da Xarlote — axolote em traço (versão branca, `public/xarlote-logo.svg`).
 * Substitui o mascote vetorial caricato em toda parte: estados vazios, splash e
 * fallback do vídeo. SVG = nunca pixela; branco cai limpo no fundo escuro do app.
 */
export function XarloteLogo({ size = 140, className, glow = true, float = true }: Props) {
  const reduced = useReducedMotion();

  return (
    <div
      className={cn('relative grid place-items-center', className)}
      style={{ width: size, height: size }}
      aria-hidden
    >
      {glow && (
        <div
          className="absolute inset-[8%] rounded-full opacity-45 blur-2xl"
          style={{
            background:
              'radial-gradient(circle at 48% 42%, rgba(99,124,250,0.55), rgba(155,92,246,0.3) 58%, rgba(217,70,239,0.14) 82%, transparent)',
          }}
        />
      )}
      <motion.img
        src="/xarlote-logo.svg"
        alt="Xarlote"
        width={size}
        height={size}
        draggable={false}
        className="relative select-none"
        style={{ width: size, height: size, objectFit: 'contain' }}
        animate={float && !reduced ? { y: [0, -6, 0] } : undefined}
        transition={float && !reduced ? { duration: 4.5, repeat: Infinity, ease: 'easeInOut' } : undefined}
      />
    </div>
  );
}
