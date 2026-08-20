/**
 * A Bolha da Xarlote — a navegação, e a constelação que se abre.
 *
 * ## O princípio: animação é RESPOSTA, não processo de fundo
 *
 * A versão anterior tinha 4 luas girando em órbita, sem parar, em toda tela do app. Duas
 * coisas erradas ao mesmo tempo. Movimento perpétuo num app de saúde disputa atenção com
 * a única coisa que importa na tela — o prontuário da pessoa — e ainda cobra GPU a cada
 * quadro, para sempre, num aparelho que já estava engasgando (Xiaomi, 18/08/2026).
 *
 * Aqui o repouso é ABSOLUTAMENTE parado, e todo o movimento acontece no toque. O efeito
 * é o inverso do esperado: parece mais caro e custa menos.
 *
 * ## A constelação DIZ onde você está
 *
 * As luas viraram 5 pontos parados, um por destino, no mesmo arco em que as bolhas vão
 * nascer — então elas são um MAPA do menu, não enfeite. O ponto da tela em que você está
 * é maior e mais claro: a bolha passa a responder "onde estou?" sem você abrir nada, o
 * que a órbita nunca fez.
 *
 * Ao tocar, cada ponto viaja pelo seu próprio raio e desabrocha na bolha correspondente —
 * mesmo índice, mesmo ângulo, mesma cor. A constelação vira o menu. Fechar recolhe de
 * volta ao ponto. É uma transformação, não um aparecimento.
 *
 * ## Por que isto é barato
 *
 * Um único `t` por item comanda posição, escala e as duas opacidades (ponto sai, bolha
 * entra). Parado, `t` não muda — Reanimated calcula o estilo uma vez e o Android guarda a
 * camada pronta. Zero trabalho por quadro enquanto ninguém toca.
 *
 * O LiquidCore continua respirando: é pequeno, tem textura de GPU, e é a alma da coisa.
 *
 * ## Divergência consciente do web
 *
 * O menu do web é o arco de 86°→190° com raio 152, e esses números CONTINUAM aqui — o
 * gesto é o mesmo, quem usa os dois reconhece. O que mudou é o estado de repouso. O web
 * ainda tem as luas girando; quando o `/app` for aposentado no F5, a decisão morre junto.
 */
import { useCallback, useEffect, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { usePathname, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import { BlurView } from 'expo-blur';
import {
  AlarmClock,
  CircleUserRound,
  HeartPulse,
  MessageCircle,
  Zap,
  type LucideIcon,
} from 'lucide-react-native';
import Animated, {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { colors, FONTE_MINIMA, radii, springs } from '@/theme';
import { LiquidCore } from './LiquidCore';
import { useXarloteDigitando } from './typing-signal';

interface NavItem {
  href: '/' | '/saude' | '/lembretes' | '/atividade' | '/perfil';
  label: string;
  icon: LucideIcon;
  /** A cor do ponto em repouso — a mesma paleta aurora, na ordem do arco. */
  cor: string;
}

const ITEMS: NavItem[] = [
  { href: '/', label: 'Conversa', icon: MessageCircle, cor: '#3b6ef5' },
  { href: '/saude', label: 'Saúde', icon: HeartPulse, cor: '#6d7bfb' },
  { href: '/lembretes', label: 'Lembretes', icon: AlarmClock, cor: '#9b5cf6' },
  { href: '/atividade', label: 'Atividade', icon: Zap, cor: '#c04ef0' },
  { href: '/perfil', label: 'Perfil', icon: CircleUserRound, cor: '#d946ef' },
];

/** Raio das bolhas abertas — o mesmo do web, de propósito. */
const RAIO_ABERTO = 152;
/** Raio dos pontos em repouso: encostados no orb, formando uma crescente. */
const RAIO_REPOUSO = 33;
const BUBBLE = 52;
const ORB = 68;
const PONTO = 7;
const PONTO_ATIVO = 10;

/**
 * O tempo de abertura — e por que ele é curto de propósito.
 *
 * A versão anterior usava `springs.orb` (rigidez 400) com 45ms de atraso por item: a
 * última bolha só COMEÇAVA a se mover 180ms depois do toque, e a mola levava mais uns
 * 250ms pra assentar. O efeito relatado no aparelho foi exato: "ela só clica assim que
 * finaliza a animação". E é literal — o dedo acerta onde a bolha VAI estar, mas ela ainda
 * está a caminho, a 30% do tamanho, perto do orb.
 *
 * Alvo de toque é posição, e posição é a animação. Enquanto ela roda, o botão não está
 * onde a pessoa mira. Não dá pra "adiantar o toque" sem duplicar a área tocável num lugar
 * invisível — o que quebraria o toque no véu atrás. O que dá é fazer a viagem ser tão
 * curta que ninguém espera: com estes números a última bolha está no lugar em ~200ms, que
 * é a fronteira do que se percebe como instantâneo.
 *
 * A animação continua — ela é o que explica que a constelação virou menu. Só deixou de
 * cobrar pedágio.
 */
const MOLA_ABRIR = { stiffness: 560, damping: 34 } as const;
const ATRASO_POR_ITEM = 16;

/** Arco de 86° (topo) a 190° (esquerda) — folga de 52px entre bolhas, sem sobrepor. */
const angleFor = (i: number, total: number) => 86 + (i * 104) / (total - 1);

function Destino({
  item,
  index,
  open,
  active,
  instantaneo,
  onPress,
}: {
  item: NavItem;
  index: number;
  open: boolean;
  active: boolean;
  instantaneo: boolean;
  onPress: () => void;
}) {
  const deg = angleFor(index, ITEMS.length);
  const rad = (deg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sen = -Math.sin(rad);
  const labelAbove = deg < 100;

  const t = useSharedValue(0);

  useEffect(() => {
    if (instantaneo) {
      // Quem pediu ao sistema para reduzir animações recebe o estado final, sem viagem.
      t.value = open ? 1 : 0;
      return;
    }
    // Abrindo: 45ms de atraso por item, então a constelação se abre em sequência (o mesmo
    // `delay: i * 0.045` do web). Fechando: todos recolhem JUNTOS — escalonar a volta faz
    // o menu parecer que travou.
    t.value = open
      ? withDelay(index * ATRASO_POR_ITEM, withSpring(1, MOLA_ABRIR))
      : withSpring(0, MOLA_ABRIR);
  }, [open, t, index, instantaneo]);

  /**
   * UM transform comanda os dois estados. O raio interpola de 33 (ponto encostado) a 152
   * (bolha aberta), então o ponto não "some e a bolha aparece" — ele VIAJA e vira bolha.
   */
  const trilho = useAnimatedStyle(() => {
    const raio = RAIO_REPOUSO + (RAIO_ABERTO - RAIO_REPOUSO) * t.value;
    return { transform: [{ translateX: cos * raio }, { translateY: sen * raio }] };
  });

  // O ponto sai cedo (× 2.6): ele some no primeiro terço da viagem, quando a bolha já
  // tem tamanho suficiente pra assumir. Sem isso os dois aparecem sobrepostos no meio.
  const estiloPonto = useAnimatedStyle(() => ({
    opacity: 1 - Math.min(1, t.value * 2.6),
  }));

  const estiloBolha = useAnimatedStyle(() => ({
    opacity: Math.max(0, t.value * 1.4 - 0.4),
    // Nasce em 55% e não em 30%: a bolha vira alvo utilizável mais cedo no caminho,
    // e o crescimento continua visível o suficiente pra leitura do gesto.
    transform: [{ scale: 0.55 + 0.45 * t.value }],
  }));

  const estiloRotulo = useAnimatedStyle(() => ({ opacity: t.value }));

  const Icon = item.icon;
  const tamanhoPonto = active ? PONTO_ATIVO : PONTO;

  return (
    <Animated.View pointerEvents={open ? 'auto' : 'none'} style={[styles.ancora, trilho]}>
      {/* O ponto em repouso — o mapa do menu, e o "você está aqui". */}
      <Animated.View
        pointerEvents="none"
        style={[
          styles.ponto,
          {
            width: tamanhoPonto,
            height: tamanhoPonto,
            borderRadius: tamanhoPonto / 2,
            marginLeft: -tamanhoPonto / 2,
            marginTop: -tamanhoPonto / 2,
            backgroundColor: item.cor,
            opacity: active ? 1 : 0.7,
          },
          active && styles.pontoAtivo,
          estiloPonto,
        ]}
      />

      <Animated.View style={estiloBolha}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={item.label}
          accessibilityState={{ selected: active }}
          onPress={onPress}
          style={[styles.bubble, active ? styles.bubbleActive : styles.bubbleIdle]}
        >
          <Icon size={20} color={active ? '#ffffff' : 'rgba(255,255,255,0.85)'} />
        </Pressable>
      </Animated.View>

      {/*
        DOIS Views de propósito: o de fora só POSICIONA (transparente, mais largo que a
        bolha), o de dentro é a pílula com fundo, que encolhe pro tamanho do texto.
        Com um View só, o Yoga limitava a largura disponível à da bolha (48px) e o
        `numberOfLines={1}` cortava tudo: no aparelho os rótulos apareciam como "Co…",
        "Sa…", "Le…", "Ati…" — e só "Perfil" cabia inteiro.
      */}
      <Animated.View
        pointerEvents="none"
        style={[styles.labelSlot, labelAbove ? styles.labelSlotAbove : styles.labelSlotLeft, estiloRotulo]}
      >
        <View style={styles.label}>
          <Text style={[styles.labelText, active && { color: colors.accentHi }]} numberOfLines={1}>
            {item.label}
          </Text>
        </View>
      </Animated.View>
    </Animated.View>
  );
}

interface Props {
  /**
   * A Xarlote está digitando? O orb entra em modo `thinking`.
   *
   * Quando não vem por prop, o orb LÊ o sinal (`typing-signal.ts`). O `_layout` monta o
   * orb fora do Stack e não tem acesso ao estado do chat; o sinal é a ponte. A prop
   * continua existindo pra quem quiser forçar (teste, storybook).
   */
  typing?: boolean;
}

export function OrbNav({ typing }: Props) {
  const sinal = useXarloteDigitando();
  const pensando = typing ?? sinal;
  const pathname = usePathname();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [open, setOpen] = useState(false);
  const instantaneo = useReducedMotion();

  // Fecha ao trocar de rota por qualquer via (back do Android, deep link, push).
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  /**
   * `abertura` guia o véu e o afundar do orb.
   *
   * A versão anterior chamava `withTiming` DENTRO do `useAnimatedStyle`, o que recria a
   * animação a cada avaliação do estilo. Funciona por acidente; aqui o valor é dirigido
   * de fora, uma vez por mudança de estado, que é o contrato que o Reanimated espera.
   */
  const abertura = useSharedValue(0);
  useEffect(() => {
    abertura.value = instantaneo
      ? (open ? 1 : 0)
      : withTiming(open ? 1 : 0, { duration: 220 });
  }, [open, abertura, instantaneo]);

  const pressao = useSharedValue(1);

  const toggle = useCallback(() => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setOpen((v) => !v);
  }, []);

  /**
   * `navigate` e NUNCA `push` — as cinco telas do orb são IRMÃS, não um caminho.
   *
   * `(main)/_layout.tsx` é um `Stack`. Com `push`, ir Conversa → Saúde → Conversa deixa
   * DOIS chats montados, e o custo não é teórico: cada instância monta `useChat` →
   * `useAppStream`, e `lib/stream.ts` abre um `EventSource` PRÓPRIO por hook. Seis idas e
   * vindas pelo orb = quatro conexões SSE do mesmo paciente contra a API, quatro cópias
   * da lista de mensagens na memória de um Android intermediário, e o botão voltar
   * precisando de doze toques pra sair do app.
   *
   * Pior que o custo: `publicarXarloteDigitando` é estado de MÓDULO. A instância velha do
   * chat, ao desmontar, publica `false` e apaga o "pensando" de um turno que ainda está em
   * voo na instância nova.
   *
   * `navigate` volta pra instância que já está na pilha em vez de empilhar outra.
   */
  const go = useCallback(
    (href: NavItem['href']) => {
      void Haptics.selectionAsync();
      setOpen(false);
      if (href !== pathname) router.navigate(href);
    },
    [pathname, router],
  );

  const veil = useAnimatedStyle(() => ({ opacity: abertura.value }));
  // O orb afunda no toque e cresce um fio quando o menu abre: o dedo sente que apertou
  // algo físico, e o orb aberto vira o centro de gravidade da constelação.
  const estiloOrb = useAnimatedStyle(() => ({
    transform: [{ scale: pressao.value * (1 + 0.06 * abertura.value) }],
  }));

  const onChat = pathname === '/';

  return (
    <>
      {/* Véu: escurece e desfoca a tela atrás do menu. pointerEvents desligado quando
          fechado — senão o véu invisível engoliria os toques da tela inteira. */}
      <Animated.View
        pointerEvents={open ? 'auto' : 'none'}
        style={[StyleSheet.absoluteFill, styles.veil, veil]}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Fechar navegação"
          onPress={() => setOpen(false)}
          style={StyleSheet.absoluteFill}
        >
          {Platform.OS === 'ios' && <BlurView intensity={22} tint="dark" style={StyleSheet.absoluteFill} />}
        </Pressable>
      </Animated.View>

      <View
        pointerEvents="box-none"
        style={[styles.nav, { bottom: insets.bottom + (onChat ? 88 : 24) }]}
      >
        {ITEMS.map((item, i) => (
          <Destino
            key={item.href}
            item={item}
            index={i}
            open={open}
            active={pathname === item.href}
            instantaneo={instantaneo}
            onPress={() => go(item.href)}
          />
        ))}

        <Animated.View style={estiloOrb}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={open ? 'Fechar navegação' : 'Abrir navegação'}
            accessibilityState={{ expanded: open }}
            onPress={toggle}
            onPressIn={() => {
              pressao.value = instantaneo ? 1 : withSpring(0.92, springs.orb);
            }}
            onPressOut={() => {
              pressao.value = withSpring(1, springs.orb);
            }}
            style={styles.orb}
          >
            <LiquidCore size={52} mode={pensando ? 'thinking' : open ? 'active' : 'idle'} />
          </Pressable>
        </Animated.View>
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  veil: { backgroundColor: 'rgba(4,4,26,0.55)', zIndex: 40 },
  nav: { position: 'absolute', right: 20, zIndex: 50, width: ORB, height: ORB },
  /** Ancorada no CENTRO do orb: é de lá que os pontos saem e para lá que voltam. */
  ancora: {
    position: 'absolute',
    left: (ORB - BUBBLE) / 2,
    top: (ORB - BUBBLE) / 2,
    width: BUBBLE,
    height: BUBBLE,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ponto: { position: 'absolute', left: '50%', top: '50%' },
  /**
   * Sem `boxShadow` aqui.
   *
   * Era `0 0 10px 0 rgba(255,255,255,0.55)` — pela mesma mecânica das sombras do vidro,
   * um `BlurMaskFilter` vivo PERMANENTEMENTE em toda tela logada, porque sempre há um
   * destino ativo. Era o único blur de máscara do app que nunca desligava.
   *
   * E era redundante: o ponto ativo já é maior (10 contra 7) e opaco (1 contra 0.7) que
   * os irmãos. O "você está aqui" estava dito duas vezes e só uma delas custava.
   */
  pontoAtivo: { borderWidth: 2, borderColor: 'rgba(255,255,255,0.85)' },
  bubble: {
    width: BUBBLE,
    height: BUBBLE,
    borderRadius: BUBBLE / 2,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
  },
  bubbleIdle: { backgroundColor: 'rgba(255,255,255,0.10)', borderColor: colors.glassBorderHi },
  bubbleActive: {
    backgroundColor: 'rgba(124,135,255,0.85)',
    borderColor: 'rgba(124,135,255,0.6)',
    boxShadow: '0 0 24px -6px rgba(124,135,255,0.7)',
  } as never,
  /** Só posiciona. Sem fundo, e largo o suficiente pro rótulo mais longo caber. */
  labelSlot: { position: 'absolute', width: 120 },
  labelSlotAbove: { bottom: BUBBLE + 6, left: (BUBBLE - 120) / 2, alignItems: 'center' },
  labelSlotLeft: { right: BUBBLE + 8, top: BUBBLE / 2 - 13, alignItems: 'flex-end' },
  label: {
    backgroundColor: 'rgba(10,10,36,0.95)',
    borderWidth: 1,
    borderColor: colors.glassBorder,
    borderRadius: radii.full,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  /**
   * `FONTE_MINIMA`, e não 11.
   *
   * Este é o rótulo da ÚNICA navegação do app — o texto que decide se a paciente de 55
   * anos acha a tela que quer. Piso de 12 vale ainda mais aqui do que em metadado
   * descartável. "Lembretes" (o mais longo) cabe folgado nos 120 do `labelSlot`.
   */
  labelText: { color: 'rgba(255,255,255,0.85)', fontSize: FONTE_MINIMA, fontWeight: '600' },
  orb: {
    width: ORB,
    height: ORB,
    borderRadius: ORB / 2,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.20)',
    backgroundColor: 'rgba(255,255,255,0.10)',
  },
});
