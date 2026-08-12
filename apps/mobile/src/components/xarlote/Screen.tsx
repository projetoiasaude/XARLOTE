/**
 * A moldura de toda tela logada: safe area no topo, respiro embaixo pro OrbNav não
 * cobrir o último item, e rolagem quando precisa.
 *
 * Existe pra que nenhuma tela precise lembrar do inset do orb — esquecer disso
 * esconde o botão final da lista, que é o tipo de bug que só aparece no aparelho de
 * alguém.
 */
import { type ReactElement, type ReactNode } from 'react';
import {
  ScrollView,
  StyleSheet,
  Text,
  View,
  type RefreshControlProps,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors } from '@/theme';

/** Altura do orb (68) + folga. Toda tela rolável termina acima dele. */
export const ORB_INSET = 104;

interface Props {
  title?: string;
  subtitle?: string;
  /** Sem rolagem — pra telas que gerenciam a própria lista (chat, por exemplo). */
  scroll?: boolean;
  /**
   * Puxar-pra-atualizar. Fica na moldura porque TODA tela de dados quer o gesto, e
   * porque o `tintColor` errado (o padrão é claro) desaparece contra o fundo escuro —
   * um spinner invisível faz o paciente puxar de novo achando que não funcionou.
   */
  refreshControl?: ReactElement<RefreshControlProps>;
  contentStyle?: StyleProp<ViewStyle>;
  children?: ReactNode;
}

export function Screen({ title, subtitle, scroll = true, refreshControl, contentStyle, children }: Props) {
  const insets = useSafeAreaInsets();

  const header = title ? (
    <View style={styles.header}>
      <Text style={styles.title}>{title}</Text>
      {subtitle && <Text style={styles.subtitle}>{subtitle}</Text>}
    </View>
  ) : null;

  if (!scroll) {
    return (
      <View style={[styles.flex, { paddingTop: insets.top + 12 }, contentStyle]}>
        {header}
        {children}
      </View>
    );
  }

  return (
    <ScrollView
      style={styles.flex}
      contentContainerStyle={[
        styles.content,
        { paddingTop: insets.top + 12, paddingBottom: insets.bottom + ORB_INSET },
        contentStyle,
      ]}
      showsVerticalScrollIndicator={false}
      {...(refreshControl ? { refreshControl } : {})}
    >
      {header}
      {children}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  content: { paddingHorizontal: 20 },
  header: { marginBottom: 20 },
  title: { color: colors.text, fontSize: 28, fontWeight: '700', letterSpacing: -0.6 },
  subtitle: { color: colors.textDim, fontSize: 13, marginTop: 4 },
});
