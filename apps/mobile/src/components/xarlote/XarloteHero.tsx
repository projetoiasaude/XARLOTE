/**
 * Herói da entrada — o orb da Xarlote flutuando sobre um halo aurora, com a
 * palavra XARLOTE em degradê por baixo.
 *
 * Por que o ORB e não o mascote: os assets do mascote hoje são (a) um SVG de 220KB
 * cheio de `feColorMatrix`, que o renderizador de SVG nativo não garante, e (b) PNGs
 * com o fundo escuro já queimado, que num fundo aurora aparecem como um quadrado.
 * O orb é vetorial, anima, e é o MESMO elemento do OrbNav — a marca fica coerente de
 * ponta a ponta. Quando existir um PNG transparente ou um Lottie do mascote, ele
 * entra aqui sem mexer em mais nada.
 */
import { useEffect } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import Svg, { Defs, LinearGradient, RadialGradient, Rect, Stop, Text as SvgText } from 'react-native-svg';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import { LiquidCore } from './LiquidCore';

interface Props {
  size?: number;
  /** Mostra a palavra XARLOTE sob o orb (default true). */
  wordmark?: boolean;
  style?: StyleProp<ViewStyle>;
}

export function XarloteHero({ size = 172, wordmark = true, style }: Props) {
  const float = useSharedValue(0);

  useEffect(() => {
    // flutuação de 4,5s — o mesmo `floaty` do web
    float.value = withRepeat(withTiming(1, { duration: 2250, easing: Easing.inOut(Easing.ease) }), -1, true);
  }, [float]);

  const drift = useAnimatedStyle(() => ({ transform: [{ translateY: -6 * float.value }] }));
  const halo = size * 1.9;

  return (
    <View style={[styles.wrap, style]}>
      {/* halo aurora — integra o orb à cena em vez de deixá-lo colado por cima */}
      <Svg width={halo} height={halo} style={[styles.halo, { width: halo, height: halo, marginLeft: -halo / 2, marginTop: -halo / 2 }]}>
        <Defs>
          <RadialGradient id="hero-halo" cx="46%" cy="38%" r="52%">
            <Stop offset="0%" stopColor="#637cfa" stopOpacity={0.5} />
            <Stop offset="55%" stopColor="#9b5cf6" stopOpacity={0.28} />
            <Stop offset="80%" stopColor="#d946ef" stopOpacity={0.12} />
            <Stop offset="100%" stopColor="#d946ef" stopOpacity={0} />
          </RadialGradient>
        </Defs>
        <Rect x={0} y={0} width={halo} height={halo} fill="url(#hero-halo)" />
      </Svg>

      <Animated.View style={drift}>
        <LiquidCore size={size} mode="idle" />
      </Animated.View>

      {wordmark && (
        <Svg width={size * 1.6} height={40} style={styles.wordmark}>
          <Defs>
            <LinearGradient id="hero-word" x1="0" y1="0" x2="1" y2="0">
              <Stop offset="0%" stopColor="#3b6ef5" />
              <Stop offset="50%" stopColor="#a3acff" />
              <Stop offset="100%" stopColor="#d946ef" />
            </LinearGradient>
          </Defs>
          <SvgText
            x="50%"
            y={26}
            textAnchor="middle"
            fontSize={22}
            fontWeight="700"
            letterSpacing={7}
            fill="url(#hero-word)"
          >
            XARLOTE
          </SvgText>
        </Svg>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: 'center', justifyContent: 'center' },
  halo: { position: 'absolute', left: '50%', top: '50%' },
  wordmark: { marginTop: 18 },
});
