/**
 * A Bolha da Xarlote — a navegação radial, portada do web 1:1.
 *
 * O orb mora no canto inferior direito; tocar nele desabrocha 5 bolhas num arco de
 * 86°→190°, raio 152. Os mesmos números do web de propósito: quem usa os dois
 * precisa reconhecer o gesto, não reaprender.
 *
 * O orb também é indicador vivo — pulsa quando a Xarlote está digitando (é o
 * LiquidCore em modo `thinking`) e as 4 luas em órbita são a pista de que existe um
 * menu ali dentro.
 *
 * Fora do web: o véu escuro fecha ao toque (não há Esc), e cada toque tem haptic.
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
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { colors, radii, springs } from '@/theme';
import { LiquidCore } from './LiquidCore';

interface NavItem {
  href: '/' | '/saude' | '/lembretes' | '/atividade' | '/perfil';
  label: string;
  icon: LucideIcon;
}

const ITEMS: NavItem[] = [
  { href: '/', label: 'Conversa', icon: MessageCircle },
  { href: '/saude', label: 'Saúde', icon: HeartPulse },
  { href: '/lembretes', label: 'Lembretes', icon: AlarmClock },
  { href: '/atividade', label: 'Atividade', icon: Zap },
  { href: '/perfil', label: 'Perfil', icon: CircleUserRound },
];

const RADIUS = 152;
const BUBBLE = 52;
const ORB = 68;
const SATELLITES = ['#3b6ef5', '#7c87ff', '#9b5cf6', '#d946ef'];

/** Arco de 86° (topo) a 190° (esquerda) — folga de 52px entre bolhas, sem sobrepor. */
const angleFor = (i: number, total: number) => 86 + (i * 104) / (total - 1);

function Bubble({
  item,
  index,
  open,
  active,
  onPress,
}: {
  item: NavItem;
  index: number;
  open: boolean;
  active: boolean;
  onPress: () => void;
}) {
  const deg = angleFor(index, ITEMS.length);
  const rad = (deg * Math.PI) / 180;
  const dx = Math.cos(rad) * RADIUS;
  const dy = -Math.sin(rad) * RADIUS;
  const labelAbove = deg < 100;

  const t = useSharedValue(0);

  useEffect(() => {
    // Abrindo: 45ms de atraso por bolha, então elas desabrocham em sequência (o mesmo
    // `delay: i * 0.045` do web). Fechando: todas recolhem JUNTAS — escalonar a volta
    // faz o menu parecer que travou.
    t.value = open
      ? withDelay(index * 45, withSpring(1, springs.orb))
      : withSpring(0, springs.orb);
  }, [open, t, index]);

  const style = useAnimatedStyle(() => ({
    opacity: t.value,
    transform: [{ translateX: dx * t.value }, { translateY: dy * t.value }, { scale: 0.2 + 0.8 * t.value }],
  }));

  const Icon = item.icon;

  return (
    <Animated.View pointerEvents={open ? 'auto' : 'none'} style={[styles.bubbleAnchor, style]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={item.label}
        onPress={onPress}
        style={[styles.bubble, active ? styles.bubbleActive : styles.bubbleIdle]}
      >
        <Icon size={20} color={active ? '#ffffff' : 'rgba(255,255,255,0.85)'} />
      </Pressable>
      {/*
        DOIS Views de propósito: o de fora só POSICIONA (transparente, mais largo que a
        bolha), o de dentro é a pílula com fundo, que encolhe pro tamanho do texto.
        Com um View só, o Yoga limitava a largura disponível à da bolha (48px) e o
        `numberOfLines={1}` cortava tudo: no aparelho os rótulos apareciam como "Co…",
        "Sa…", "Le…", "Ati…" — e só "Perfil" cabia inteiro.
      */}
      <View
        pointerEvents="none"
        style={[styles.labelSlot, labelAbove ? styles.labelSlotAbove : styles.labelSlotLeft]}
      >
        <View style={styles.label}>
          <Text style={[styles.labelText, active && { color: colors.accentHi }]} numberOfLines={1}>
            {item.label}
          </Text>
        </View>
      </View>
    </Animated.View>
  );
}

function Satellites({ visible }: { visible: boolean }) {
  const spin = useSharedValue(0);
  useEffect(() => {
    spin.value = withRepeat(withTiming(360, { duration: 14_000, easing: Easing.linear }), -1, false);
  }, [spin]);

  const style = useAnimatedStyle(() => ({
    opacity: withTiming(visible ? 1 : 0, { duration: 220 }),
    transform: [{ rotate: `${spin.value}deg` }],
  }));

  return (
    <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, style]}>
      {SATELLITES.map((color, i) => (
        <View
          key={color}
          style={[
            styles.satellite,
            {
              backgroundColor: color,
              transform: [
                { translateX: -3 },
                { translateY: -3 },
                { rotate: `${(i * 360) / SATELLITES.length}deg` },
                { translateY: -31 },
              ],
            },
          ]}
        />
      ))}
    </Animated.View>
  );
}

interface Props {
  /** A Xarlote está digitando? O orb entra em modo `thinking`. */
  typing?: boolean;
}

export function OrbNav({ typing = false }: Props) {
  const pathname = usePathname();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [open, setOpen] = useState(false);

  // Fecha ao trocar de rota por qualquer via (back do Android, deep link, push).
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  const toggle = useCallback(() => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setOpen((v) => !v);
  }, []);

  const go = useCallback(
    (href: NavItem['href']) => {
      void Haptics.selectionAsync();
      setOpen(false);
      if (href !== pathname) router.push(href);
    },
    [pathname, router],
  );

  const veil = useAnimatedStyle(() => ({ opacity: withTiming(open ? 1 : 0, { duration: 220 }) }));
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
          <Bubble
            key={item.href}
            item={item}
            index={i}
            open={open}
            active={pathname === item.href}
            onPress={() => go(item.href)}
          />
        ))}

        <Pressable
          accessibilityRole="button"
          accessibilityLabel={open ? 'Fechar navegação' : 'Abrir navegação'}
          accessibilityState={{ expanded: open }}
          onPress={toggle}
          style={styles.orb}
        >
          <LiquidCore size={52} mode={typing ? 'thinking' : open ? 'active' : 'idle'} />
          <Satellites visible={!open && !typing} />
        </Pressable>
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  veil: { backgroundColor: 'rgba(4,4,26,0.55)', zIndex: 40 },
  nav: { position: 'absolute', right: 20, zIndex: 50, width: ORB, height: ORB },
  bubbleAnchor: {
    position: 'absolute',
    left: (ORB - BUBBLE) / 2,
    top: (ORB - BUBBLE) / 2,
    width: BUBBLE,
    height: BUBBLE,
  },
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
  labelText: { color: 'rgba(255,255,255,0.85)', fontSize: 11, fontWeight: '600' },
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
  satellite: {
    position: 'absolute',
    left: '50%',
    top: '50%',
    width: 6,
    height: 6,
    borderRadius: 3,
  },
});
