/**
 * Stat — número grande + rótulo. Pro herói da Saúde 360 e do Perfil.
 *
 * `size="hero"` existe porque a constituição pede o número de adesão em 34-40px: ele é
 * a resposta da tela ("estou seguindo o tratamento?"), e resposta se lê de longe, sem
 * óculos de leitura. Os 24px de antes eram "um número grande num cartão"; 36 é a
 * primeira coisa que a pessoa vê.
 */
import { type ReactNode } from 'react';
import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { colors, FONTE_CLINICA, FONTE_MINIMA } from '@/theme';
import { GlassCard } from './glass-card';
import { ehTextoCru } from './text-child';

type Trend = 'up' | 'down' | 'neutral';

const TREND_COLOR: Record<Trend, string> = {
  up: '#86efac',
  down: colors.dangerSoft,
  neutral: colors.textDim,
};

interface Props {
  label: ReactNode;
  value: ReactNode;
  hint?: ReactNode;
  trend?: Trend;
  icon?: ReactNode;
  /** `hero` = o número que responde a pergunta da tela. Um por tela. */
  size?: 'md' | 'hero';
  style?: StyleProp<ViewStyle>;
}

export function Stat({ label, value, hint, trend, icon, size = 'md', style }: Props) {
  return (
    <GlassCard style={[styles.card, style]}>
      <View style={styles.labelRow}>
        {icon}
        {ehTextoCru(label) ? <Text style={styles.label}>{String(label).toUpperCase()}</Text> : label}
      </View>
      {ehTextoCru(value) ? (
        <Text style={[styles.value, size === 'hero' && styles.valueHero]}>{value}</Text>
      ) : (
        value
      )}
      {ehTextoCru(hint) ? (
        <Text style={[styles.hint, { color: trend ? TREND_COLOR[trend] : colors.textDim }]}>{hint}</Text>
      ) : (
        hint
      )}
    </GlassCard>
  );
}

const styles = StyleSheet.create({
  card: { paddingHorizontal: 16, paddingVertical: 12, minWidth: 120 },
  labelRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  // Era `rgba(255,255,255,0.45)` cru — abaixo de AA e invisível pro censo de contraste.
  label: { color: colors.textDim, fontSize: FONTE_MINIMA, fontWeight: '600', letterSpacing: 0.8 },
  value: { color: colors.text, fontSize: 24, fontWeight: '600', letterSpacing: -0.5, marginTop: 4 },
  valueHero: { fontSize: 36, letterSpacing: -1, marginTop: 2 },
  /** O hint do Stat é rótulo empático ("melhor que na semana passada") — 13px, não 11. */
  hint: { fontSize: FONTE_CLINICA, marginTop: 3, lineHeight: 18 },
});
