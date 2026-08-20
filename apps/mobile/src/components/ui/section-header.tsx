/** SectionHeader — cabeçalho de seção. `icon` é elemento pronto (não há lucide aqui). */
import { type ReactNode } from 'react';
import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { colors, FONTE_MINIMA } from '@/theme';
import { ehTextoCru } from './text-child';

interface Props {
  icon?: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  action?: ReactNode;
  size?: 'sm' | 'md' | 'lg';
  style?: StyleProp<ViewStyle>;
}

const TITLE_SIZE = { sm: 14, md: 16, lg: 20 } as const;

export function SectionHeader({ icon, title, subtitle, action, size = 'md', style }: Props) {
  return (
    <View style={[styles.row, style]}>
      <View style={styles.left}>
        {icon && <View style={styles.iconBox}>{icon}</View>}
        <View style={styles.texts}>
          {ehTextoCru(title) ? (
            <Text style={[styles.title, { fontSize: TITLE_SIZE[size] }]}>{title}</Text>
          ) : (
            title
          )}
          {ehTextoCru(subtitle) ? (
            <Text style={styles.subtitle}>{subtitle}</Text>
          ) : (
            subtitle
          )}
        </View>
      </View>
      {action}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 },
  left: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, flexShrink: 1 },
  /**
   * Sem fundo e sem borda, de propósito.
   *
   * Fill + borda + raio é a assinatura visual de "isto se toca" — é o que o GlassButton
   * e o GlassCard usam. Num CABEÇALHO DE SEÇÃO, que só informa, essa assinatura é um
   * convite falso: o dedo vai ali e nada acontece. Decore o que age, não o que informa.
   * De quebra, sai um view com borda e raio por seção da tela.
   */
  iconBox: { width: 24, alignItems: 'center', justifyContent: 'center' },
  texts: { flexShrink: 1, gap: 2 },
  title: { color: colors.text, fontWeight: '600', letterSpacing: -0.3 },
  subtitle: { color: colors.textDim, fontSize: FONTE_MINIMA, lineHeight: 17 },
});
