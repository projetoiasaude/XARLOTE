'use client';
import { useEffect, useRef, useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { cn } from '@/lib/utils';
import { XarloteSwim } from './XarloteSwim';

interface Props {
  size?: number;
  className?: string;
}

/**
 * Herói da tela de entrada — toca o VÍDEO 3D do mascote em loop
 * (`/xarlote-swim.webm` ou `/xarlote-swim.mp4` em `apps/web/public/`).
 * O vídeo é mascarado com gradiente radial pra fundir no fundo navy do app
 * (sem precisar de alpha). Enquanto o arquivo não existir, cai com elegância
 * no desenho vetorial animado (XarloteSwim).
 */
export function XarloteHero({ size = 240, className }: Props) {
  const reduced = useReducedMotion();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  // null = sondando · 'webm'/'mp4' = achou vídeo · false = sem vídeo (fallback SVG)
  const [source, setSource] = useState<string | false | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      for (const file of ['/xarlote-swim.webm', '/xarlote-swim.mp4']) {
        try {
          const res = await fetch(file, { method: 'HEAD', cache: 'no-store' });
          const type = res.headers.get('content-type') ?? '';
          if (res.ok && type.startsWith('video')) {
            if (!cancelled) setSource(file);
            return;
          }
        } catch {
          /* segue pro próximo */
        }
      }
      if (!cancelled) setSource(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Acessibilidade: com reduced-motion, congela o vídeo no primeiro frame
  useEffect(() => {
    const v = videoRef.current;
    if (v && reduced) v.pause();
  }, [reduced, source]);

  if (source === false) return <XarloteSwim size={size} className={className} />;

  return (
    <div className={cn('relative', className)} style={{ width: size, height: size }} aria-hidden>
      {/* luz aurora por trás — integra o vídeo à cena */}
      <div
        className="absolute inset-[2%] rounded-full opacity-55 blur-2xl"
        style={{
          background:
            'radial-gradient(circle at 42% 32%, rgba(99,124,250,0.5), rgba(155,92,246,0.34) 55%, rgba(217,70,239,0.18) 78%, transparent)',
        }}
      />
      {source && (
        <motion.video
          ref={videoRef}
          key={source}
          initial={{ opacity: 0, scale: 0.97 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
          className="relative h-full w-full object-cover"
          style={{
            // funde as bordas do vídeo (fundo escuro) no fundo do app
            WebkitMaskImage: 'radial-gradient(circle at 50% 50%, black 58%, transparent 76%)',
            maskImage: 'radial-gradient(circle at 50% 50%, black 58%, transparent 76%)',
          }}
          src={source}
          autoPlay
          muted
          loop
          playsInline
          preload="auto"
          onError={() => setSource(false)}
        />
      )}
      {/* enquanto sonda, mostra o vetor pra não piscar vazio */}
      {source === null && (
        <div className="absolute inset-0 grid place-items-center">
          <XarloteSwim size={size * 0.92} />
        </div>
      )}
    </div>
  );
}
