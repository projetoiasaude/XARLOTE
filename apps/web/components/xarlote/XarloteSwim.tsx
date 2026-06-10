'use client';
import { motion, useReducedMotion } from 'framer-motion';
import { cn } from '@/lib/utils';

interface Props {
  size?: number;
  className?: string;
}

const EASE = 'easeInOut' as const;

/**
 * A Xarlote nadando — axolote com leitura de render 3D (gradientes em camadas,
 * rim light azul→roxo, speculars suaves) e anatomia fiel às referências:
 * cabeça arredondada, 6 brânquias, corpo, 4 patinhas e cauda-nadadeira.
 * Loop perfeito e lento: corpo flutua, cauda ondula com follow-through,
 * patinhas remam em fases alternadas, brânquias acompanham a água, bolhas sobem.
 * Tudo transform/opacity. Respeita prefers-reduced-motion (vira pose estática).
 */
export function XarloteSwim({ size = 220, className }: Props) {
  const reduced = useReducedMotion();
  const on = !reduced;

  const sway = (deg: number, dur: number, delay = 0, inverse = false) =>
    on
      ? {
          animate: { rotate: inverse ? [deg, -deg, deg] : [-deg, deg, -deg] },
          transition: { duration: dur, repeat: Infinity, ease: EASE, delay },
        }
      : {};

  return (
    <motion.div
      animate={on ? { y: [0, -9, 0] } : undefined}
      transition={on ? { duration: 6, repeat: Infinity, ease: EASE } : undefined}
      className={cn('relative inline-block select-none', className)}
      style={{ width: size, height: size }}
      aria-hidden
    >
      {/* halo aurora atrás (luz do ambiente) */}
      <div
        className="absolute inset-[6%] rounded-full opacity-50 blur-2xl"
        style={{
          background:
            'radial-gradient(circle at 38% 30%, rgba(99,124,250,0.45), rgba(155,92,246,0.32) 55%, rgba(217,70,239,0.18) 78%, transparent)',
        }}
      />

      <motion.svg
        viewBox="0 0 240 240"
        width={size}
        height={size}
        className="relative"
        animate={on ? { rotate: [-1.6, 1.6, -1.6] } : undefined}
        transition={on ? { duration: 8, repeat: Infinity, ease: EASE } : undefined}
        style={{ originX: '50%', originY: '46%' }}
      >
        <defs>
          <radialGradient id="xsBody" cx="0.38" cy="0.28" r="1.05">
            <stop offset="0%" stopColor="#ffffff" />
            <stop offset="48%" stopColor="#f4f2fd" />
            <stop offset="78%" stopColor="#ddd7f6" />
            <stop offset="100%" stopColor="#c3baea" />
          </radialGradient>
          <linearGradient id="xsGill" x1="1" y1="0.2" x2="0" y2="0.8">
            <stop offset="0%" stopColor="#f8f3ff" />
            <stop offset="55%" stopColor="#e6d4fb" />
            <stop offset="100%" stopColor="#d4b3f5" />
          </linearGradient>
          <radialGradient id="xsEye" cx="0.35" cy="0.3" r="0.9">
            <stop offset="0%" stopColor="#3a3a52" />
            <stop offset="55%" stopColor="#15151f" />
            <stop offset="100%" stopColor="#08080f" />
          </radialGradient>
          <linearGradient id="xsRimBlue" x1="0" y1="0" x2="0.4" y2="1">
            <stop offset="0%" stopColor="#7d96ff" stopOpacity="0" />
            <stop offset="55%" stopColor="#6f8cff" />
            <stop offset="100%" stopColor="#9f6efc" />
          </linearGradient>
          <linearGradient id="xsRimPink" x1="0" y1="0" x2="1" y2="0.6">
            <stop offset="0%" stopColor="#9f6efc" />
            <stop offset="100%" stopColor="#ec7cf8" />
          </linearGradient>
          <filter id="xsBlur2"><feGaussianBlur stdDeviation="2.1" /></filter>
          <filter id="xsBlur5"><feGaussianBlur stdDeviation="5" /></filter>
        </defs>

        {/* ── CAUDA (atrás do corpo) — ondula a partir do quadril ── */}
        <motion.g style={{ originX: '124px', originY: '160px' } as never} {...sway(6, 4.2)}>
          <path
            d="M112 148 C104 180 120 204 148 210 C178 216 200 203 203 183 C205 168 194 158 181 163 C168 168 167 182 150 181 C133 180 127 162 130 144 Z"
            fill="url(#xsBody)"
          />
          {/* membrana clara da nadadeira */}
          <ellipse cx="176" cy="188" rx="17" ry="11" fill="#ffffff" opacity="0.32" filter="url(#xsBlur5)" />
          {/* rim light inferior (roxo→rosa) */}
          <path
            d="M114 174 C121 196 141 209 163 211"
            stroke="url(#xsRimPink)" strokeWidth="3.4" strokeLinecap="round" fill="none"
            filter="url(#xsBlur2)" opacity="0.85"
          />
          <path
            d="M199 190 C204 178 200 167 189 165"
            stroke="url(#xsRimPink)" strokeWidth="2.8" strokeLinecap="round" fill="none"
            filter="url(#xsBlur2)" opacity="0.8"
          />
        </motion.g>

        {/* ── patinha traseira esquerda (atrás do corpo) ── */}
        <motion.g style={{ originX: '108px', originY: '166px' } as never} {...sway(7, 3.4, 0.3)}>
          <path d="M108 166 C101 174 99 183 103 190" stroke="#dcd5f5" strokeWidth="9" strokeLinecap="round" fill="none" />
          <path d="M103 189 L97 195 M104 190 L101 198" stroke="#d3caf2" strokeWidth="3.6" strokeLinecap="round" />
        </motion.g>

        {/* ── CORPO ── */}
        <g>
          <path
            d="M94 96 C86 116 86 146 96 166 C104 182 122 188 134 178 C144 169 146 148 142 124 C139 106 136 96 128 88 Z"
            fill="url(#xsBody)"
          />
          {/* spec da barriga */}
          <ellipse cx="106" cy="126" rx="11" ry="22" fill="#ffffff" opacity="0.3" filter="url(#xsBlur5)" />
          {/* rim light esquerdo (azul) */}
          <path
            d="M92 110 C87 134 89 154 99 170"
            stroke="url(#xsRimBlue)" strokeWidth="3.2" strokeLinecap="round" fill="none"
            filter="url(#xsBlur2)" opacity="0.75"
          />
        </g>

        {/* ── patinha traseira direita (sobre a base da cauda) ── */}
        <motion.g style={{ originX: '130px', originY: '168px' } as never} {...sway(7, 3.4, 1.0, true)}>
          <path d="M130 168 C138 175 141 184 137 191" stroke="#ece7fb" strokeWidth="9" strokeLinecap="round" fill="none" />
          <path d="M137 190 L143 196 M136 191 L139 199" stroke="#ddd4f6" strokeWidth="3.6" strokeLinecap="round" />
        </motion.g>

        {/* ── patinhas dianteiras (remam alternadas) ── */}
        <motion.g style={{ originX: '99px', originY: '112px' } as never} {...sway(9, 2.9)}>
          <path d="M99 112 C92 122 90 131 94 139" stroke="#eee9fc" strokeWidth="9.5" strokeLinecap="round" fill="none" />
          <path d="M94 138 L88 144 M95 139 L92 147" stroke="#ded6f7" strokeWidth="3.6" strokeLinecap="round" />
        </motion.g>
        <motion.g style={{ originX: '137px', originY: '112px' } as never} {...sway(9, 2.9, 1.45, true)}>
          <path d="M137 112 C145 121 147 130 143 138" stroke="#f3effd" strokeWidth="9.5" strokeLinecap="round" fill="none" />
          <path d="M143 137 L149 143 M142 138 L146 146" stroke="#e2daf8" strokeWidth="3.6" strokeLinecap="round" />
        </motion.g>

        {/* ── CABEÇA (leve aceno) ── */}
        <motion.g style={{ originX: '118px', originY: '92px' } as never} {...sway(1.8, 5.4)}>
          {/* brânquias esquerda */}
          <motion.g style={{ originX: '86px', originY: '60px' } as never} {...sway(4, 3.4)}>
            <path d="M88 62 C70 48 52 42 40 46 C44 36 64 36 80 46 C87 50 90 56 88 62 Z" fill="url(#xsGill)" />
          </motion.g>
          <motion.g style={{ originX: '80px', originY: '78px' } as never} {...sway(4, 3.8, 0.35)}>
            <path d="M82 82 C60 76 42 78 33 86 C33 74 52 66 70 71 C78 73 83 78 82 82 Z" fill="url(#xsGill)" />
          </motion.g>
          <motion.g style={{ originX: '84px', originY: '94px' } as never} {...sway(4, 4.2, 0.7)}>
            <path d="M86 96 C68 100 54 109 49 119 C42 108 54 94 71 89 C79 87 85 91 86 96 Z" fill="url(#xsGill)" />
          </motion.g>
          {/* brânquias direita (espelhadas) */}
          <g transform="translate(240 0) scale(-1 1)">
            <motion.g style={{ originX: '86px', originY: '60px' } as never} {...sway(4, 3.4, 0.2, true)}>
              <path d="M88 62 C70 48 52 42 40 46 C44 36 64 36 80 46 C87 50 90 56 88 62 Z" fill="url(#xsGill)" />
            </motion.g>
            <motion.g style={{ originX: '80px', originY: '78px' } as never} {...sway(4, 3.8, 0.55, true)}>
              <path d="M82 82 C60 76 42 78 33 86 C33 74 52 66 70 71 C78 73 83 78 82 82 Z" fill="url(#xsGill)" />
            </motion.g>
            <motion.g style={{ originX: '84px', originY: '94px' } as never} {...sway(4, 4.2, 0.9, true)}>
              <path d="M86 96 C68 100 54 109 49 119 C42 108 54 94 71 89 C79 87 85 91 86 96 Z" fill="url(#xsGill)" />
            </motion.g>
          </g>

          {/* cabeça */}
          <path
            d="M75 86 C73 56 94 40 119 40 C144 40 165 56 163 86 C161 108 143 120 119 120 C95 120 77 108 75 86 Z"
            fill="url(#xsBody)"
          />
          {/* specular do topo */}
          <ellipse cx="103" cy="58" rx="24" ry="12" fill="#ffffff" opacity="0.75" filter="url(#xsBlur5)" />
          {/* rim lights da mandíbula */}
          <path
            d="M79 94 C82 106 94 116 108 119"
            stroke="url(#xsRimBlue)" strokeWidth="2.8" strokeLinecap="round" fill="none"
            filter="url(#xsBlur2)" opacity="0.8"
          />
          <path
            d="M159 94 C156 106 144 116 130 119"
            stroke="url(#xsRimPink)" strokeWidth="2.6" strokeLinecap="round" fill="none"
            filter="url(#xsBlur2)" opacity="0.7"
          />

          {/* olhos — esferas pretas com brilho (piscam) */}
          <motion.g
            style={{ originX: '119px', originY: '90px' } as never}
            animate={on ? { scaleY: [1, 1, 0.06, 1] } : undefined}
            transition={on ? { duration: 6.2, times: [0, 0.94, 0.97, 1], repeat: Infinity, ease: EASE } : undefined}
          >
            <circle cx="97" cy="90" r="8" fill="url(#xsEye)" />
            <circle cx="141" cy="90" r="8" fill="url(#xsEye)" />
            <circle cx="94.4" cy="87" r="2.6" fill="#ffffff" opacity="0.95" />
            <circle cx="138.4" cy="87" r="2.6" fill="#ffffff" opacity="0.95" />
            <circle cx="99.5" cy="93.5" r="1.2" fill="#8d8dc0" opacity="0.7" />
            <circle cx="143.5" cy="93.5" r="1.2" fill="#8d8dc0" opacity="0.7" />
          </motion.g>
        </motion.g>

        {/* ── bolhas subindo ── */}
        {on &&
          [
            { cx: 58, cy: 178, r: 3, dur: 9, delay: 0 },
            { cx: 190, cy: 132, r: 2.4, dur: 11, delay: 2.5 },
            { cx: 72, cy: 96, r: 2, dur: 13, delay: 5 },
          ].map((b, i) => (
            <motion.circle
              key={i}
              cx={b.cx}
              cy={b.cy}
              r={b.r}
              fill="#cdd6ff"
              initial={{ opacity: 0 }}
              animate={{ y: [-0, -130], opacity: [0, 0.5, 0.4, 0] }}
              transition={{ duration: b.dur, repeat: Infinity, ease: 'linear', delay: b.delay }}
            />
          ))}
      </motion.svg>
    </motion.div>
  );
}
