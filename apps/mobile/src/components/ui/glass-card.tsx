/**
 * GlassCard / GlassPanel — o painel de vidro. Mesmo contrato de props do web
 * (`variant`/`radius`/`interactive`/`spec`), pra quem lê os dois lados não ter que
 * traduzir nada de cabeça.
 *
 * `interactive` só faz sentido com `onPress`: no web era hover (não existe aqui),
 * então virou o afundar do toque com o mesmo spring 320/26.
 */
import { type ReactNode } from 'react';
import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import {
  CAN_BLUR,
  FILL_PARENT,
  RADIUS,
  SPEC_GRADIENT,
  SPEC_LOCATIONS,
  glassSurface,
  springs,
  type GlassRadius,
  type GlassVariant,
} from '@/theme';

interface GlassCardProps {
  variant?: GlassVariant;
  radius?: GlassRadius;
  /** Afunda ao toque. Sem `onPress` não muda nada. */
  interactive?: boolean;
  /** Specular highlight no topo (padrão true, como no web). */
  spec?: boolean;
  /**
   * Blur REAL por baixo. Default false de propósito: card é o primitivo que aparece
   * dentro de lista, e blur em linha que rola é o caminho mais curto pra derrubar o
   * frame rate. Ligue só em superfície parada (ver src/theme/glass.ts).
   */
  blur?: boolean;
  onPress?: () => void;
  style?: StyleProp<ViewStyle>;
  children?: ReactNode;
}

function Spec({ radius }: { radius: GlassRadius }) {
  return (
    <LinearGradient
      colors={SPEC_GRADIENT}
      locations={SPEC_LOCATIONS}
      pointerEvents="none"
      style={[styles.spec, { borderTopLeftRadius: RADIUS[radius], borderTopRightRadius: RADIUS[radius] }]}
    />
  );
}

export function GlassCard({
  variant = 'default',
  radius = '2xl',
  interactive = false,
  spec = true,
  blur = false,
  onPress,
  style,
  children,
}: GlassCardProps) {
  const scale = useSharedValue(1);
  const animated = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));
  const useBlur = blur && CAN_BLUR;

  const body = (
    <>
      {useBlur && (
        <BlurView intensity={28} tint="dark" style={[styles.fill, { borderRadius: RADIUS[radius] }]} />
      )}
      {spec && <Spec radius={radius} />}
      {children}
    </>
  );

  const surface = [glassSurface(variant, radius, useBlur), styles.clip, style];

  if (!onPress) {
    return <View style={surface}>{body}</View>;
  }

  return (
    <Animated.View style={animated}>
      <Pressable
        onPress={onPress}
        onPressIn={() => {
          if (interactive) scale.value = withSpring(0.985, springs.card);
        }}
        onPressOut={() => {
          if (interactive) scale.value = withSpring(1, springs.card);
        }}
        style={surface}
      >
        {body}
      </Pressable>
    </Animated.View>
  );
}

interface GlassPanelProps {
  radius?: GlassRadius;
  /** Estrutural e parado → blur LIGADO por default (a regra do glass.ts). */
  blur?: boolean;
  style?: StyleProp<ViewStyle>;
  children?: ReactNode;
}

/** Variante estrutural — header, drawer, sheet. Sem animação e com blur no iOS. */
export function GlassPanel({ radius = '3xl', blur = true, style, children }: GlassPanelProps) {
  const useBlur = blur && CAN_BLUR;
  return (
    <View style={[glassSurface('default', radius, useBlur), styles.clip, style]}>
      {useBlur && (
        <BlurView intensity={40} tint="dark" style={[styles.fill, { borderRadius: RADIUS[radius] }]} />
      )}
      <Spec radius={radius} />
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  // overflow hidden: sem ele o BlurView e o degradê escapam do raio da borda
  clip: { overflow: 'hidden' },
  fill: FILL_PARENT,
  spec: { position: 'absolute', left: 0, right: 0, top: 0, height: 56 },
});
