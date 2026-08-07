/**
 * Skeleton com shimmer. O gradiente varre da esquerda pra direita em loop na UI
 * thread — que é justamente quando o JS está ocupado buscando o dado que falta.
 */
import { useEffect } from 'react';
import { StyleSheet, View, type DimensionValue, type StyleProp, type ViewStyle } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import { FILL_PARENT, radii } from '@/theme';

interface Props {
  variant?: 'card' | 'line' | 'circle';
  width?: DimensionValue;
  height?: number;
  style?: StyleProp<ViewStyle>;
}

const AnimatedGradient = Animated.createAnimatedComponent(LinearGradient);

export function Skeleton({ variant = 'line', width, height, style }: Props) {
  const shift = useSharedValue(-1);

  useEffect(() => {
    shift.value = withRepeat(withTiming(1, { duration: 1400, easing: Easing.linear }), -1, false);
  }, [shift]);

  const sweep = useAnimatedStyle(() => ({
    transform: [{ translateX: shift.value * 260 }],
  }));

  const shape: ViewStyle =
    variant === 'card'
      ? { height: height ?? 128, borderRadius: radii.xl }
      : variant === 'circle'
        ? { width: 40, height: 40, borderRadius: 20 }
        : { height: height ?? 16, borderRadius: radii.md };

  return (
    <View style={[styles.base, shape, width !== undefined && { width }, style]}>
      <AnimatedGradient
        colors={['transparent', 'rgba(255,255,255,0.08)', 'transparent']}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 0 }}
        style={[styles.sweep, sweep]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  base: {
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.05)',
    overflow: 'hidden',
  },
  sweep: { ...FILL_PARENT, width: 260 },
});
