/**
 * GlassButton — mesmas 5 variantes e 4 tamanhos do web, mesmo spring de tap (420/22).
 *
 * Diferenças que o toque impõe:
 *  · sem hover: o feedback é o afundar + haptic leve (o web não tem nada equivalente);
 *  · `loading` existe aqui porque no celular a rede é pior e um botão que não responde
 *    parece app travado — no web o chamador controlava isso à mão em cada tela.
 */
import { type ReactNode } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import * as Haptics from 'expo-haptics';
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import { colors, folgaDeToque, radii, shadows, springs } from '@/theme';
import { ehTextoCru } from './text-child';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'success';
type Size = 'xs' | 'sm' | 'md' | 'lg';

interface Props {
  variant?: Variant;
  size?: Size;
  iconOnly?: boolean;
  loading?: boolean;
  disabled?: boolean;
  /** Ícone à esquerda do rótulo (elemento pronto — este pacote não casa com lucide). */
  icon?: ReactNode;
  onPress?: () => void;
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
  textStyle?: StyleProp<TextStyle>;
  children?: ReactNode;
}

const VARIANT: Record<Variant, ViewStyle> = {
  primary: { backgroundColor: colors.accent, borderColor: 'rgba(124,135,255,0.4)', boxShadow: shadows.glowAccent } as ViewStyle,
  secondary: { backgroundColor: colors.glassFillHi, borderColor: colors.glassBorderHi },
  ghost: { backgroundColor: 'transparent', borderColor: 'transparent' },
  danger: { backgroundColor: 'rgba(239,68,68,0.85)', borderColor: 'rgba(239,68,68,0.5)' },
  success: { backgroundColor: 'rgba(16,185,129,0.85)', borderColor: 'rgba(16,185,129,0.5)' },
};

const VARIANT_TEXT: Record<Variant, TextStyle> = {
  primary: { color: '#ffffff' },
  secondary: { color: colors.text },
  ghost: { color: colors.textDim },
  danger: { color: '#ffffff' },
  success: { color: '#ffffff' },
};

const SIZE: Record<Size, ViewStyle> = {
  xs: { height: 28, paddingHorizontal: 10, borderRadius: radii.md, gap: 6 },
  sm: { height: 32, paddingHorizontal: 12, borderRadius: radii.md, gap: 6 },
  md: { height: 40, paddingHorizontal: 16, borderRadius: radii.lg, gap: 8 },
  lg: { height: 52, paddingHorizontal: 20, borderRadius: radii.xl, gap: 10 },
};

const SIZE_TEXT: Record<Size, TextStyle> = {
  xs: { fontSize: 12, fontWeight: '600' },
  sm: { fontSize: 12, fontWeight: '600' },
  md: { fontSize: 14, fontWeight: '600' },
  lg: { fontSize: 15, fontWeight: '600' },
};

/**
 * A folga de toque nasce DENTRO do primitivo, calculada da altura.
 *
 * Um `xs` tem 28pt de altura contra os 44pt mínimos: 16pt a menos, e o botão continua
 * bonito enquanto o dedo de quem tem 60 anos passa ao lado. Deixar isso pro chamador
 * significava um `hitSlop` esquecido por call-site — e esquecimento invisível, porque
 * nada na tela denuncia um alvo pequeno. `xs`/`sm`/`md` (28/32/40) ganham 8/6/2.
 */
const HIT_SLOP: Record<Size, number> = {
  xs: folgaDeToque(28),
  sm: folgaDeToque(32),
  md: folgaDeToque(40),
  lg: folgaDeToque(52),
};

export function GlassButton({
  variant = 'secondary',
  size = 'md',
  iconOnly = false,
  loading = false,
  disabled = false,
  icon,
  onPress,
  accessibilityLabel,
  style,
  textStyle,
  children,
}: Props) {
  const scale = useSharedValue(1);
  const animated = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));
  const inert = disabled || loading;

  return (
    <Animated.View style={animated}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        accessibilityState={{ disabled: inert, busy: loading }}
        disabled={inert}
        hitSlop={HIT_SLOP[size]}
        onPressIn={() => {
          scale.value = withSpring(0.96, springs.button);
        }}
        onPressOut={() => {
          scale.value = withSpring(1, springs.button);
        }}
        onPress={() => {
          if (inert) return;
          void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
          onPress?.();
        }}
        style={[
          styles.base,
          SIZE[size],
          VARIANT[variant],
          iconOnly && { width: SIZE[size].height as number, paddingHorizontal: 0 },
          inert && styles.inert,
          style,
        ]}
      >
        {loading ? (
          <ActivityIndicator size="small" color={VARIANT_TEXT[variant].color as string} />
        ) : (
          <>
            {icon && <View>{icon}</View>}
            {ehTextoCru(children) ? (
              <Text style={[SIZE_TEXT[size], VARIANT_TEXT[variant], textStyle]} numberOfLines={1}>
                {children}
              </Text>
            ) : (
              children
            )}
          </>
        )}
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  base: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
  },
  inert: { opacity: 0.4 },
});
