/**
 * O fundo ambiente da Xarlote — navy profundo com 3 orbs aurora em deriva lenta.
 *
 * No web são 3 keyframes CSS de 32s/48s/40s. Aqui a deriva é Reanimated na UI
 * thread: o fundo não pode engasgar quando o JS está montando o chat.
 *
 * Cada orb é um `RadialGradient` de SVG, não uma View borrada — `filter: blur(60px)`
 * não existe em RN, e empilhar blur de novo custa GPU sem parar. O degradê radial
 * dá a mesma difusão de graça, num único nó de desenho.
 */
import { useEffect } from 'react';
import { StyleSheet, View, useWindowDimensions } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import Svg, { Defs, RadialGradient, Rect, Stop } from 'react-native-svg';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';

interface Orb {
  color: string;
  opacity: number;
  /** fração da menor dimensão da tela */
  sizeFactor: number;
  from: { x: number; y: number; scale: number };
  to: { x: number; y: number; scale: number };
  durationMs: number;
}

// Mesmas 3 cores, opacidades e amplitudes do XarloteBackground.tsx do web.
const ORBS: Orb[] = [
  {
    color: '#3b6ef5',
    opacity: 0.45,
    sizeFactor: 1.5,
    from: { x: -0.32, y: -0.42, scale: 1 },
    to: { x: -0.1, y: -0.26, scale: 1.15 },
    durationMs: 32_000,
  },
  {
    color: '#9b5cf6',
    opacity: 0.5,
    sizeFactor: 1.4,
    from: { x: 0.42, y: 0.05, scale: 1.1 },
    to: { x: 0.24, y: -0.12, scale: 0.95 },
    durationMs: 48_000,
  },
  {
    color: '#d946ef',
    opacity: 0.25,
    sizeFactor: 1.3,
    from: { x: -0.05, y: 0.55, scale: 0.9 },
    to: { x: 0.12, y: 0.34, scale: 1.05 },
    durationMs: 40_000,
  },
];

function OrbLayer({ orb, base }: { orb: Orb; base: number }) {
  const t = useSharedValue(0);
  const size = base * orb.sizeFactor;

  useEffect(() => {
    // `withRepeat(..., true)` = vai-e-volta, o equivalente do `0%,100% / 50%` do CSS.
    t.value = withRepeat(
      withTiming(1, { duration: orb.durationMs, easing: Easing.inOut(Easing.ease) }),
      -1,
      true,
    );
  }, [t, orb.durationMs]);

  const style = useAnimatedStyle(() => {
    const x = orb.from.x + (orb.to.x - orb.from.x) * t.value;
    const y = orb.from.y + (orb.to.y - orb.from.y) * t.value;
    const s = orb.from.scale + (orb.to.scale - orb.from.scale) * t.value;
    return {
      transform: [{ translateX: x * base }, { translateY: y * base }, { scale: s }],
    };
  });

  const id = `orb-${orb.color.slice(1)}`;

  return (
    <Animated.View pointerEvents="none" style={[styles.orb, { width: size, height: size, opacity: orb.opacity }, style]}>
      <Svg width={size} height={size}>
        <Defs>
          <RadialGradient id={id} cx="50%" cy="50%" r="50%">
            <Stop offset="0%" stopColor={orb.color} stopOpacity={0.5} />
            <Stop offset="45%" stopColor={orb.color} stopOpacity={0.16} />
            <Stop offset="72%" stopColor={orb.color} stopOpacity={0} />
          </RadialGradient>
        </Defs>
        <Rect x={0} y={0} width={size} height={size} fill={`url(#${id})`} />
      </Svg>
    </Animated.View>
  );
}

export function XarloteBackground() {
  const { width, height } = useWindowDimensions();
  const base = Math.max(width, height);

  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      {/* base navy — o mesmo gradiente vertical #04041a → #0a0830 do web */}
      <LinearGradient colors={['#04041a', '#070725', '#0a0830']} locations={[0, 0.45, 1]} style={StyleSheet.absoluteFill} />

      {ORBS.map((orb) => (
        <OrbLayer key={orb.color} orb={orb} base={base} />
      ))}

      {/* vinheta — escurece as bordas e concentra o olho no centro */}
      <Svg style={StyleSheet.absoluteFill} width={width} height={height}>
        <Defs>
          <RadialGradient id="vignette" cx="50%" cy="38%" r="75%">
            <Stop offset="55%" stopColor="#02020e" stopOpacity={0} />
            <Stop offset="100%" stopColor="#02020e" stopOpacity={0.55} />
          </RadialGradient>
        </Defs>
        <Rect x={0} y={0} width={width} height={height} fill="url(#vignette)" />
      </Svg>
    </View>
  );
}

const styles = StyleSheet.create({
  orb: { position: 'absolute', left: 0, top: 0 },
});
