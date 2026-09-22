/**
 * Atividade — "o que a Xarlote está fazendo por você agora".
 *
 * O gargalo de conversão que a auditoria de 03/08 achou tinha uma causa mecânica (a
 * mensagem nunca chegava à farmácia) e uma causa de percepção: o paciente pedia o
 * remédio e, do lado dele, nada acontecia. Esta tela é o antídoto da segunda — passos
 * verificáveis, com o preço e o nome da farmácia quando existem, e um "sua vez" quando
 * a bola está com ele.
 *
 * ## O que mudou nesta sessão
 *
 * 1. **A frase de estado vem ANTES da lista.** Ela ficava no rodapé: quem abria via
 *    primeiro a pilha de encerrados e só descobria no fim que nada estava ativo — a
 *    resposta da tela chegando depois do conteúdo que a contradiz.
 * 2. **Encerrado é linha, dentro de uma seção recolhida com contador.** Eram até quinze
 *    cartões completos de quatro etapas cada, em `opacity: 0.6`, empurrando pra baixo o
 *    único item que pede ação. Continuam todos ali, a um toque — o que não pode é o
 *    histórico morto disputar espaço com o presente.
 * 3. **Os cartões vivos agora AGEM.** "Sua vez" leva às opções em um toque, e um pedido
 *    que esfriou tem "Ainda preciso", que manda o pedido de retomada pronto. As duas
 *    frases "me chama no chat" que estavam em `timeline.ts` sumiram junto: o app faz o
 *    que ele pedia que o paciente fizesse.
 * 4. **Nem a frase de estado nem o vazio mandam "pedir no chat".** Uma terceira cópia da
 *    frase tinha voltado pela porta da tela, embaixo de "Nada em andamento agora". Nos
 *    dois lugares agora tem o botão `BotaoFalar`, que abre a conversa.
 *
 * Todas as etapas e desfechos saem de `timeline.ts` (puro): a tela não deduz progresso,
 * só desenha o que a função derivou dos dados.
 */
import { useCallback, useMemo } from 'react';
import { RefreshControl, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { History, MessageCircle, Zap } from 'lucide-react-native';
import { EmptyState, GlassButton, GlassCard, LoadFailure, Skeleton } from '@/components/ui';
import { CollapsibleSection } from '@/components/ui/collapsible-section';
import { Screen } from '@/components/xarlote/Screen';
import { AvisoCuidador } from '@/features/care/AvisoCuidador';
import { ActivityCard } from '@/features/activity/ActivityCard';
import { ActivityLine } from '@/features/activity/ActivityLine';
import { montarAtividades, resumoDaAtividade, type Atividade } from '@/features/activity/timeline';
import { useAgora } from '@/features/health/use-agora';
import { useFalarComXarlote } from '@/features/health/use-falar-com-xarlote';
import { useOverview } from '@/features/health/use-overview';
import { colors, FONTE_CLINICA } from '@/theme';

/**
 * O caminho pra conversa — um CONTROLE, não uma frase.
 *
 * Aqui morava "Nada travado do meu lado. É só me pedir no chat quando precisar de algo.":
 * a tela mandando o paciente fazer o que ela mesma podia fazer, e sem dizer por onde. As
 * duas irmãs dessa frase já tinham sido mortas em `timeline.ts` nesta mesma sessão — esta
 * tinha voltado pela porta da tela. O estado vazio ganha o mesmo botão: dizer o que
 * apareceria aqui "quando você me pedir algo" sem oferecer o caminho é um beco.
 *
 * `size="md"` são 40pt de altura + o `hitSlop` que o próprio `GlassButton` calcula = 44.
 * O háptico também é dele (dispara no `onPress`), então o chamador não toca de novo.
 */
function BotaoFalar({ onPress }: { onPress: () => void }) {
  return (
    <GlassButton
      size="md"
      variant="secondary"
      icon={<MessageCircle size={16} color={colors.text} />}
      onPress={onPress}
      accessibilityLabel="Abrir a conversa com a Xarlote"
    >
      Falar com a Xarlote
    </GlassButton>
  );
}

export default function AtividadeScreen() {
  const { data, isLoading, isRefetching, isError, error, refetch } = useOverview();
  const router = useRouter();
  // Reacerta ao voltar do segundo plano: "atualizado há 2 min" congelado na montagem
  // continua dizendo 2 min meia hora depois.
  const agora = useAgora();
  const { falar, emVoo, bloqueado } = useFalarComXarlote();

  const atividades = useMemo(
    () => (data ? montarAtividades(data.orders, data.consultations, agora) : []),
    [data, agora],
  );
  const resumo = useMemo(() => resumoDaAtividade(atividades), [atividades]);

  const vivas = useMemo(() => atividades.filter((a) => a.viva), [atividades]);
  const encerradas = useMemo(() => atividades.filter((a) => !a.viva), [atividades]);

  const aoAtualizar = useCallback(() => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    void refetch();
  }, [refetch]);

  /**
   * A ação do cartão. `responder` navega; `retomar` manda a mensagem pronta.
   *
   * Depende de `falar` e `router` — nunca do objeto de mutação inteiro. Dependência
   * instável aqui faria o `memo` do `ActivityCard` não segurar nada, e cada re-render do
   * pai reconstruiria a subárvore de todos os cartões (com o vidro e as etapas junto).
   */
  const aoAgir = useCallback(
    (a: Atividade) => {
      if (!a.acao) return;
      if (a.acao.tipo === 'responder') {
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        // `navigate` entre irmãos, nunca `push`: empilhar a conversa sobre a Atividade
        // faria o botão de voltar do Android sair do chat pra cá, e não pra fora.
        router.navigate('/');
        return;
      }
      falar(a.acao.mensagem, `${a.tipo}:${a.id}`);
    },
    [falar, router],
  );

  /** Mesma regra do `aoAgir`: `navigate` entre irmãos, nunca `push`. */
  const irParaConversa = useCallback(() => {
    router.navigate('/');
  }, [router]);

  if (isLoading && !data) {
    return (
      <Screen title="Atividade" subtitle="o que estou fazendo por você">
        <Skeleton variant="card" height={190} />
        <View style={styles.espaco} />
        <Skeleton variant="card" height={190} />
      </Screen>
    );
  }

  return (
    <Screen
      title="Atividade"
      subtitle="o que estou fazendo por você"
      refreshControl={
        <RefreshControl refreshing={isRefetching} onRefresh={aoAtualizar} tintColor={colors.accentHi} />
      }
    >
      {/* 🤝 Dito UMA vez, antes dos cartões: "Ainda preciso" escreveria na conversa de
          quem está logado, e o pedido é de quem tem o registro aberto. */}
      <AvisoCuidador />

      {isError && !data ? (
        <LoadFailure
          erro={error}
          oQue="o que está em andamento"
          tentando={isRefetching}
          onTentarDeNovo={aoAtualizar}
        />
      ) : atividades.length === 0 ? (
        <GlassCard>
          <EmptyState
            icon={<Zap size={22} color={colors.textFaint} />}
            title="Nada em andamento agora"
            hint="Quando você me pedir um remédio ou uma consulta, o passo a passo aparece aqui — quantas farmácias responderam, o melhor preço, e o que falta."
            action={<BotaoFalar onPress={irParaConversa} />}
          />
        </GlassCard>
      ) : (
        <>
          {/* A frase de estado é o herói e vem PRIMEIRO — inclusive quando o que existe
              é só histórico, que é justamente o caso em que ela era invisível. */}
          <Text style={styles.estado}>{resumo.frase}</Text>
          {/* Sem nada vivo, a tela não fica só constatando: o caminho de sair desse
              estado é um botão aqui mesmo, do tamanho do dedo. */}
          {resumo.vivas === 0 ? (
            <View style={styles.acaoEstado}>
              <BotaoFalar onPress={irParaConversa} />
            </View>
          ) : null}

          {vivas.length > 0 && (
            <View style={styles.lista}>
              {vivas.map((a) => (
                <ActivityCard
                  key={`${a.tipo}-${a.id}`}
                  atividade={a}
                  agoraMs={agora}
                  onAcao={aoAgir}
                  ocupado={emVoo === `${a.tipo}:${a.id}`}
                  bloqueado={bloqueado}
                />
              ))}
            </View>
          )}

          {encerradas.length > 0 && (
            <CollapsibleSection
              title="Já encerrados"
              count={encerradas.length}
              icon={<History size={16} color={colors.textDim} />}
              style={styles.secao}
            >
              <View style={styles.linhas}>
                {encerradas.map((a) => (
                  <ActivityLine key={`${a.tipo}-${a.id}`} atividade={a} agoraMs={agora} />
                ))}
              </View>
              {/* O que não deu certo continua registrado, e a seção diz isso em vez de
                  deixar o paciente descobrir sozinho por que há um "não seguiu" ali. */}
              <Text style={styles.rodapeSecao}>
                Fica registrado, mesmo o que não deu certo.
              </Text>
            </CollapsibleSection>
          )}
        </>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  espaco: { height: 14 },
  estado: { color: colors.text, fontSize: 20, fontWeight: '600', letterSpacing: -0.4 },
  acaoEstado: { alignSelf: 'flex-start', marginTop: 12 },
  lista: { gap: 12, marginTop: 18 },
  secao: { marginTop: 26 },
  linhas: { gap: 2 },
  rodapeSecao: { color: colors.textFaint, fontSize: FONTE_CLINICA, lineHeight: 18, marginTop: 10 },
});
