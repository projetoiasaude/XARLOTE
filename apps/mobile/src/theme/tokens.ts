/**
 * Design tokens — porte 1:1 de apps/web/tailwind.config.ts (Liquid Glass).
 *
 * REGRA: valores NUNCA são inventados aqui; qualquer cor/spring/shadow novo nasce no
 * tailwind do web primeiro e é portado — os dois clientes têm que envelhecer juntos.
 */

export const colors = {
  // superfícies
  inkBase: '#0a0a0f',
  inkRaised: '#11111a',
  inkLine: '#1f1f2a',
  /** fundo do app (o navy profundo do web /app e da splash) */
  deep: '#04041a',
  deepAlt: '#0a0a14',

  // marca
  accent: '#7c87ff',
  accentHi: '#a3acff',
  accentLo: '#4a55cc',
  auroraBlue: '#3b6ef5',
  auroraPurple: '#9b5cf6',
  auroraPink: '#d946ef',

  // texto
  text: 'rgba(255,255,255,0.92)',
  textDim: 'rgba(255,255,255,0.64)',
  textFaint: 'rgba(255,255,255,0.40)',

  // semânticas (mesmos tons dos GlassBadge do web)
  success: '#4ade80',
  warn: '#fbbf24',
  danger: '#f87171',
  info: '#38bdf8',

  // vidro (fallback sem blur — Android e listas)
  glassFill: 'rgba(255,255,255,0.05)',
  glassFillHi: 'rgba(255,255,255,0.08)',
  glassFillLo: 'rgba(255,255,255,0.03)',
  glassBorder: 'rgba(255,255,255,0.09)',
  glassBorderHi: 'rgba(255,255,255,0.14)',
} as const;

export const radii = {
  md: 12,
  lg: 16,
  xl: 20,
  '2xl': 24,
  '3xl': 28,
  full: 999,
} as const;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  '2xl': 32,
} as const;

/** Springs do web (framer-motion) → reanimated: stiffness/damping transferem 1:1. */
export const springs = {
  /** hover/entrada de card (web: 320/26) */
  card: { stiffness: 320, damping: 26 },
  /** tap de botão (web: 420/22) */
  button: { stiffness: 420, damping: 22 },
  /** desabrochar das bolhas do OrbNav (web: 400/26) */
  orb: { stiffness: 400, damping: 26 },
} as const;

/**
 * Sombras do web (`boxShadow.glass`/`glass-lg`/`glow-*`).
 *
 * RN 0.76+ na New Architecture aceita `boxShadow` (inclusive `inset`), que é o que
 * dá o fio de luz no topo do vidro. Se a plataforma ignorar, o degradê especular
 * do GlassCard cobre o mesmo papel — a degradação é só de brilho, nunca de layout.
 */
export const shadows = {
  glass: '0 1px 0 0 rgba(255,255,255,0.08) inset, 0 8px 24px -8px rgba(0,0,0,0.4)',
  glassLg: '0 1px 0 0 rgba(255,255,255,0.12) inset, 0 24px 48px -16px rgba(0,0,0,0.5)',
  glowAccent: '0 0 32px -8px rgba(124,135,255,0.55)',
  glowDanger: '0 0 28px -8px rgba(248,113,113,0.5)',
  glowSuccess: '0 0 28px -8px rgba(74,222,128,0.45)',
} as const;

export const typography = {
  /** system = SF no iOS / Roboto no Android — mesma família do web (-apple-system) */
  title: { fontSize: 28, fontWeight: '700' as const, letterSpacing: -0.5 },
  heading: { fontSize: 20, fontWeight: '600' as const, letterSpacing: -0.3 },
  body: { fontSize: 16, fontWeight: '400' as const },
  small: { fontSize: 13, fontWeight: '400' as const },
  tiny: { fontSize: 11, fontWeight: '500' as const },
} as const;
