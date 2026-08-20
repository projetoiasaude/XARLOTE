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

  /**
   * Texto — TRÊS degraus, com ≥0.15 de alfa entre vizinhos.
   *
   * Os valores antigos (0.92 / 0.64 / 0.40) foram calibrados no olho de quem desenhou,
   * num monitor. `textFaint` a 0.40 mede **3,69:1** sobre o `deep` (#04041a) e 3,80:1
   * sobre um GlassCard — abaixo do mínimo AA de 4,5:1. E ele era o tom que carregava
   * dose, frequência, data de exame e intensidade de sintoma: informação clínica que o
   * app tecnicamente mostrava e a paciente de 55 anos, na rua, efetivamente não lia.
   *
   * 0.55 passa AA com margem (0.50 passaria por 0,11 ponto — sem folga pro sol nem pra
   * variação do fill do vidro). Subir só o faint comprimiria a hierarquia contra o dim,
   * então `textDim` sobe junto pra 0.72. Duas linhas aqui consertam os ~53 call-sites
   * de `textFaint` e os ~30 de `textDim` sem tocar em nenhuma tela.
   */
  text: 'rgba(255,255,255,0.92)',
  textDim: 'rgba(255,255,255,0.72)',
  textFaint: 'rgba(255,255,255,0.55)',
  /** Sobre `accent`/`danger`/`success` preenchidos — nunca `#fff` cru na tela. */
  textOnFill: '#ffffff',
  /** Tom claro do danger, pra texto de erro sobre fundo escuro (o `#fda4af` solto). */
  dangerSoft: '#fda4af',

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
 * dá o fio de luz no topo do vidro.
 *
 * ## As duas metades NÃO custam a mesma coisa
 *
 * Conferido no fonte do RN 0.86 (`ReactAndroid/.../drawable/OutsetBoxShadowDrawable.kt`):
 * uma sombra OUTSET com raio de blur > 0 vira `Paint.maskFilter = BlurMaskFilter(...)`,
 * um blur de máscara por drawable, cobrado a cada quadro esteja o card animando ou não.
 * A metade INSET com blur 0 pula esse caminho (`if (convertedBlurRadius > 0)`) e é de
 * graça.
 *
 * Como todo `GlassCard` é uma LINHA DE LISTA, a sombra outset era um blur por linha: a
 * Saúde 360 subia com ~20-25 de uma vez. Quanto mais completo o prontuário, mais lento
 * o app do paciente — a lição de taxa de preenchimento de 18/08 uma escala abaixo.
 *
 * Daí a separação: `hairline` é o que toda superfície usa (só o fio de luz, grátis), e
 * `glass` (com a outset) fica pra superfície ESTRUTURAL e rara — ver glassSurface().
 */
export const shadows = {
  /** Só o fio de luz no topo. Blur 0 → nenhum maskFilter. É o default do vidro. */
  hairline: '0 1px 0 0 rgba(255,255,255,0.10) inset',
  glass: '0 1px 0 0 rgba(255,255,255,0.08) inset, 0 8px 24px -8px rgba(0,0,0,0.4)',
  glassLg: '0 1px 0 0 rgba(255,255,255,0.12) inset, 0 24px 48px -16px rgba(0,0,0,0.5)',
  glowAccent: '0 0 32px -8px rgba(124,135,255,0.55)',
  glowDanger: '0 0 28px -8px rgba(248,113,113,0.5)',
  glowSuccess: '0 0 28px -8px rgba(74,222,128,0.45)',
} as const;

/**
 * Piso de tipografia — número, não gosto.
 *
 * `FONTE_MINIMA` é o menor tamanho permitido em qualquer texto do app; `FONTE_CLINICA`
 * é o piso pra dado que a pessoa usa pra tomar decisão (dose, frequência, horário,
 * data de exame, intensidade de sintoma, unidade do gráfico). Metadado descartável
 * ("há 3 dias") pode ficar no mínimo; dose NUNCA.
 */
export const FONTE_MINIMA = 12;
export const FONTE_CLINICA = 13;

export const typography = {
  /** system = SF no iOS / Roboto no Android — mesma família do web (-apple-system) */
  title: { fontSize: 28, fontWeight: '700' as const, letterSpacing: -0.5 },
  heading: { fontSize: 20, fontWeight: '600' as const, letterSpacing: -0.3 },
  body: { fontSize: 16, fontWeight: '400' as const },
  /** Dado clínico — o piso de 13px. */
  small: { fontSize: FONTE_CLINICA, fontWeight: '400' as const },
  /** Metadado descartável. Era 11; subiu pro piso de 12 (ninguém usava — a norma fica). */
  tiny: { fontSize: FONTE_MINIMA, fontWeight: '500' as const },
} as const;
