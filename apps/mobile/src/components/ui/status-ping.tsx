/**
 * StatusPing — a bolinha de status.
 *
 * ## O default foi INVERTIDO, e é a correção principal deste arquivo
 *
 * Ele nascia com `pulse = true`. Como o `ActivityCard` o instancia duas vezes por cartão
 * (um por etapa `agora` e um dentro do `GlassBadge tone="live"`) e nunca passava a prop,
 * um paciente com 4 pedidos em andamento carregava 6-8 `withRepeat(-1)` simultâneos —
 * movimento perpétuo dentro de linha de lista, exatamente o padrão que custou o dia
 * 18/08 pra remover do fundo e do OrbNav. Sobreviveu porque estava escondido num default.
 *
 * Agora `pulse` é opt-in. A bolinha PARADA continua dizendo tudo o que precisa (cor +
 * presença); o pulso é reforço, não informação — e reforço não se paga a cada quadro,
 * pra sempre, no aparelho de quem tem mais coisa acontecendo.
 *
 * E quem pedir pulso agora respeita `useReducedMotion`: a regra existia no projeto
 * (`LiquidCore` e `XarloteBackground` já consultavam) e estes primitivos não seguiam.
 */
import { useEffect } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import { colors } from '@/theme';

type Tone = 'success' | 'warn' | 'danger' | 'neutral' | 'accent';

const TONE: Record<Tone, string> = {
  success: colors.success,
  warn: colors.warn,
  danger: colors.danger,
  neutral: colors.textFaint,
  accent: colors.accent,
};

interface Props {
  tone?: Tone;
  size?: 'sm' | 'md';
  /**
   * Anel pulsante. **Opt-in**, e só para estado TRANSIENTE de verdade (gravando agora).
   * Estado que dura horas — "pedido em andamento" — não é transiente: é cor parada.
   */
  pulse?: boolean;
  style?: StyleProp<ViewStyle>;
}

export function StatusPing({ tone = 'success', size = 'sm', pulse = false, style }: Props) {
  const dot = size === 'md' ? 8 : 6;
  const progress = useSharedValue(0);
  const semMovimento = useReducedMotion();
  const animando = pulse && !semMovimento;

  useEffect(() => {
    if (!animando) {
      progress.value = 0;
      return;
    }
    progress.value = 0;
    progress.value = withRepeat(
      withTiming(1, { duration: 1800, easing: Easing.out(Easing.ease) }),
      -1,
      false,
    );
  }, [animando, progress]);

  const ring = useAnimatedStyle(() => ({
    opacity: 0.7 * (1 - progress.value),
    transform: [{ scale: 1 + progress.value * 1.4 }],
  }));

  return (
    <View style={[styles.wrap, { width: dot, height: dot }, style]}>
      {animando && (
        <Animated.View
          pointerEvents="none"
          style={[
            styles.abs,
            { width: dot, height: dot, borderRadius: dot / 2, backgroundColor: TONE[tone] },
            ring,
          ]}
        />
      )}
      <View style={{ width: dot, height: dot, borderRadius: dot / 2, backgroundColor: TONE[tone] }} />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: 'center', justifyContent: 'center' },
  abs: { position: 'absolute' },
});
