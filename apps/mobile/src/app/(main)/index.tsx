/**
 * A Conversa — a tela principal do app.
 *
 * Decisões que importam:
 *
 * · **Lista NÃO invertida, com `maintainVisibleContentPosition`.** A receita antiga de
 *   chat em RN era inverter a lista; a FlashList v2 removeu o `inverted` e resolve o
 *   problema de outro jeito, melhor: a lista fica em ordem cronológica normal e ela
 *   segura a posição de rolagem quando conteúdo entra em cima ou embaixo. Ganhos
 *   diretos: a ordem dos dados é a mesma que a pessoa lê (nada de reverter array a
 *   cada render), `onStartReached` significa literalmente "cheguei no começo da
 *   conversa" — é ali que se carrega o histórico — e `autoscrollToBottomThreshold`
 *   só rola pra mensagem nova se o paciente já estava no fim, sem arrancá-lo do meio
 *   da leitura quando a Xarlote responde.
 *
 * · **A lista é virtualizada.** Um paciente de um ano tem milhares de mensagens; a
 *   `ScrollView` que o web usa montaria todas.
 *
 * · **O estado degradado FALA.** Quando o SSE desiste e o app cai no polling, aparece
 *   um aviso. Uma tela que jura estar ao vivo e está morta é pior que uma que admite
 *   estar atualizando de tempos em tempos.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AppState,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ArrowUp, MessageCircle, WifiOff } from 'lucide-react-native';
import { EmptyState, GlassBadge, Skeleton } from '@/components/ui';
import { LiquidCore } from '@/components/xarlote/LiquidCore';
import { useChat } from '@/features/chat/use-chat';
import { Bubble } from '@/features/chat/Bubble';
import type { ChatItem } from '@/features/chat/merge';
import { horaBrt } from '@/lib/br-format';
import { useMe } from '@/lib/api/use-me';
import { useSession } from '@/lib/auth/session';
import { colors, radii } from '@/theme';

/** Altura do orb + folga: o compositor nunca fica embaixo dele. */
const ORB_GAP = 84;

/**
 * A saudação lê a hora de BRASÍLIA, não a do aparelho.
 *
 * O aparelho quase sempre está no fuso certo — mas "quase sempre" numa saudação é o
 * mesmo tipo de aposta que fazia a dose das 22h migrar de dia no gráfico. Mesma regra
 * pra tudo que tem hora no app: `horaBrt` (ver src/lib/br-format.ts).
 */
function saudacao(hour: number): string {
  if (hour < 12) return 'Bom dia';
  if (hour < 18) return 'Boa tarde';
  return 'Boa noite';
}

function Digitando() {
  return (
    <View style={styles.digitando}>
      <LiquidCore size={26} mode="thinking" />
      <Text style={styles.digitandoTexto}>Xarlote está pensando…</Text>
    </View>
  );
}

export default function ChatScreen() {
  const insets = useSafeAreaInsets();
  const { user } = useSession();
  const { data: me } = useMe();
  const { items, carregando, xarloteDigitando, degradado, temMais, carregarMais, enviar, reenviar, erro } =
    useChat();
  const [rascunho, setRascunho] = useState('');
  const input = useRef<TextInput>(null);

  const submeter = useCallback(() => {
    const t = rascunho.trim();
    if (!t) return;
    enviar(t);
    setRascunho('');
  }, [rascunho, enviar]);

  const renderItem = useCallback(
    ({ item }: { item: ChatItem }) => <Bubble item={item} onRetry={reenviar} />,
    [reenviar],
  );

  const primeiroNome = (me?.user.preferredName ?? user?.preferredName ?? '').split(' ')[0];
  const vazio = !carregando && items.length === 0;

  /**
   * A saudação REAVALIA quando o app volta do background.
   *
   * Sem isto ela é calculada uma única vez, na montagem: o app aberto às 22h e trazido
   * de volta às 9h da manhã seguinte continuava dizendo "Boa noite" — foi exatamente o
   * que apareceu no simulador. Um app que dá bom dia à noite é um app que não parece
   * estar prestando atenção, e essa é a única coisa que a Xarlote vende.
   */
  const [horaAtual, setHoraAtual] = useState(() => horaBrt(Date.now()));
  useEffect(() => {
    const sub = AppState.addEventListener('change', (estado) => {
      if (estado === 'active') setHoraAtual(horaBrt(Date.now()));
    });
    return () => sub.remove();
  }, []);

  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={0}
    >
      <View style={[styles.header, { paddingTop: insets.top + 10 }]}>
        <View style={styles.headerTexto}>
          <Text style={styles.saudacao}>
            {saudacao(horaAtual)}
            {primeiroNome ? `, ${primeiroNome}` : ''}
          </Text>
          {degradado ? (
            <GlassBadge tone="warn" size="xs" style={styles.badge}>
              atualizando de tempos em tempos
            </GlassBadge>
          ) : (
            <Text style={styles.sub}>Estou aqui pra cuidar de você.</Text>
          )}
        </View>
        {degradado && <WifiOff size={15} color={colors.warn} />}
      </View>

      {carregando ? (
        <View style={styles.carregando}>
          <Skeleton width="62%" height={38} style={styles.sk} />
          <Skeleton width="45%" height={30} style={[styles.sk, styles.skDireita]} />
          <Skeleton width="70%" height={46} style={styles.sk} />
        </View>
      ) : vazio ? (
        <View style={styles.vazio}>
          <EmptyState
            icon={<MessageCircle size={22} color={colors.textFaint} />}
            title="Nossa conversa começa aqui"
            hint="Me conta o que você está sentindo, manda uma foto de exame, ou pede pra eu lembrar de um remédio. Eu cuido do resto."
          />
        </View>
      ) : (
        <FlashList
          data={items}
          renderItem={renderItem}
          keyExtractor={(item) => item.key}
          // Começo da lista = mensagem mais antiga → é aqui que se puxa o histórico.
          onStartReached={temMais ? carregarMais : undefined}
          onStartReachedThreshold={0.4}
          maintainVisibleContentPosition={{
            // Abre já no fim da conversa, como todo app de mensagem.
            startRenderingFromBottom: true,
            // Só acompanha a mensagem nova se a pessoa já estava perto do fim. Quem
            // está lendo algo mais atrás NÃO é arrastado quando a Xarlote responde.
            autoscrollToBottomThreshold: 0.2,
            // Conteúdo antigo entrando em cima nunca move o que está sendo lido.
            autoscrollToTopThreshold: 0,
          }}
          keyboardDismissMode="interactive"
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={styles.lista}
          // Ordem normal: o rodapé é o fim da conversa, lugar natural do "digitando".
          ListFooterComponent={xarloteDigitando ? <Digitando /> : null}
        />
      )}

      {erro && <Text style={styles.erro}>{erro}</Text>}

      <View style={[styles.compositor, { paddingBottom: insets.bottom + 10, paddingRight: ORB_GAP }]}>
        <TextInput
          ref={input}
          value={rascunho}
          onChangeText={setRascunho}
          placeholder="Escreve pra Xarlote…"
          placeholderTextColor={colors.textFaint}
          selectionColor={colors.accentHi}
          keyboardAppearance="dark"
          multiline
          // 6 linhas no máximo: acima disso o campo come a conversa inteira.
          style={styles.campo}
          onSubmitEditing={submeter}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Enviar"
          accessibilityState={{ disabled: rascunho.trim().length === 0 }}
          disabled={rascunho.trim().length === 0}
          onPress={submeter}
          style={[styles.enviar, rascunho.trim().length === 0 && styles.enviarInerte]}
        >
          <ArrowUp size={19} color="#ffffff" />
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 20, paddingBottom: 12 },
  headerTexto: { flex: 1 },
  saudacao: { color: colors.text, fontSize: 22, fontWeight: '700', letterSpacing: -0.5 },
  sub: { color: colors.textDim, fontSize: 13, marginTop: 2 },
  badge: { marginTop: 4 },
  lista: { paddingVertical: 8 },
  carregando: { flex: 1, paddingHorizontal: 16, paddingTop: 12 },
  sk: { marginBottom: 10, borderRadius: radii.xl },
  skDireita: { alignSelf: 'flex-end' },
  vazio: { flex: 1, justifyContent: 'center' },
  digitando: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 20, paddingVertical: 8 },
  digitandoTexto: { color: colors.textDim, fontSize: 12 },
  erro: { color: '#fda4af', fontSize: 12, paddingHorizontal: 20, paddingBottom: 6 },
  compositor: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 8,
    paddingHorizontal: 16,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: colors.glassBorder,
    backgroundColor: 'rgba(10,10,30,0.72)',
  },
  campo: {
    flex: 1,
    maxHeight: 132,
    minHeight: 42,
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderWidth: 1,
    borderColor: colors.glassBorder,
    borderRadius: radii.xl,
    paddingHorizontal: 14,
    paddingTop: 11,
    paddingBottom: 11,
    color: colors.text,
    fontSize: 15,
  },
  enviar: {
    width: 42,
    height: 42,
    borderRadius: 21,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.accent,
  },
  enviarInerte: { opacity: 0.35 },
});
