/**
 * StatusPing — a bolinha de status. O anel expansivo do web (`animate-pulse-ring`,
 * scale 1→2.4 com opacity 0.7→0) vira uma animação Reanimated em loop, que roda na
 * UI thread: continua pulsando mesmo com o JS ocupado montando uma lista.
 */
import { useEffect } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
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
  neutral: 'rgba(255,255,255,0.40)',
  accent: colors.accent,
};

interface Props {
  tone?: Tone;
  size?: 'sm' | 'md';
  pulse?: boolean;
  style?: StyleProp<ViewStyle>;
}

export function StatusPing({ tone = 'success', size = 'sm', pulse = true, style }: Props) {
  const dot = size === 'md' ? 8 : 6;
  const progress = useSharedValue(0);

  useEffect(() => {
    if (!pulse) return;
    progress.value = 0;
    progress.value = withRepeat(
      withTiming(1, { duration: 1800, easing: Easing.out(Easing.ease) }),
      -1,
      false,
    );
  }, [pulse, progress]);

  const ring = useAnimatedStyle(() => ({
    opacity: 0.7 * (1 - progress.value),
    transform: [{ scale: 1 + progress.value * 1.4 }],
  }));

  return (
    <View style={[styles.wrap, { width: dot, height: dot }, style]}>
      {pulse && (
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
