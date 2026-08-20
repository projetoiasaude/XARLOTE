/**
 * Herói da entrada — o orb da Xarlote flutuando sobre um halo aurora, com a
 * palavra XARLOTE em degradê por baixo.
 *
 * ## O mascote agora é o MESMO vídeo do web — e por que virou WebP
 *
 * O arquivo do web é um MP4 H.264, que **não tem canal alfa**: o alfa vem de um truque —
 * cor na metade de cima, máscara na de baixo — que o site recompõe num shader WebGL a
 * cada quadro. Nada disso viaja pra cá: React Native não compõe alfa por pixel sem GL, e
 * um player de vídeo com transparência no Android costuma ignorar o canal e desenhar um
 * retângulo preto atrás — exatamente a cara de "vídeo recortado" que se quer evitar.
 *
 * Então o vídeo foi desempilhado em quadros RGBA (AVFoundation) e reempacotado em WebP
 * animado, que carrega alfa de forma nativa. Ganhos, nesta ordem:
 *
 * · **Borda perfeita** — a curva `smoothstep(0.04, 0.6)` do shader original foi copiada
 *   no conversor, então o antisserrilhado das bordas veio junto (medido: 726 pixels de
 *   alfa parcial sobrevivem à compressão).
 * · **Barato** — decodifica pelo mesmo caminho das imagens, sem instanciar player, sem
 *   superfície de vídeo, sem trilha de áudio. 10 fps e 360×480 foram escolhidos MEDINDO:
 *   15 fps custava 1,2 MB pra um ganho invisível num blob que se move devagar.
 * · **Vai pelo ar** — `expo-image` já está no binário. `expo-video` seria módulo nativo
 *   novo, e módulo nativo novo só existe depois de um build novo do app.
 *
 * O halo aurora e a flutuação continuam sendo desenhados aqui: eles integram o mascote à
 * cena. Sem o halo, ele fica colado por cima do fundo em vez de dentro dele.
 */
import { useEffect } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import Svg, { Defs, LinearGradient, RadialGradient, Rect, Stop, Text as SvgText } from 'react-native-svg';
import Animated, {
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import { Image } from 'expo-image';

const MASCOTE = require('../../../assets/images/xarlote-mascote.webp');

interface Props {
  size?: number;
  /** Mostra a palavra XARLOTE sob o orb (default true). */
  wordmark?: boolean;
  style?: StyleProp<ViewStyle>;
}

export function XarloteHero({ size = 172, wordmark = true, style }: Props) {
  const float = useSharedValue(0);
  const semMovimento = useReducedMotion();

  /**
   * A porta de saída que faltava.
   *
   * `LiquidCore` e `XarloteBackground` já consultavam `useReducedMotion`; este não — e
   * ele é montado na `lock.tsx`, a PRIMEIRA tela de toda abertura fria de quem ligou a
   * biometria. Quatro animações infinitas subindo no mesmo instante em que o
   * `authenticateAsync` dispara o prompt do sistema é o pior momento possível pra
   * disputar CPU, e é justamente o momento em que a pessoa julga se o app é rápido.
   */
  useEffect(() => {
    if (semMovimento) {
      float.value = 0;
      return;
    }
    // flutuação de 4,5s — o mesmo `floaty` do web
    float.value = withRepeat(withTiming(1, { duration: 2250, easing: Easing.inOut(Easing.ease) }), -1, true);
  }, [float, semMovimento]);

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
        {/*
          `contentFit="contain"` e a altura em 4:3 do arquivo (360×480): o recorte foi
          feito centrado no vídeo original, então desenhar centralizado reproduz a
          composição do site sem eu compensar deslocamento nenhum aqui.

          `transition={0}` porque o primeiro quadro do laço JÁ é a pose de repouso — um
          fade de entrada faria o mascote nascer apagando, o oposto de "vivo".
        */}
        <Image
          source={MASCOTE}
          style={{ width: size * 0.75, height: size }}
          contentFit="contain"
          transition={0}
          // Sem isto o `expo-image` mostra o primeiro quadro e para: a animação de um
          // WebP só roda quando o componente é avisado de que o recurso é animado.
          autoplay
          accessibilityIgnoresInvertColors
        />
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
