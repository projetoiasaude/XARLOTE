/**
 * GlassCard / GlassPanel — o painel de vidro. Mesmo contrato de props do web
 * (`variant`/`radius`/`interactive`/`spec`), pra quem lê os dois lados não ter que
 * traduzir nada de cabeça.
 *
 * ## Os três ornamentos são opt-in AGORA, e não por gosto
 *
 * `blur`, `spec` e `elevated` são as três camadas caras do vidro, e todas as três
 * custam **por linha de lista**:
 *
 * · `blur` — `BlurView` real; já era opt-in (e só no iOS).
 * · `spec` — `<LinearGradient>` de 3 paradas: um view NATIVO absoluto por card. Vinte
 *   cards na Saúde 360 eram vinte views de degradê que ninguém pediu.
 * · `elevated` — a sombra outset, que no Android é `BlurMaskFilter` por drawable
 *   (ver o cabeçalho de theme/tokens.ts).
 *
 * O default dos três virou `false` no `GlassCard` e ficou `true` no `GlassPanel`. A
 * regra em uma frase: **card é linha, painel é estrutura**. Linha é o que se repete
 * dezenas de vezes; estrutura aparece uma vez por tela. Quem quiser furar a regra
 * escreve a prop — e aí é escolha, não descuido.
 *
 * O fio de luz no topo continua lá em todos: ele vem do `boxShadow` inset com blur 0,
 * que é de graça, então a perda visual do `spec` desligado é pequena.
 *
 * ## `interactive` e o háptico vêm juntos, por default
 *
 * Toda linha tocável tem que afundar e vibrar — é o único retorno que o dedo recebe num
 * app sem hover. Deixar isso na mão do chamador significava que metade das linhas
 * tocáveis do app não respondia ao toque. Agora `onPress` já implica os dois.
 */
import { type ReactNode } from 'react';
import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import * as Haptics from 'expo-haptics';
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
  /** Afunda ao toque + háptico leve. Ligado por default; sem `onPress` não faz nada. */
  interactive?: boolean;
  /**
   * Specular highlight no topo — um `<LinearGradient>` nativo por card.
   * Default FALSE: card é linha de lista. Use no painel estrutural.
   */
  spec?: boolean;
  /**
   * Sombra projetada. Default FALSE porque no Android ela é um blur de máscara por
   * drawable, cobrado a cada quadro mesmo com o dedo parado.
   */
  elevated?: boolean;
  /**
   * Blur REAL por baixo. Default false de propósito: card é o primitivo que aparece
   * dentro de lista, e blur em linha que rola é o caminho mais curto pra derrubar o
   * frame rate. Ligue só em superfície parada (ver src/theme/glass.ts).
   */
  blur?: boolean;
  onPress?: () => void;
  accessibilityLabel?: string;
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
  interactive = true,
  spec = false,
  elevated = false,
  blur = false,
  onPress,
  accessibilityLabel,
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

  const surface = [glassSurface(variant, radius, useBlur, elevated), styles.clip, style];

  if (!onPress) {
    return <View style={surface}>{body}</View>;
  }

  return (
    <Animated.View style={animated}>
      <Pressable
        accessibilityRole="button"
        {...(accessibilityLabel ? { accessibilityLabel } : {})}
        onPress={() => {
          void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
          onPress();
        }}
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
  /** Specular e sombra também: painel aparece uma vez por tela, não uma vez por linha. */
  spec?: boolean;
  elevated?: boolean;
  style?: StyleProp<ViewStyle>;
  children?: ReactNode;
}

/** Variante estrutural — header, drawer, sheet. Sem animação e com blur no iOS. */
export function GlassPanel({
  radius = '3xl',
  blur = true,
  spec = true,
  elevated = true,
  style,
  children,
}: GlassPanelProps) {
  const useBlur = blur && CAN_BLUR;
  return (
    <View style={[glassSurface('default', radius, useBlur, elevated), styles.clip, style]}>
      {useBlur && (
        <BlurView intensity={40} tint="dark" style={[styles.fill, { borderRadius: RADIUS[radius] }]} />
      )}
      {spec && <Spec radius={radius} />}
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
