/**
 * EmptyState — o estado vazio.
 *
 * Regra de ouro do projeto: **estado vazio precisa FALAR**. Por isso `title` é
 * obrigatório e `hint` existe pra dizer o que fazer — vazio mudo já custou caro
 * (o paciente achava que o app tinha quebrado).
 */
import { type ReactNode } from 'react';
import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { colors, radii, FONTE_CLINICA } from '@/theme';
import { ehTextoCru } from './text-child';

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
      {ehTextoCru(title) ? <Text style={styles.title}>{title}</Text> : title}
      {ehTextoCru(hint) ? <Text style={styles.hint}>{hint}</Text> : hint}
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
  // Cor de token, nunca `rgba(255,255,255,…)` solto: o dia em que a hierarquia de texto
  // do app subir de contraste, este título tem que subir junto sem ninguém procurar por ele.
  title: { color: colors.text, fontSize: 15, fontWeight: '600', textAlign: 'center' },
  // O hint é a ÚNICA instrução que a pessoa tem no estado vazio — 13px, não 12.
  hint: { color: colors.textDim, fontSize: FONTE_CLINICA, textAlign: 'center', marginTop: 6, lineHeight: 19 },
  action: { marginTop: 16 },
});
