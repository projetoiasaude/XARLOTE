/**
 * A regra do vidro, escrita como código em vez de comentário.
 *
 * No web `.glass` é uma classe com `backdrop-filter` — barato, o compositor do
 * navegador resolve. Em RN o equivalente é um `BlurView` REAL, que custa GPU a cada
 * frame e no Android é notoriamente pesado e serrilhado.
 *
 * Daí a regra do projeto: **blur só no iOS e só em superfície ESTÁTICA** (header,
 * drawer, painel de fundo). Nunca numa linha de lista que rola — em movimento o
 * fallback translúcido é indistinguível e custa zero.
 *
 * A regra vive no DEFAULT das props: `GlassPanel` (estrutural, parado) pede blur;
 * `GlassCard` (usado dentro de listas) não. Quem quiser furar a regra tem que
 * escrever `blur` explicitamente — e aí é escolha, não descuido.
 */
import { Platform, type ViewStyle } from 'react-native';
import { colors, radii, shadows } from './tokens';

export type GlassVariant = 'default' | 'hi' | 'lo';
export type GlassRadius = 'lg' | 'xl' | '2xl' | '3xl';

/** Blur real só entra no iOS. No Android o fallback translúcido é a superfície. */
export const CAN_BLUR = Platform.OS === 'ios';

const FILL: Record<GlassVariant, string> = {
  default: colors.glassFill,
  hi: colors.glassFillHi,
  lo: colors.glassFillLo,
};

const BORDER: Record<GlassVariant, string> = {
  default: colors.glassBorder,
  hi: colors.glassBorderHi,
  lo: colors.glassBorder,
};

export const RADIUS: Record<GlassRadius, number> = {
  lg: radii.md,
  xl: radii.lg,
  '2xl': radii.xl,
  '3xl': radii['3xl'],
};

/**
 * Superfície de vidro. Quando há BlurView por baixo, o preenchimento fica mais
 * fraco (`overBlur`) — senão o blur soma com o fill e o vidro vira leite.
 */
export function glassSurface(
  variant: GlassVariant = 'default',
  radius: GlassRadius = '2xl',
  overBlur = false,
): ViewStyle {
  return {
    backgroundColor: overBlur ? 'rgba(255,255,255,0.02)' : FILL[variant],
    borderWidth: 1,
    borderColor: BORDER[variant],
    borderRadius: RADIUS[radius],
    boxShadow: shadows.glass,
  } as ViewStyle;
}

/**
 * Degradê do specular highlight do topo (o `.glass-spec` do web).
 *
 * Tipado como TUPLA e não array: o `colors` do LinearGradient exige no mínimo dois
 * elementos no tipo, e `string[]` não prova isso pro compilador.
 */
export const SPEC_GRADIENT: readonly [string, string, string] = [
  'rgba(255,255,255,0.14)',
  'rgba(255,255,255,0.02)',
  'transparent',
];
export const SPEC_LOCATIONS: readonly [number, number, number] = [0, 0.55, 1];

/** `StyleSheet.absoluteFillObject` sumiu dos tipos do RN 0.86 — o objeto continua útil. */
export const FILL_PARENT = { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 } as const;
