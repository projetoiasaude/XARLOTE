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
 *
 * ## `elevated` é opt-in, e essa é a mudança que importa
 *
 * Antes, TODA superfície levava `shadows.glass`, cuja metade outset (24px de blur) vira
 * `BlurMaskFilter` por drawable no Android — cobrado a cada quadro, parado ou não. Como
 * card é linha de lista, isso era um blur de máscara por linha do prontuário.
 *
 * Agora o default é `shadows.hairline`: só o fio de luz inset, com blur 0, que o
 * caminho rápido do RN atende de graça. Contra o navy #04041a, uma sombra preta a 0.4 de
 * alfa era quase invisível de todo jeito — pagava-se caro por quase nada.
 *
 * **Divergência consciente da constituição:** ela sugere `borderTopColor` mais claro como
 * substituto grátis do specular. Não usei: borda com cor NÃO uniforme somada a
 * `borderRadius` empurra o Android pro caminho de Path no lugar do de retângulo
 * arredondado, então "grátis" ali é uma aposta. O fio de luz inset já entrega o mesmo
 * efeito e o custo dele está MEDIDO no fonte do RN (blur 0 → sem maskFilter).
 */
export function glassSurface(
  variant: GlassVariant = 'default',
  radius: GlassRadius = '2xl',
  overBlur = false,
  elevated = false,
): ViewStyle {
  return {
    backgroundColor: overBlur ? 'rgba(255,255,255,0.02)' : FILL[variant],
    borderWidth: 1,
    borderColor: BORDER[variant],
    borderRadius: RADIUS[radius],
    boxShadow: elevated ? shadows.glass : shadows.hairline,
  } as ViewStyle;
}

/**
 * Folga de toque pra chegar aos 44pt mínimos a partir de uma altura menor.
 *
 * Existe aqui e não em cada botão porque a conta é sempre a mesma e esquecê-la é
 * invisível: um alvo de 28pt continua bonito e continua errando o dedo de quem tem 60
 * anos. `hitSlop` numérico vale pros quatro lados, que é o que se quer num botão
 * pequeno (o `iconOnly` é estreito nos dois eixos).
 */
export const ALVO_MINIMO = 44;
export function folgaDeToque(lado: number): number {
  return Math.max(0, Math.ceil((ALVO_MINIMO - lado) / 2));
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
