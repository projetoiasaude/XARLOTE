/**
 * EmptyState — o estado vazio.
 *
 * Regra de ouro do projeto: **estado vazio precisa FALAR**. Por isso `title` é
 * obrigatório e `hint` existe pra dizer o que fazer — vazio mudo já custou caro
 * (o paciente achava que o app tinha quebrado).
 */
import { type ReactNode } from 'react';
import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { colors, radii } from '@/theme';

interface Props {
  icon?: ReactNode;
  title: ReactNode;
  hint?: ReactNode;
  action?: ReactNode;
  style?: StyleProp<ViewStyle>;
}

export function EmptyState({ icon, title, hint, action, style }: Props) {
  return (
    <View style={[styles.wrap, style]}>
      {icon && <View style={styles.iconBox}>{icon}</View>}
      {typeof title === 'string' ? <Text style={styles.title}>{title}</Text> : title}
      {typeof hint === 'string' ? <Text style={styles.hint}>{hint}</Text> : hint}
      {action && <View style={styles.action}>{action}</View>}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: 'center', justifyContent: 'center', paddingVertical: 40, paddingHorizontal: 24 },
  iconBox: {
    width: 56,
    height: 56,
    borderRadius: radii.xl,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.glassFill,
    borderWidth: 1,
    borderColor: colors.glassBorder,
    marginBottom: 12,
  },
  title: { color: 'rgba(255,255,255,0.80)', fontSize: 14, fontWeight: '600', textAlign: 'center' },
  hint: { color: colors.textFaint, fontSize: 12, textAlign: 'center', marginTop: 4, lineHeight: 18 },
  action: { marginTop: 16 },
});
