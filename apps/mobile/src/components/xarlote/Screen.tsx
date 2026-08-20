/**
 * A moldura de toda tela logada: safe area no topo, respiro embaixo pro OrbNav não
 * cobrir o último item, e rolagem quando precisa.
 *
 * Existe pra que nenhuma tela precise lembrar do inset do orb — esquecer disso
 * esconde o botão final da lista, que é o tipo de bug que só aparece no aparelho de
 * alguém.
 *
 * ## `voltar` mora aqui, e não em cada subtela
 *
 * O OrbNav tem 5 destinos e as subtelas (detalhe de exame, privacidade, compartilhar)
 * não são nenhum deles: entrar nelas era um caminho de mão única, com o gesto do sistema
 * como única saída — e o gesto de voltar do Android é a primeira coisa que desaparece
 * quando alguém compra um aparelho com navegação por gestos e não descobriu o
 * deslizar-da-borda. Uma seta rotulada, com 44pt de alvo, é a diferença entre "estou
 * preso" e "estou navegando".
 */
import { type ReactElement, type ReactNode } from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type RefreshControlProps,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ChevronLeft } from 'lucide-react-native';
import { colors, FONTE_CLINICA } from '@/theme';
import Animated from 'react-native-reanimated';
import { useRecuoDoTeclado } from '@/lib/teclado';

/** Altura do orb (68) + folga. Toda tela rolável termina acima dele. */
export const ORB_INSET = 104;

interface Props {
  title?: string;
  subtitle?: string;
  /** Mostra a seta de voltar acima do título. Use em toda tela que não é destino do orb. */
  voltar?: boolean;
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

function Voltar() {
  const router = useRouter();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Voltar"
      onPress={() => router.back()}
      hitSlop={8}
      style={styles.voltar}
    >
      <ChevronLeft size={20} color={colors.textDim} />
      <Text style={styles.voltarTexto}>Voltar</Text>
    </Pressable>
  );
}

export function Screen({
  title,
  subtitle,
  voltar = false,
  scroll = true,
  refreshControl,
  contentStyle,
  children,
}: Props) {
  const insets = useSafeAreaInsets();
  // O teclado tampava o campo em toda tela com entrada de texto (novo lembrete, PIN do
  // link, nome no perfil). A moldura resolve uma vez pelas oito. Ver `lib/teclado.ts`.
  const recuoDoTeclado = useRecuoDoTeclado(insets.bottom);

  const header =
    title || voltar ? (
      <View style={styles.header}>
        {voltar && <Voltar />}
        {title ? <Text style={styles.title}>{title}</Text> : null}
        {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
      </View>
    ) : null;

  if (!scroll) {
    return (
      <Animated.View style={[styles.flex, { paddingTop: insets.top + 12 }, contentStyle, recuoDoTeclado]}>
        {header}
        {children}
      </Animated.View>
    );
  }

  return (
    /*
      A moldura animada ENCOLHE a área de rolagem quando o teclado sobe, em vez de só
      empurrar o conteúdo. É o que faz o campo focado continuar dentro da região visível:
      o ScrollView passa a enxergar uma janela menor e rola o campo pra dentro dela.
     
      Empurrar o conteúdo (padding no `contentContainerStyle`) resolveria o último campo
      da tela e não os do meio — e são justamente os do meio que a pessoa preenche em
      formulário de três campos, como o de novo lembrete.
    */
    <Animated.View style={[styles.flex, recuoDoTeclado]}>
      <ScrollView
        style={styles.flex}
        contentContainerStyle={[
          styles.content,
          { paddingTop: insets.top + 12, paddingBottom: insets.bottom + ORB_INSET },
          contentStyle,
        ]}
        showsVerticalScrollIndicator={false}
        // Sem isto, o primeiro toque num botão com o teclado aberto só FECHA o teclado —
        // a pessoa precisa tocar duas vezes em "Criar lembrete" e conclui que travou.
        keyboardShouldPersistTaps="handled"
        {...(refreshControl ? { refreshControl } : {})}
      >
        {header}
        {children}
      </ScrollView>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  content: { paddingHorizontal: 20 },
  header: { marginBottom: 20 },
  title: { color: colors.text, fontSize: 28, fontWeight: '700', letterSpacing: -0.6 },
  subtitle: { color: colors.textDim, fontSize: FONTE_CLINICA, marginTop: 4, lineHeight: 19 },
  /** 44 de altura mesmo com o texto em 15: o alvo é o piso, não o tamanho da letra. */
  voltar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    height: 44,
    marginLeft: -6,
    alignSelf: 'flex-start',
    paddingRight: 12,
  },
  voltarTexto: { color: colors.textDim, fontSize: 15, fontWeight: '500' },
});
