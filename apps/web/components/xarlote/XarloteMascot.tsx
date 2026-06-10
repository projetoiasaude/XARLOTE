'use client';
import { motion, useReducedMotion } from 'framer-motion';
import { cn } from '@/lib/utils';

export type MascotMood = 'idle' | 'thinking' | 'happy';

interface Props {
  size?: number;
  mood?: MascotMood;
  /** brilho aurora atrás do corpo */
  glow?: boolean;
  className?: string;
}

/**
 * A Xarlote — axolote vetorial vivo. 100% transform/opacity (GPU‑friendly).
 * idle: flutua, brânquias balançam, pisca. thinking: nada mais rápido.
 * happy: pulinho com squash & stretch. Respeita prefers-reduced-motion.
 */
export function XarloteMascot({ size = 96, mood = 'idle', glow = true, className }: Props) {
  const reduced = useReducedMotion();
  const animate = !reduced;

  const bobAnim = animate
    ? mood === 'thinking'
      ? { y: [0, -4, 0], transition: { duration: 1.4, repeat: Infinity, ease: 'easeInOut' } }
      : mood === 'happy'
        ? { y: [0, -10, 0], scale: [1, 1.08, 0.97, 1.02, 1], transition: { duration: 0.7, ease: 'easeOut' } }
        : { y: [0, -5, 0], transition: { duration: 3.6, repeat: Infinity, ease: 'easeInOut' } }
    : undefined;

  const gillDur = mood === 'thinking' ? 1.1 : 3.2;
  const gillDeg = mood === 'thinking' ? 9 : 5;

  return (
    <motion.div
      animate={bobAnim}
      className={cn('relative inline-block select-none', className)}
      style={{ width: size, height: size }}
      aria-hidden
    >
      {glow && (
        <div
          className="absolute inset-[8%] rounded-full opacity-60 blur-xl"
          style={{
            background:
              'radial-gradient(circle at 35% 30%, rgba(59,110,245,0.55), rgba(155,92,246,0.4) 55%, rgba(217,70,239,0.25) 80%, transparent)',
          }}
        />
      )}
      <svg viewBox="0 0 120 120" width={size} height={size} className="relative">
        <defs>
          <linearGradient id="xarBody" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#ffffff" />
            <stop offset="62%" stopColor="#eceafd" />
            <stop offset="100%" stopColor="#cfc9f0" />
          </linearGradient>
          <linearGradient id="xarGill" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#f3eaff" />
            <stop offset="100%" stopColor="#d3b8f6" />
          </linearGradient>
        </defs>

        {/* Brânquias esquerda */}
        <motion.g
          style={{ originX: '38px', originY: '42px' } as never}
          animate={animate ? { rotate: [-gillDeg, gillDeg, -gillDeg] } : undefined}
          transition={animate ? { duration: gillDur, repeat: Infinity, ease: 'easeInOut' } : undefined}
        >
          <path d="M38 32 Q26 22 18 24" stroke="url(#xarGill)" strokeWidth="6.5" strokeLinecap="round" fill="none" />
          <path d="M35 41 Q21 36 13 41" stroke="url(#xarGill)" strokeWidth="6.5" strokeLinecap="round" fill="none" />
          <path d="M37 50 Q26 52 20 58" stroke="url(#xarGill)" strokeWidth="6.5" strokeLinecap="round" fill="none" />
        </motion.g>

        {/* Brânquias direita */}
        <motion.g
          style={{ originX: '82px', originY: '42px' } as never}
          animate={animate ? { rotate: [gillDeg, -gillDeg, gillDeg] } : undefined}
          transition={animate ? { duration: gillDur, repeat: Infinity, ease: 'easeInOut' } : undefined}
        >
          <path d="M82 32 Q94 22 102 24" stroke="url(#xarGill)" strokeWidth="6.5" strokeLinecap="round" fill="none" />
          <path d="M85 41 Q99 36 107 41" stroke="url(#xarGill)" strokeWidth="6.5" strokeLinecap="round" fill="none" />
          <path d="M83 50 Q94 52 100 58" stroke="url(#xarGill)" strokeWidth="6.5" strokeLinecap="round" fill="none" />
        </motion.g>

        {/* Cauda — curva pra direita como a referência */}
        <path
          d="M56 62 C50 80 56 94 72 98 C86 101 96 93 97 84 C97.5 79 93 76 88 78.5 C83 81 81 86 73 85 C64 84 60 74 62 62 Z"
          fill="url(#xarBody)"
        />

        {/* Patinhas */}
        <path d="M60 70 Q68 72 71 68" stroke="#e8e4fb" strokeWidth="5" strokeLinecap="round" fill="none" />
        <path d="M58 81 Q66 84 69 80" stroke="#dcd6f7" strokeWidth="5" strokeLinecap="round" fill="none" />

        {/* Cabeça */}
        <ellipse cx="60" cy="44" rx="27" ry="22.5" fill="url(#xarBody)" />

        {/* Olhos (piscam) */}
        <motion.g
          style={{ originX: '60px', originY: '47px' } as never}
          animate={animate ? { scaleY: [1, 1, 0.08, 1] } : undefined}
          transition={
            animate ? { duration: 5.2, times: [0, 0.93, 0.965, 1], repeat: Infinity, ease: 'easeInOut' } : undefined
          }
        >
          <circle cx="49.5" cy="46.5" r="4" fill="#101022" />
          <circle cx="70.5" cy="46.5" r="4" fill="#101022" />
          <circle cx="51" cy="45" r="1.3" fill="#ffffff" opacity="0.9" />
          <circle cx="72" cy="45" r="1.3" fill="#ffffff" opacity="0.9" />
        </motion.g>

        {/* Bochechas + sorriso */}
        <ellipse cx="44" cy="53" rx="4" ry="2.2" fill="#f0abfc" opacity="0.35" />
        <ellipse cx="76" cy="53" rx="4" ry="2.2" fill="#f0abfc" opacity="0.35" />
        <path d="M56 55.5 Q60 58.5 64 55.5" stroke="#9d97c4" strokeWidth="1.6" strokeLinecap="round" fill="none" opacity="0.7" />
      </svg>
    </motion.div>
  );
}
