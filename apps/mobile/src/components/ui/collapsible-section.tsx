/**
 * CollapsibleSection — a seção que se recolhe, com CONTADOR.
 *
 * ## O defeito que este primitivo existe pra matar
 *
 * O app tinha três formas diferentes de lidar com lista longa, e as três mentem:
 *
 * 1. `{x.length > 0 && …}` — a seção SOME quando está vazia. A paciente hipertensa abre
 *    Saúde, não vê "Condições de saúde", conclui que o app não guarda isso, e nunca
 *    conta — então a seção nunca aparece, e a dica de como preenchê-la nunca aparece
 *    junto. É uma lacuna que se auto-lacra.
 * 2. `x.slice(0, 8)` mudo — doze relatos que a própria pessoa fez sobre o corpo dela
 *    existem no banco e nada na tela sugere que há mais.
 * 3. renderizar tudo — 80 cartões de memória empurram o botão "Sair da conta" pro fim de
 *    uma rolagem infinita.
 *
 * O primitivo resolve os três com a mesma peça: **o cabeçalho SEMPRE aparece e sempre
 * diz o tamanho.** "Fatos sobre você · 23" quando tem, "Meus médicos · 0" quando não tem
 * — e aí o `emptyHint` ensina como o dado entra. Nada some, nada é cortado em silêncio.
 *
 * ## Recolhido não é "escondido"
 *
 * O contador no cabeçalho é a diferença. `slice()` esconde; contador + chevron ANUNCIA e
 * oferece. É por isso que `count` não é opcional: uma seção recolhida sem número é o
 * defeito nº 2 com outra roupa.
 *
 * ## `null` não é zero
 *
 * O único jeito de omitir o contador é `count={null}`, e ele significa **"não deu pra
 * contar"** — a contagem do servidor não veio. Aí o número sai (afirmar `0` sem ter
 * contado seria dizer que o banco está vazio, que é a mentira nº 1 com outra roupa) e a
 * seção passa a se comportar como cheia: abre mostrando o que tem, não o `emptyHint`.
 *
 * ## Este é o ÚNICO
 *
 * Houve uma segunda versão deste componente em `features/reminders/SecaoRecolhivel.tsx`,
 * escrita no mesmo ciclo porque este arquivo ainda não existia. Duas aparências para a
 * mesma affordance no mesmo app é dívida: `count: number | null` e `onMudarAberta` vieram
 * de lá justamente para que não haja motivo de existir uma terceira. Não invente
 * variação própria — acrescente a prop aqui.
 *
 * ## `defaultOpen` é uma REGRA, não um instante
 *
 * A primeira versão lia `defaultOpen` uma vez só, no inicializador do `useState`. Numa
 * tela que busca dado na rede isso é um defeito garantido: "Alergias" monta com `count`
 * 0 (a consulta ainda não voltou), congela fechada, e quando a alergia chega ela
 * continua fechada PARA SEMPRE — e o `emptyHint` some junto, porque ele só existe
 * enquanto `vazia`. A linha vira "Alergias · 1" e nada embaixo. Pior ainda no caminho em
 * que a própria paciente cria o primeiro item pela tela: ela age, o contador sobe, e o
 * que ela acabou de escrever não aparece.
 *
 * Então o estado é DERIVADO enquanto ninguém tocou (`aberta = defaultOpen && !vazia`,
 * recalculado a cada dado novo) e só vira estado próprio a partir do primeiro toque —
 * porque aí a escolha é da pessoa, e dado que chega depois não tem direito de desfazê-la.
 *
 * ## Movimento
 *
 * Sem animação de altura (medir altura de conteúdo arbitrário é caro e trava). O que
 * anima é o LAYOUT dos irmãos, via `LinearTransition`, e a seta. Conteúdo entra sem
 * `opacity: 0` — se o worklet falhar, ele aparece parado, nunca invisível.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import * as Haptics from 'expo-haptics';
import { ChevronDown } from 'lucide-react-native';
import Animated, {
  LinearTransition,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { colors, radii, spacing } from '@/theme';
import { secaoAberta } from './secao-aberta';

interface Props {
  /** O que a seção guarda, em linguagem de gente: "Fatos sobre você". */
  title: string;
  /**
   * Quantos itens EXISTEM — não quantos você desenha. É o que impede corte mudo.
   *
   * `null` é o único jeito de omitir o número, e diz "não deu pra contar" (a contagem do
   * servidor falhou), nunca "zero".
   */
  count: number | null;
  /** Abre já montada? Reserve o `true` pro que responde à pergunta da tela. */
  defaultOpen?: boolean;
  /** O que dizer quando `count === 0`: como esse dado entra no app. Obrigatório na prática. */
  emptyHint?: string;
  /** Ícone pequeno à esquerda do título (elemento pronto — este pacote não casa com lucide). */
  icon?: ReactNode;
  /** Ação no canto do cabeçalho ("+ Novo"). Fica FORA da área de recolher. */
  action?: ReactNode;
  /**
   * Avisa o pai que abriu/fechou.
   *
   * É o que habilita a consulta sob demanda: o acervo só é buscado no servidor quando
   * alguém realmente abre a seção.
   */
  onMudarAberta?: (aberta: boolean) => void;
  style?: StyleProp<ViewStyle>;
  children?: ReactNode;
}

export function CollapsibleSection({
  title,
  count,
  defaultOpen = false,
  emptyHint,
  icon,
  action,
  onMudarAberta,
  style,
  children,
}: Props) {
  // `null` não é vazia: é "não contei". Vazia de verdade é só o zero contado.
  const vazia = count === 0;

  // Duas peças de estado, e a distinção entre elas é o conserto inteiro:
  // `tocou` = a pessoa já mandou nesta seção; `manual` = o que ela mandou.
  const [tocou, setTocou] = useState(false);
  const [manual, setManual] = useState(false);
  // A regra mora em `secao-aberta.ts` — lá ela é executável por teste, aqui ela seria
  // só uma linha que ninguém consegue rodar sem montar a tela inteira.
  const aberta = secaoAberta({ tocou, manual, defaultOpen, vazia });

  const semMovimento = useReducedMotion();
  const giro = useSharedValue(aberta ? 1 : 0);

  // A seta acompanha `aberta` por efeito, e não dentro do `alternar`: ela também precisa
  // girar quando a seção abre sozinha — que é justamente o caso que o toque não cobre.
  useEffect(() => {
    const alvo = aberta ? 1 : 0;
    giro.value = semMovimento ? alvo : withTiming(alvo, { duration: 160 });
  }, [aberta, giro, semMovimento]);

  // O pai é avisado por efeito pela mesma razão. Quem pendura consulta sob demanda no
  // `onMudarAberta` precisa saber das DUAS aberturas (a do toque e a do dado que chegou),
  // senão o acervo nunca é buscado. Avisar dentro do render — ou de dentro do updater do
  // `setState`, que roda na fase de render — seria atualizar um componente enquanto outro
  // renderiza.
  const avisado = useRef<boolean | null>(null);
  useEffect(() => {
    if (avisado.current === aberta) return;
    const primeiraVez = avisado.current === null;
    avisado.current = aberta;
    // Na montagem só avisa se JÁ nasceu aberta: um `false` inicial não é "fechou", é o
    // estado de repouso de toda seção recolhida, e disparar isso seria ruído no pai.
    if (primeiraVez && !aberta) return;
    onMudarAberta?.(aberta);
  }, [aberta, onMudarAberta]);

  const alternar = useCallback(() => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setTocou(true);
    setManual(!aberta);
  }, [aberta]);

  const seta = useAnimatedStyle(() => ({ transform: [{ rotate: `${giro.value * 180}deg` }] }));

  return (
    <Animated.View
      layout={semMovimento ? undefined : LinearTransition.duration(180)}
      style={[styles.wrap, style]}
    >
      <View style={styles.cabecalhoLinha}>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: aberta }}
          accessibilityLabel={
            count === null ? title : `${title}, ${count} ${count === 1 ? 'item' : 'itens'}`
          }
          onPress={alternar}
          style={styles.cabecalho}
        >
          {icon ? <View style={styles.icone}>{icon}</View> : null}
          <Text style={styles.titulo} numberOfLines={1}>
            {title}
          </Text>
          {/* O contador é parte do título, não uma badge a 60px dali: um dado é dito UMA vez.
              Sem contagem, um espaçador ocupa o lugar dele — a seta continua no canto. */}
          {count === null ? (
            <View style={styles.espaco} />
          ) : (
            <Text style={[styles.contador, vazia && styles.contadorVazio]}>· {count}</Text>
          )}
          <Animated.View style={seta}>
            <ChevronDown size={18} color={colors.textDim} />
          </Animated.View>
        </Pressable>
        {action}
      </View>

      {aberta ? <View style={styles.corpo}>{children}</View> : null}
      {aberta && vazia && emptyHint ? <Text style={styles.dica}>{emptyHint}</Text> : null}
      {/* Vazia e fechada: a dica fica visível de todo jeito. Um "0" sem explicação é o
          mesmo vazio mudo de antes, só com número. */}
      {!aberta && vazia && emptyHint ? <Text style={styles.dica}>{emptyHint}</Text> : null}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginBottom: spacing.lg },
  cabecalhoLinha: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  /** 48 de altura: o cabeçalho é o alvo de toque, e alvo de toque tem piso de 44pt. */
  cabecalho: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    minHeight: 48,
    paddingRight: 4,
  },
  icone: { width: 20, alignItems: 'center' },
  titulo: { color: colors.text, fontSize: 16, fontWeight: '600', letterSpacing: -0.3, flexShrink: 1 },
  contador: { color: colors.textDim, fontSize: 15, fontWeight: '600', flexGrow: 1 },
  contadorVazio: { color: colors.textFaint },
  espaco: { flexGrow: 1 },
  corpo: { gap: spacing.sm, paddingTop: 2 },
  dica: {
    color: colors.textDim,
    fontSize: 13,
    lineHeight: 19,
    paddingTop: 2,
    paddingBottom: 6,
    paddingHorizontal: 2,
    borderRadius: radii.md,
  },
});
