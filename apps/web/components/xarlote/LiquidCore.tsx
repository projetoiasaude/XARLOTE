'use client';
import { motion, useReducedMotion } from 'framer-motion';
import { cn } from '@/lib/utils';

export type CoreMode = 'idle' | 'thinking' | 'active';

interface Props {
  size?: number;
  mode?: CoreMode;
  className?: string;
}

/**
 * LiquidCore — a marca viva da Xarlote para botões e avatares.
 * Uma esfera de vidro com um núcleo líquido aurora: três blobs de luz
 * (azul/roxo/rosa) orbitando devagar atrás do vidro, specular no topo e
 * aro interno — leitura de "jelly/refração" sem mascote.
 * thinking: o líquido acelera e satura. active: orbita mais amplo.
 */
export function LiquidCore({ size = 48, mode = 'idle', className }: Props) {
  const reduced = useReducedMotion();
  const on = !reduced;

  const speed = mode === 'thinking' ? 0.38 : mode === 'active' ? 0.7 : 1;
  const amp = mode === 'active' ? 1.25 : 1;
  const u = size / 48; // unidade de escala

  const blob = (
    color: string,
    blobSize: number,
    path: { x: number[]; y: number[]; scale: number[] },
    dur: number,
    delay = 0,
  ) =>
    on
      ? {
          animate: {
            x: path.x.map((v) => v * u * amp),
            y: path.y.map((v) => v * u * amp),
            scale: path.scale,
          },
          transition: { duration: dur * speed, repeat: Infinity, ease: 'easeInOut' as const, delay },
          style: {
            width: blobSize * u,
            height: blobSize * u,
            background: `radial-gradient(circle at 35% 35%, ${color}, transparent 70%)`,
          },
        }
      : {
          style: {
            width: blobSize * u,
            height: blobSize * u,
            background: `radial-gradient(circle at 35% 35%, ${color}, transparent 70%)`,
          },
        };

  return (
    <div
      aria-hidden
      className={cn(
        'relative overflow-hidden rounded-full border border-white/25',
        'bg-white/[0.07] shadow-glass',
        mode === 'thinking' && 'saturate-150',
        className,
      )}
      style={{ width: size, height: size }}
    >
      {/* núcleo líquido — blobs aurora orbitando */}
      <motion.div
        className="absolute rounded-full blur-[6px]"
        {...blob('#3b6ef5', 34, { x: [-4, 14, -4], y: [2, 16, 2], scale: [1, 1.25, 1] }, 7.5)}
      />
      <motion.div
        className="absolute rounded-full blur-[6px]"
        {...blob('#9b5cf6', 32, { x: [20, -2, 20], y: [14, -2, 14], scale: [1.15, 0.9, 1.15] }, 9, 0.6)}
      />
      <motion.div
        className="absolute rounded-full blur-[7px]"
        {...blob('#d946ef', 26, { x: [8, 22, 8], y: [24, 6, 24], scale: [0.95, 1.2, 0.95] }, 11, 1.2)}
      />

      {/* profundidade: sombra interna na base */}
      <div
        className="absolute inset-0 rounded-full"
        style={{ boxShadow: 'inset 0 -8px 14px -6px rgba(4,4,26,0.55), inset 0 2px 4px rgba(255,255,255,0.18)' }}
      />

      {/* specular superior (vidro) */}
      <div
        className="absolute left-[14%] top-[6%] h-[38%] w-[56%] rounded-full"
        style={{
          background: 'linear-gradient(180deg, rgba(255,255,255,0.55), rgba(255,255,255,0.05))',
          filter: 'blur(1.5px)',
          transform: 'rotate(-12deg)',
        }}
      />

      {/* micro-specular pontual */}
      <div
        className="absolute left-[22%] top-[14%] rounded-full bg-white/90"
        style={{ width: 4 * u, height: 4 * u, filter: 'blur(0.5px)' }}
      />
    </div>
  );
}
