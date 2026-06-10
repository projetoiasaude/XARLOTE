'use client';
import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { cn } from '@/lib/utils';
import { XarloteSwim } from './XarloteSwim';
import { XarloteVideoAlpha } from './XarloteVideoAlpha';

interface Props {
  size?: number;
  className?: string;
}

const ALPHA_SRC = '/xarlote-alpha.mp4';

/**
 * Herói da entrada — toca o VÍDEO 3D do mascote JÁ RECORTADO (fundo removido),
 * recomposto no GPU (XarloteVideoAlpha) pra rodar em Android e iOS. O mascote
 * flutua sobre o fundo aurora do app, sem moldura. Enquanto o arquivo não existe
 * (ou sem GPU), cai com elegância no desenho vetorial animado.
 */
export function XarloteHero({ size = 240, className }: Props) {
  // null = sondando · true = achou vídeo · false = sem vídeo (fallback SVG)
  const [hasVideo, setHasVideo] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(ALPHA_SRC, { method: 'HEAD', cache: 'no-store' });
        const type = res.headers.get('content-type') ?? '';
        if (!cancelled) setHasVideo(res.ok && type.startsWith('video'));
      } catch {
        if (!cancelled) setHasVideo(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className={cn('relative', className)} style={{ width: size, height: size }} aria-hidden>
      {/* luz aurora por trás — integra o mascote à cena */}
      <div
        className="absolute inset-[4%] rounded-full opacity-50 blur-2xl"
        style={{
          background:
            'radial-gradient(circle at 46% 38%, rgba(99,124,250,0.5), rgba(155,92,246,0.32) 55%, rgba(217,70,239,0.16) 80%, transparent)',
        }}
      />
      {hasVideo === true && (
        <motion.div
          initial={{ opacity: 0, scale: 0.97 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
          className="relative"
        >
          <XarloteVideoAlpha src={ALPHA_SRC} size={size} fallback={<XarloteSwim size={size} />} />
        </motion.div>
      )}
      {hasVideo !== true && (
        <div className="absolute inset-0 grid place-items-center">
          <XarloteSwim size={size * 0.92} />
        </div>
      )}
    </div>
  );
}
