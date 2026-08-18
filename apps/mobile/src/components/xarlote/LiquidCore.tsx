/**
 * LiquidCore — a marca viva da Xarlote: uma esfera de vidro com três blobs de luz
 * (azul/roxo/rosa) orbitando por dentro.
 *
 * Os três modos são o mesmo desenho em velocidades diferentes, como no web:
 *   idle     — respiração lenta
 *   thinking — acelera (~2.6×): é o sinal de que a Xarlote está pensando
 *   active   — órbita mais ampla, menu aberto
 *
 * Os blobs são degradês radiais de SVG (não Views borradas) pelo mesmo motivo do
 * fundo: `blur()` não existe em RN e empilhar BlurView aqui derrubaria o frame.
 */
import { useEffect } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import Svg, { Circle, Defs, RadialGradient, Stop } from 'react-native-svg';
import Animated, {
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';

export type CoreMode = 'idle' | 'thinking' | 'active';

interface BlobSpec {
  color: string;
  /** diâmetro em unidades de 48px (o `u` do web) */
  size: number;
  path: { x: [number, number]; y: [number, number]; scale: [number, number] };
  baseDurationMs: number;
}

const BLOBS: BlobSpec[] = [
  { color: '#3b6ef5', size: 34, path: { x: [-4, 14], y: [2, 16], scale: [1, 1.25] }, baseDurationMs: 7500 },
  { color: '#9b5cf6', size: 32, path: { x: [20, -2], y: [14, -2], scale: [1.15, 0.9] }, baseDurationMs: 9000 },
  { color: '#d946ef', size: 26, path: { x: [8, 22], y: [24, 6], scale: [0.95, 1.2] }, baseDurationMs: 11000 },
];

/** Multiplicador de duração: quanto MENOR, mais rápido (idêntico ao `speed` do web). */
const SPEED: Record<CoreMode, number> = { idle: 1, thinking: 0.38, active: 0.7 };
const AMPLITUDE: Record<CoreMode, number> = { idle: 1, thinking: 1, active: 1.25 };

function Blob({ spec, u, mode }: { spec: BlobSpec; u: number; mode: CoreMode }) {
  const t = useSharedValue(0);
  const size = spec.size * u;
  const amp = AMPLITUDE[mode];

  const semMovimento = useReducedMotion();

  useEffect(() => {
    t.value = 0;
    // Quem pediu ao sistema para reduzir animações não quer a bolha respirando.
    if (semMovimento) {
      t.value = 0.5;
      return;
    }
    t.value = withRepeat(
      withTiming(1, { duration: spec.baseDurationMs * SPEED[mode], easing: Easing.inOut(Easing.ease) }),
      -1,
      true,
    );
  }, [t, mode, spec.baseDurationMs, semMovimento]);

  const style = useAnimatedStyle(() => {
    const x = spec.path.x[0] + (spec.path.x[1] - spec.path.x[0]) * t.value;
    const y = spec.path.y[0] + (spec.path.y[1] - spec.path.y[0]) * t.value;
    const s = spec.path.scale[0] + (spec.path.scale[1] - spec.path.scale[0]) * t.value;
    return { transform: [{ translateX: x * u * amp }, { translateY: y * u * amp }, { scale: s }] };
  });

  const id = `blob-${spec.color.slice(1)}`;

  return (
    /*
      `renderToHardwareTextureAndroid`: o conteúdo do blob NUNCA muda — é sempre o mesmo
      círculo com o mesmo degradê. Só o transform anima. Com esta dica o Android desenha
      o SVG uma vez, guarda como textura na GPU e depois só a move e escala, em vez de
      redesenhar o vetor a cada quadro. É exatamente o caso de uso do prop.

      Ao contrário dos orbs do fundo, aqui a animação FICA: o blob tem dezenas de pixels
      de lado, não milhares, e é o elemento que dá vida à Xarlote na tela.
    */
    <Animated.View
      renderToHardwareTextureAndroid
      style={[styles.blob, { width: size, height: size }, style]}
    >
      <Svg width={size} height={size}>
        <Defs>
          <RadialGradient id={id} cx="35%" cy="35%" r="65%">
            <Stop offset="0%" stopColor={spec.color} stopOpacity={0.95} />
            <Stop offset="70%" stopColor={spec.color} stopOpacity={0} />
          </RadialGradient>
        </Defs>
        <Circle cx={size / 2} cy={size / 2} r={size / 2} fill={`url(#${id})`} />
      </Svg>
    </Animated.View>
  );
}

interface Props {
  size?: number;
  mode?: CoreMode;
  style?: StyleProp<ViewStyle>;
}

export function LiquidCore({ size = 48, mode = 'idle', style }: Props) {
  const u = size / 48;

  return (
    <View
      style={[
        styles.shell,
        { width: size, height: size, borderRadius: size / 2 },
        style,
      ]}
    >
      {BLOBS.map((spec) => (
        <Blob key={spec.color} spec={spec} u={u} mode={mode} />
      ))}

      {/* specular do vidro — a faixa clara inclinada no alto à esquerda */}
      <View
        pointerEvents="none"
        style={{
          position: 'absolute',
          left: size * 0.14,
          top: size * 0.06,
          width: size * 0.56,
          height: size * 0.38,
          borderRadius: size * 0.28,
          backgroundColor: 'rgba(255,255,255,0.28)',
          transform: [{ rotate: '-12deg' }],
        }}
      />
      {/* micro-brilho pontual */}
      <View
        pointerEvents="none"
        style={{
          position: 'absolute',
          left: size * 0.22,
          top: size * 0.14,
          width: 4 * u,
          height: 4 * u,
          borderRadius: 2 * u,
          backgroundColor: 'rgba(255,255,255,0.9)',
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  shell: {
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.25)',
    backgroundColor: 'rgba(255,255,255,0.07)',
  },
  blob: { position: 'absolute', left: 0, top: 0 },
});
