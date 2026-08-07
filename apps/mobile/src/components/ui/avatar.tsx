/**
 * Avatar — inicial sobre gradiente escolhido pelo HASH DO NOME.
 *
 * O hash é o mesmo do web (bit a bit, incluindo o `h |= 0` que força int32): a mesma
 * pessoa tem que ter a mesma cor nos dois clientes, senão o paciente estranha.
 */
import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';

const GRADIENTS: readonly [string, string][] = [
  ['#3b6ef5', '#9b5cf6'],
  ['#9b5cf6', '#d946ef'],
  ['#3b6ef5', '#22d3ee'],
  ['#4ade80', '#3b6ef5'],
  ['#fbbf24', '#fb7185'],
  ['#fb7185', '#9b5cf6'],
  ['#22d3ee', '#3b6ef5'],
  ['#e879f9', '#9b5cf6'],
];

/** Idêntico ao hashName do web — não "melhorar" ou a cor de cada paciente muda. */
function hashName(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) {
    h = (h << 5) - h + name.charCodeAt(i);
    h |= 0;
  }
  return Math.abs(h);
}

type Size = 'sm' | 'md' | 'lg' | 'xl';

const SIZE: Record<Size, { box: number; font: number }> = {
  sm: { box: 32, font: 12 },
  md: { box: 40, font: 14 },
  lg: { box: 56, font: 18 },
  xl: { box: 80, font: 24 },
};

interface Props {
  name?: string | null;
  initial?: string;
  size?: Size;
  style?: StyleProp<ViewStyle>;
}

export function Avatar({ name, initial, size = 'md', style }: Props) {
  const display = (initial ?? name?.[0] ?? '?').toUpperCase();
  const { box, font } = SIZE[size];
  const gradient = GRADIENTS[hashName(name ?? display) % GRADIENTS.length]!;

  return (
    <LinearGradient
      colors={gradient}
      start={{ x: 0, y: 0 }}
      end={{ x: 1, y: 1 }}
      style={[styles.wrap, { width: box, height: box, borderRadius: box / 2 }, style]}
    >
      <Text style={[styles.letter, { fontSize: font }]}>{display}</Text>
      {/* sheen — a mesma faixa clara do topo que o web desenha por cima */}
      <View pointerEvents="none" style={[styles.sheen, { height: box * 0.4, borderRadius: box / 2 }]} />
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  letter: { color: '#ffffff', fontWeight: '700' },
  sheen: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    backgroundColor: 'rgba(255,255,255,0.18)',
  },
});
