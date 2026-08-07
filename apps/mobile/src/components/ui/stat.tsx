/** Stat — número grande + rótulo. Pro hero da Saúde 360 e do Perfil. */
import { type ReactNode } from 'react';
import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { colors } from '@/theme';
import { GlassCard } from './glass-card';

type Trend = 'up' | 'down' | 'neutral';

const TREND_COLOR: Record<Trend, string> = {
  up: '#86efac',
  down: '#fda4af',
  neutral: colors.textFaint,
};

interface Props {
  label: ReactNode;
  value: ReactNode;
  hint?: ReactNode;
  trend?: Trend;
  icon?: ReactNode;
  style?: StyleProp<ViewStyle>;
}

export function Stat({ label, value, hint, trend, icon, style }: Props) {
  return (
    <GlassCard style={[styles.card, style]}>
      <View style={styles.labelRow}>
        {icon}
        {typeof label === 'string' ? <Text style={styles.label}>{label.toUpperCase()}</Text> : label}
      </View>
      {typeof value === 'string' || typeof value === 'number' ? (
        <Text style={styles.value}>{value}</Text>
      ) : (
        value
      )}
      {typeof hint === 'string' ? (
        <Text style={[styles.hint, { color: trend ? TREND_COLOR[trend] : colors.textFaint }]}>{hint}</Text>
      ) : (
        hint
      )}
    </GlassCard>
  );
}

const styles = StyleSheet.create({
  card: { paddingHorizontal: 16, paddingVertical: 12, minWidth: 120 },
  labelRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  label: { color: 'rgba(255,255,255,0.45)', fontSize: 11, fontWeight: '600', letterSpacing: 0.8 },
  value: { color: colors.text, fontSize: 24, fontWeight: '600', letterSpacing: -0.5, marginTop: 4 },
  hint: { fontSize: 11, marginTop: 2 },
});
