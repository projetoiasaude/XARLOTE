/**
 * Skeleton — o retângulo que ocupa o lugar do dado que ainda não chegou.
 *
 * ## Trocamos a varredura por um pulso de opacidade, e o motivo é o momento
 *
 * A versão anterior varria um `<LinearGradient>` animado (view NATIVO + transform por
 * quadro) em `withRepeat(-1)`. São 14 usos nas telas; o chat monta 3 juntos, a Saúde 3.
 *
 * A condição em que o skeleton aparece é exatamente a pior condição do público descrito:
 * rede móvel ruim, aparelho intermediário. É a tela que a paciente ENCARA — e ela estava
 * rodando três varreduras de degradê enquanto a thread de JS parseava a resposta que ela
 * espera. Quanto pior a rede, mais tempo esse custo fica no ar.
 *
 * Um pulso de `opacity` num `View` sólido entrega a mesma informação ("isto está
 * carregando") sem view nativo extra e sem transform: opacidade é a propriedade mais
 * barata que existe pro compositor. E consulta `useReducedMotion` — quem desligou
 * animação recebe o retângulo parado, que continua dizendo a mesma coisa.
 */
import { useEffect } from 'react';
import { StyleSheet, type DimensionValue, type StyleProp, type ViewStyle } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import { radii } from '@/theme';

interface Props {
  variant?: 'card' | 'line' | 'circle';
  width?: DimensionValue;
  height?: number;
  style?: StyleProp<ViewStyle>;
}

export function Skeleton({ variant = 'line', width, height, style }: Props) {
  const brilho = useSharedValue(1);
  const semMovimento = useReducedMotion();

  useEffect(() => {
    if (semMovimento) {
      brilho.value = 1;
      return;
    }
    brilho.value = withRepeat(
      withTiming(0.5, { duration: 800, easing: Easing.inOut(Easing.ease) }),
      -1,
      true,
    );
  }, [brilho, semMovimento]);

  // NUNCA parte de opacity 0: se o worklet não rodar, o retângulo aparece parado em vez
  // de invisível. Animação que ESCONDE conteúdo quando falha é a pior forma de falhar.
  const pulso = useAnimatedStyle(() => ({ opacity: brilho.value }));

  const shape: ViewStyle =
    variant === 'card'
      ? { height: height ?? 128, borderRadius: radii.xl }
      : variant === 'circle'
        ? { width: 40, height: 40, borderRadius: 20 }
        : { height: height ?? 16, borderRadius: radii.md };

  return (
    <Animated.View
      accessibilityRole="progressbar"
      accessibilityLabel="Carregando"
      style={[styles.base, shape, width !== undefined && { width }, style, pulso]}
    />
  );
}

const styles = StyleSheet.create({
  base: {
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.05)',
  },
});
