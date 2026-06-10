import type { Config } from 'tailwindcss';

export default {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Legacy WhatsApp palette — mantida pra não quebrar componentes
        // existentes durante migração. Novas telas usam ink/glass/accent.
        brand: {
          50: '#f0fdf4',
          500: '#22c55e',
          600: '#16a34a',
          900: '#14532d',
        },
        wa: {
          bg: '#0b141a',
          panel: '#111b21',
          bubble_out: '#005c4b',
          bubble_in: '#202c33',
          input: '#2a3942',
          border: '#222d34',
        },
        // ────── Liquid Glass tokens ──────
        ink: {
          base: '#0a0a0f',
          raised: '#11111a',
          line: '#1f1f2a',
        },
        accent: {
          DEFAULT: '#7c87ff',
          hi: '#a3acff',
          lo: '#4a55cc',
        },
        aurora: {
          blue: '#3b6ef5',
          purple: '#9b5cf6',
          pink: '#d946ef',
        },
      },
      backdropBlur: {
        glass: '40px',
        'glass-xl': '60px',
      },
      backdropSaturate: {
        glass: '1.8',
      },
      boxShadow: {
        glass:
          '0 1px 0 0 rgba(255,255,255,0.08) inset, 0 8px 24px -8px rgba(0,0,0,0.4), 0 2px 4px -2px rgba(0,0,0,0.2)',
        'glass-lg':
          '0 1px 0 0 rgba(255,255,255,0.12) inset, 0 24px 48px -16px rgba(0,0,0,0.5), 0 4px 12px -4px rgba(0,0,0,0.3)',
        'glow-accent': '0 0 32px -8px rgba(124,135,255,0.55)',
        'glow-danger': '0 0 28px -8px rgba(248,113,113,0.5)',
        'glow-success': '0 0 28px -8px rgba(74,222,128,0.45)',
      },
      fontFamily: {
        sans: [
          '-apple-system',
          'BlinkMacSystemFont',
          '"SF Pro Display"',
          'Inter',
          'system-ui',
          'sans-serif',
        ],
        mono: ['"SF Mono"', '"JetBrains Mono"', 'Menlo', 'monospace'],
      },
      animation: {
        'orb-1': 'orb1 32s ease-in-out infinite',
        'orb-2': 'orb2 48s ease-in-out infinite',
        'orb-3': 'orb3 60s ease-in-out infinite',
        shimmer: 'shimmer 2.2s linear infinite',
        'fade-up': 'fadeUp 0.45s cubic-bezier(0.22, 1, 0.36, 1)',
        'fade-in': 'fadeIn 0.35s ease-out',
        'pulse-ring': 'pulseRing 1.6s ease-out infinite',
        // ── Xarlote App ──
        floaty: 'floaty 3.6s ease-in-out infinite',
        breathe: 'breathe 2.8s ease-in-out infinite',
        'dot-wave': 'dotWave 1.15s ease-in-out infinite',
        'aurora-flow': 'auroraFlow 2.6s linear infinite',
      },
      keyframes: {
        orb1: {
          '0%, 100%': { transform: 'translate3d(-10%, -10%, 0) scale(1)' },
          '50%': { transform: 'translate3d(15%, 8%, 0) scale(1.15)' },
        },
        orb2: {
          '0%, 100%': { transform: 'translate3d(20%, 30%, 0) scale(1.1)' },
          '50%': { transform: 'translate3d(-10%, -5%, 0) scale(0.95)' },
        },
        orb3: {
          '0%, 100%': { transform: 'translate3d(-5%, 20%, 0) scale(0.9)' },
          '50%': { transform: 'translate3d(10%, -15%, 0) scale(1.05)' },
        },
        shimmer: {
          '0%': { transform: 'translateX(-100%)' },
          '100%': { transform: 'translateX(100%)' },
        },
        fadeUp: {
          '0%': { opacity: '0', transform: 'translateY(8px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        fadeIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        pulseRing: {
          '0%': { transform: 'scale(1)', opacity: '0.7' },
          '100%': { transform: 'scale(2.4)', opacity: '0' },
        },
        // ── Xarlote App ──
        floaty: {
          '0%, 100%': { transform: 'translateY(0px)' },
          '50%': { transform: 'translateY(-5px)' },
        },
        breathe: {
          '0%, 100%': { boxShadow: '0 0 28px -10px rgba(124,135,255,0.45)' },
          '50%': { boxShadow: '0 0 44px -8px rgba(155,92,246,0.65)' },
        },
        dotWave: {
          '0%, 60%, 100%': { transform: 'translateY(0)', opacity: '0.45' },
          '30%': { transform: 'translateY(-4px)', opacity: '1' },
        },
        auroraFlow: {
          '0%': { backgroundPosition: '0% 50%' },
          '100%': { backgroundPosition: '200% 50%' },
        },
      },
    },
  },
  plugins: [],
} satisfies Config;
