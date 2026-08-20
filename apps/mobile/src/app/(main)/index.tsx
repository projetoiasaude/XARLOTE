/**
 * A Conversa — a tela principal do app.
 *
 * Decisões que importam:
 *
 * · **O topo responde "o que eu faço agora?" antes de qualquer rolagem.** O card `Hoje`
 *   (features/chat/HojeCard.tsx) traz a próxima dose e o botão `Já tomei`. A saudação
 *   continua ali, mas ela não é a resposta de nada: quem toma quatro remédios não abre um
 *   app de saúde pra ser cumprimentado.
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
 *
 * · **"Pensando" não monta um segundo orb.** Antes, o rodapé da lista instanciava outro
 *   `LiquidCore` em modo `thinking` — 3 blobs com `withRepeat` infinito e 3 SVGs de
 *   degradê, exatamente no instante em que a lista recebe item novo. Agora o sinal sobe
 *   pelo `typing-signal` e o orb do `OrbNav`, que já existe e já sabe fazer isso, entra
 *   em `thinking`. Aqui fica texto puro.
 *
 * · **Foto passa por prévia.** `enviarComPrevia` intercepta o envio com mídia e abre
 *   `ConfirmarFoto`. Ver o cabeçalho de lá pro motivo de a confirmação caber entre o
 *   upload e a mensagem, e não antes do upload.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AppState, Pressable, StyleSheet, Text, View } from 'react-native';
import Animated from 'react-native-reanimated';
import { useRecuoDoTeclado } from '@/lib/teclado';
import { FlashList } from '@shopify/flash-list';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { MessageCircle, WifiOff, X } from 'lucide-react-native';
import { EmptyState, GlassBadge, LoadFailure, Skeleton } from '@/components/ui';
import { useChat } from '@/features/chat/use-chat';
import { Bubble } from '@/features/chat/Bubble';
import { HojeCard } from '@/features/chat/HojeCard';
import { ConfirmarFoto, type RascunhoMidia } from '@/features/chat/ConfirmarFoto';
import { VisorFoto } from '@/features/chat/VisorFoto';
import { AudioPlaybackProvider } from '@/features/chat/audio-playback';
import { Compositor } from '@/features/media/Compositor';
import type { ChatItem } from '@/features/chat/merge';
import { horaBrt } from '@/lib/br-format';
import { useMe } from '@/lib/api/use-me';
import { useSession } from '@/lib/auth/session';
import { colors, FONTE_CLINICA, radii } from '@/theme';
import type { TipoMidia } from '@/features/media/use-media';

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

export default function ChatScreen() {
  const insets = useSafeAreaInsets();
  const { user } = useSession();
  const { data: me } = useMe();
  const {
    items,
    carregando,
    erroDeLeitura,
    falha,
    recarregar,
    recarregando,
    xarloteDigitando,
    degradado,
    temMais,
    carregarMais,
    enviar,
    reenviar,
    erro,
    limparErro,
  } = useChat();

  const [fotoAberta, setFotoAberta] = useState<string | null>(null);
  const [rascunho, setRascunho] = useState<RascunhoMidia | null>(null);

  const abrirFoto = useCallback((url: string) => setFotoAberta(url), []);
  const renderItem = useCallback(
    ({ item }: { item: ChatItem }) => (
      <Bubble item={item} onRetry={reenviar} onAbrirFoto={abrirFoto} />
    ),
    [reenviar, abrirFoto],
  );

  /**
   * SÓ FOTO espera confirmação. Áudio e PDF vão direto — e a diferença não é preguiça.
   *
   * A prévia existe pra você CONFERIR antes de mandar. Numa foto ela cumpre isso: a
   * miniatura mostra se você pegou o laudo ou a foto do neto que estava do lado na
   * galeria — engano comum e caro, porque a foto errada entra no prontuário. É também o
   * que o WhatsApp faz.
   *
   * Com áudio e PDF ela não confere nada. O áudio aparecia como um retângulo preto
   * escrito "áudio pronto pra enviar", sem tocar — não dava pra ouvir o que se gravou. O
   * PDF caía no mesmo lugar e virava um quadrado preto com um pedido de "confira se está
   * legível". Uma confirmação que não deixa conferir é só um toque a mais, e ainda ensina
   * que os avisos deste app podem ser ignorados.
   *
   * Texto sempre vai na hora: é corrigível na conversa, e um "confirma?" por frase seria
   * insuportável.
   */
  const enviarComPrevia = useCallback(
    (texto: string, mediaId?: string, tipo?: TipoMidia) => {
      if (mediaId && tipo === 'image') {
        setRascunho({ mediaId, legenda: texto });
        return;
      }
      enviar(texto, mediaId);
    },
    [enviar],
  );

  const confirmarRascunho = useCallback(() => {
    if (!rascunho) return;
    enviar(rascunho.legenda, rascunho.mediaId);
    setRascunho(null);
  }, [rascunho, enviar]);

  const primeiroNome = (me?.user.preferredName ?? user?.preferredName ?? '').split(' ')[0];
  /**
   * Vazio é a conversa que NUNCA existiu. Leitura que falhou é outra tela.
   *
   * `carregando` fica falso no instante em que a primeira busca falha, então sem o
   * `erroDeLeitura` na frente deste `vazio` a tela dizia "nossa conversa começa aqui"
   * para quem tem um ano de histórico e está sem rede — a mesma mentira que a tela de
   * Saúde recusa com o `LoadFailure`, aqui com uma frase só.
   */
  const vazio = !carregando && !erroDeLeitura && items.length === 0;

  /**
   * O relógio da tela REAVALIA quando o app volta do background.
   *
   * Sem isto ele é calculado uma única vez, na montagem: o app aberto às 22h e trazido
   * de volta às 9h da manhã seguinte continuava dizendo "Boa noite" — foi exatamente o
   * que apareceu no simulador. Um app que dá bom dia à noite é um app que não parece
   * estar prestando atenção, e essa é a única coisa que a Xarlote vende.
   *
   * O mesmo instante alimenta o card `Hoje`: uma dose que vence às 8h com a tela montada
   * às 7h precisa virar "passou da hora" quando a pessoa volta ao app, não no próximo
   * reinício.
   */
  const [agoraMs, setAgoraMs] = useState(() => Date.now());
  useEffect(() => {
    const sub = AppState.addEventListener('change', (estado) => {
      if (estado === 'active') setAgoraMs(Date.now());
    });
    return () => sub.remove();
  }, []);
  const horaAtual = useMemo(() => horaBrt(agoraMs), [agoraMs]);

  /**
   * O rodapé é memoizado: um elemento novo a cada render fazia a FlashList remontar o
   * rodapé em toda tecla digitada.
   */
  const rodape = useMemo(
    () =>
      xarloteDigitando ? (
        <View style={styles.digitando}>
          <Text style={styles.digitandoTexto}>Xarlote está pensando…</Text>
        </View>
      ) : null,
    [xarloteDigitando],
  );

  // Ver `lib/teclado.ts`: o porquê de não ser mais `KeyboardAvoidingView`.
  const recuoDoTeclado = useRecuoDoTeclado(insets.bottom);

  return (
    <AudioPlaybackProvider>
      <Animated.View style={[styles.root, recuoDoTeclado]}>
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
          {degradado && <WifiOff size={16} color={colors.warn} />}
        </View>

        <HojeCard agoraMs={agoraMs} />

        {carregando ? (
          <View style={styles.carregando}>
            <Skeleton width="62%" height={38} style={styles.sk} />
            <Skeleton width="45%" height={30} style={[styles.sk, styles.skDireita]} />
            <Skeleton width="70%" height={46} style={styles.sk} />
          </View>
        ) : erroDeLeitura ? (
          <View style={styles.falha}>
            <LoadFailure
              erro={falha}
              oQue="sua conversa"
              tentando={recarregando}
              onTentarDeNovo={recarregar}
            />
          </View>
        ) : vazio ? (
          <View style={styles.vazio}>
            <EmptyState
              icon={<MessageCircle size={22} color={colors.textDim} />}
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
            ListFooterComponent={rodape}
          />
        )}

        {/* O erro é DISPENSÁVEL pelo toque: sem isso ele fica na tela pra sempre, e uma
            frase de erro velha sobre uma mensagem que depois foi entregue mente. */}
        {erro ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Fechar o aviso de erro"
            onPress={limparErro}
            style={styles.erroBarra}
          >
            <Text style={styles.erro}>{erro}</Text>
            <X size={15} color={colors.dangerSoft} />
          </Pressable>
        ) : null}

        <Compositor onEnviar={enviarComPrevia} paddingBottom={insets.bottom + 10} paddingRight={ORB_GAP} />
      </Animated.View>

      <ConfirmarFoto
        rascunho={rascunho}
        onConfirmar={confirmarRascunho}
        onDescartar={() => setRascunho(null)}
      />
      <VisorFoto url={fotoAberta} onFechar={() => setFotoAberta(null)} />
    </AudioPlaybackProvider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 20, paddingBottom: 12 },
  headerTexto: { flex: 1 },
  saudacao: { color: colors.text, fontSize: 22, fontWeight: '700', letterSpacing: -0.5 },
  sub: { color: colors.textDim, fontSize: FONTE_CLINICA, marginTop: 2 },
  badge: { marginTop: 4 },
  lista: { paddingVertical: 8 },
  carregando: { flex: 1, paddingHorizontal: 16, paddingTop: 12 },
  sk: { marginBottom: 10, borderRadius: radii.xl },
  skDireita: { alignSelf: 'flex-end' },
  vazio: { flex: 1, justifyContent: 'center' },
  falha: { flex: 1, justifyContent: 'center', paddingHorizontal: 16 },
  digitando: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 20, paddingVertical: 8 },
  digitandoTexto: { color: colors.textDim, fontSize: FONTE_CLINICA },
  erroBarra: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginHorizontal: 16,
    marginBottom: 6,
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: 'rgba(248,113,113,0.35)',
    backgroundColor: 'rgba(248,113,113,0.12)',
  },
  erro: { flex: 1, color: colors.dangerSoft, fontSize: FONTE_CLINICA, lineHeight: 18 },
});
