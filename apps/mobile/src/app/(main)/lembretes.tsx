/**
 * Lembretes — a tela responde UMA pergunta: **o que está pendente?**
 *
 * ## A queixa que reescreveu esta tela
 *
 * "Os lembretes vão se acumulando infinitamente, isso pode carregar muito." O diagnóstico
 * era pior do que a queixa: eles acumulavam E EXPULSAVAM os vivos. A rota trazia 120
 * lembretes ordenados por `next_run_at ASC` sem filtrar status, e lembrete encerrado
 * guarda a data no passado pra sempre — então o corte pegava os 120 MAIS ANTIGOS. Passado
 * o 121º lembrete da vida do paciente, esta tela mostrava só cadáver de meses atrás e o
 * remédio de HOJE ficava fora da janela.
 *
 * O conserto não foi um `slice()` aqui (isso esconderia o problema no cliente enquanto a
 * rede continuasse trazendo tudo). Foram três decisões, e todas moram no servidor:
 *
 * 1. **A lista viva vem sozinha** (`?scope=active`) — pequena, ordenada do mais urgente
 *    ao mais distante, e cortada pelo FUTURO, que é o lado descartável.
 * 2. **O histórico só desce se o paciente pedir** — a seção recolhida é o que habilita a
 *    consulta. Abrir esta aba não baixa acervo nenhum.
 * 3. **O histórico é paginado por cursor** (nunca OFFSET), 12 por toque em "ver mais".
 *
 * ## A ordem dos blocos é a resposta à pergunta da tela
 *
 * Passou da hora e hoje ficam ABERTOS, em cartão, com os três botões: é o que pede ação.
 * Amanhã em diante fica recolhido — saber que existe basta. O acervo fica no fim,
 * recolhido, com o contador, porque o número diz o tamanho sem custar uma linha de rede.
 *
 * A exceção é o que o dedo ACABOU de tocar (`agiuAgora`): ele sai dos blocos e vai pra
 * "Acabei de registrar", com a frase da Xarlote embaixo do título. Sem isso, "Já tomei"
 * num remédio de todo dia — o caso dominante — mandava o cartão pra dentro da seção
 * fechada "Depois de hoje", e o toque que pedia confirmação respondia com o cartão
 * sumindo da tela.
 *
 * ## E o que a tela passou a FAZER
 *
 * Criar lembrete. A aba se chamava "Lembretes" e era o único lugar do app onde não se
 * podia criar um: o estado vazio mandava o paciente digitar a frase certa no chat. Para
 * quem tem 55 anos, três campos são mais fáceis que uma frase — e o erro da frase é
 * silencioso.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import * as Haptics from 'expo-haptics';
import { AlarmClock, ChevronDown, Plus, TriangleAlert, X } from 'lucide-react-native';
import type { ReminderAppAction } from '@iasaude/shared';
import {
  CollapsibleSection,
  EmptyState,
  GlassBadge,
  GlassButton,
  GlassCard,
  LoadFailure,
  SectionHeader,
  Skeleton,
} from '@/components/ui';
import { Screen } from '@/components/xarlote/Screen';
import { HistoricoLinha } from '@/features/reminders/HistoricoLinha';
import { NovoLembrete } from '@/features/reminders/NovoLembrete';
import { ReminderCard } from '@/features/reminders/ReminderCard';
import {
  fraseDaAcao,
  proximoInstanteRelevante,
  separarAgenda,
  type CorpoNovoLembrete,
} from '@/features/reminders/format';
import {
  useCriarLembrete,
  useHistoricoLembretes,
  useReminderAction,
  useReminders,
} from '@/features/reminders/use-reminders';
import { ApiError } from '@/lib/api/errors';
import { colors, FONTE_CLINICA, FONTE_MINIMA, radii } from '@/theme';

/** Teto de segurança do despertador: nenhum timer de horas pendurado. */
const ESPERA_MAX_MS = 30 * 60_000;

/**
 * O texto que o paciente lê quando o salvar falha.
 *
 * A mensagem do SERVIDOR ganha quando existe: é ela que sabe o motivo específico ("você
 * já tem 40 lembretes ativos…"). Trocar isso por um genérico apagaria a única orientação
 * útil que a resposta trazia.
 */
function textoDoErro(erro: unknown, padrao = 'Não consegui salvar agora. Tenta de novo?'): string {
  if (erro instanceof ApiError) return erro.failure.message;
  return padrao;
}

export default function LembretesScreen() {
  const { data, isLoading, isRefetching, isError, error, refetch } = useReminders();
  const { agir, emAndamento, idEmAndamento } = useReminderAction();
  const criar = useCriarLembrete();

  const [formAberto, setFormAberto] = useState(false);
  const [historicoAberto, setHistoricoAberto] = useState(false);
  const [agora, setAgora] = useState(() => Date.now());

  /**
   * O que o paciente fez NESTA sessão da tela: id → a frase que a Xarlote respondeu.
   *
   * ## O defeito que isto existe pra matar
   *
   * "Já tomei" num remédio de TODO DIA — o caso dominante do produto — devolve o
   * lembrete como `pending` com `next_run_at` de amanhã. Sem este registro, ele cai no
   * bloco 'amanha', que a tela desenha DENTRO da seção recolhida "Depois de hoje": o
   * cartão desaparece da área visível, o aviso de "passou da hora" some junto, e o único
   * retorno do toque é o háptico. Desaparecer não é confirmação — é o paciente
   * perguntando se registrou.
   *
   * Com o id guardado aqui, `separarAgenda` tira a linha dos blocos e ela é desenhada em
   * "Acabei de registrar" com a frase embaixo do título. O cartão se TRANSFORMA no lugar
   * onde o dedo estava, em vez de teleportar pra dentro de uma seção fechada.
   *
   * Os ids ficam enquanto a aba estiver montada. Sair não é o gatilho de limpeza; o
   * ERRO é: se a ação falhar na rede, o id sai daqui junto com o rollback da linha, e a
   * tela para de afirmar o que não aconteceu.
   */
  const [agiuAgora, setAgiuAgora] = useState<Record<string, string>>({});

  /**
   * O que deu errado no último "já tomei"/"+30 min"/"cancelar", pronto pra ler.
   *
   * O rollback sozinho é mudo — e ele ficou MAIS importante desde que 403/404 pararam de
   * derrubar a sessão: antes, agir no lembrete de quem se cuida com o vínculo revogado
   * jogava a pessoa na tela de login (errado, mas visível); agora a linha só voltaria ao
   * lugar. Dispensável pelo toque, porque erro velho sobre uma ação que depois deu certo
   * mente.
   */
  const [erroDaAcao, setErroDaAcao] = useState<string | null>(null);

  const historico = useHistoricoLembretes(historicoAberto);

  const lista = data?.reminders ?? [];
  const idsAgidos = useMemo(() => new Set(Object.keys(agiuAgora)), [agiuAgora]);
  const agenda = useMemo(() => separarAgenda(lista, agora, idsAgidos), [lista, agora, idsAgidos]);

  /**
   * A lista mais recente, FORA da dependência de `aoAgir`.
   *
   * O wrapper precisa da linha como ela está pra escrever a frase certa (é `rrule` quem
   * decide entre "marquei como feito" e "o de hoje está feito"), mas depender de `lista`
   * daria identidade nova ao callback a cada resposta do servidor — e o `memo` do
   * `ReminderCard`, posto lá de propósito, pararia de segurar qualquer coisa. Ref
   * atualizada por efeito, e não em render: toque só existe depois do commit.
   */
  const listaRef = useRef(lista);
  useEffect(() => {
    listaRef.current = lista;
  }, [lista]);

  const aoAgir = useCallback(
    (id: string, acao: ReminderAppAction, minutos?: number) => {
      const alvo = listaRef.current.find((r) => r.id === id);
      // A frase sai da linha COMO ELA ESTAVA — depois da ação, o `rrule` continua lá mas
      // o horário já é o de amanhã, e a frase de recorrente é justamente a que não pode
      // dizer "concluído".
      if (alvo) setAgiuAgora((atual) => ({ ...atual, [id]: fraseDaAcao(alvo, acao, minutos) }));
      setErroDaAcao(null);

      agir(id, acao, minutos, (erro) => {
        // Desfazer NÃO é explicar: sem esta linha o cartão volta pra "passou da hora" em
        // silêncio, e a pessoa não sabe se o registro entrou. A mensagem do servidor
        // ganha — é ela que sabe dizer "esse lembrete não é seu" quando o vínculo de
        // cuidado foi revogado.
        setErroDaAcao(textoDoErro(erro, 'Não consegui registrar agora. Tenta de novo?'));
        setAgiuAgora((atual) => {
          if (!(id in atual)) return atual;
          const { [id]: _saiu, ...resto } = atual;
          return resto;
        });
      });
    },
    [agir],
  );

  /**
   * O despertador: um `setTimeout` para o próximo instante em que algum rótulo muda —
   * a próxima dose, ou a meia-noite de Brasília. Entre um e outro, nada roda.
   *
   * O `AppState` cuida do outro caminho: timers de JS não disparam com o app em
   * background, e voltar do background NÃO remonta a aba (elas ficam montadas). Sem esse
   * ouvinte, o app aberto pela manhã depois de uma noite parado mostraria os rótulos de
   * ontem.
   */
  useEffect(() => {
    const sub = AppState.addEventListener('change', (estado) => {
      if (estado === 'active') setAgora(Date.now());
    });
    return () => sub.remove();
  }, []);

  useEffect(() => {
    const proximo = proximoInstanteRelevante(lista, agora);
    if (proximo === null) return;
    // +1s de folga: acordar no milissegundo exato às vezes lê o instante como "ainda não
    // passou" e reagenda um timer de 0ms — um laço de renders.
    const espera = Math.min(Math.max(proximo - Date.now() + 1_000, 1_000), ESPERA_MAX_MS);
    const id = setTimeout(() => setAgora(Date.now()), espera);
    return () => clearTimeout(id);
  }, [lista, agora]);

  const aoAtualizar = useCallback(() => {
    void (async () => {
      await refetch();
      setAgora(Date.now());
      // Háptico no FIM do refresh: é o que diz "já atualizei" pra quem puxou a lista e
      // recebeu de volta a mesma tela (porque nada mudou).
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    })();
  }, [refetch]);

  const salvar = useCallback(
    (corpo: CorpoNovoLembrete) => {
      criar.mutate(corpo, {
        onSuccess: () => {
          setFormAberto(false);
          criar.reset();
          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        },
      });
    },
    [criar],
  );

  const abrirForm = useCallback(() => {
    criar.reset();
    setFormAberto(true);
  }, [criar]);

  const fecharForm = useCallback(() => {
    criar.reset();
    setFormAberto(false);
  }, [criar]);

  if (isLoading && !data) {
    return (
      <Screen title="Lembretes" subtitle="o que você tem pra hoje">
        <Skeleton variant="card" height={120} />
        <View style={styles.espaco} />
        <Skeleton variant="card" height={120} />
      </Screen>
    );
  }

  /**
   * Erro NÃO é vazio.
   *
   * `data` só existe depois de uma resposta boa (ou do cache em disco). Se a busca
   * falhou e não há nada em cache, a tela precisa dizer que falhou — foi exatamente
   * aqui que um 404 apareceu como "Nenhum lembrete por aqui" pra quem tinha lembretes.
   */
  const falhou = isError && !data;
  const totalEncerrados = data?.historico ?? null;
  const nadaVivo =
    agenda.acionaveis.length === 0 && agenda.futuros.length === 0 && agenda.recemEncerrados.length === 0;

  const paginasHistorico = historico.data?.pages ?? [];

  /**
   * O acervo MENOS o que já está desenhado em "Acabei de registrar".
   *
   * Confirmar um lembrete reseta a query do histórico (é onde o item recém-encerrado
   * aparece) mas NÃO invalida a lista viva — de propósito, pra que a linha continue no
   * lugar onde o dedo estava. O efeito colateral é que o servidor devolve, no histórico,
   * exatamente a linha que já está na tela: o MESMO lembrete duas vezes, em duas seções.
   *
   * A dedução é aqui e não no `onSettled` justamente por isso: invalidar a lista viva
   * apagaria a confirmação de "Acabei de registrar", que é o comportamento protegido.
   *
   * Sem `useMemo` de propósito: este trecho fica DEPOIS dos returns de carregando/erro,
   * e um hook depois de um return condicional muda a ordem dos hooks entre renders — o
   * crash clássico do React. São meia dúzia de ids num Set; o custo é zero.
   */
  const jaNaTela = new Set(agenda.recemEncerrados.map((r) => r.id));
  const linhasHistorico = paginasHistorico.flatMap((p) => p.reminders).filter((r) => !jaNaTela.has(r.id));

  /**
   * O contador do acervo, como o servidor contou.
   *
   * Ele vem no payload da lista VIVA, que NÃO é refeito depois de uma ação (de propósito
   * — refazer apagaria "Acabei de registrar"). Então logo depois do primeiro "Já tomei"
   * da vida ele ainda diz 0 enquanto a seção já tem uma linha baixada. Isso se conserta
   * sozinho na próxima abertura da aba, e o `CollapsibleSection` desenha os filhos sempre
   * que está aberto — nada fica escondido atrás do número. Grudar um `Math.max` aqui
   * inventaria uma contagem que ninguém fez, que é justamente o que `null` existe pra
   * evitar.
   */
  const totalNoAcervo = totalEncerrados;
  const faltamNoHistorico =
    totalNoAcervo !== null ? Math.max(totalNoAcervo - linhasHistorico.length, 0) : null;

  return (
    <Screen
      title="Lembretes"
      subtitle="o que você tem pra hoje"
      refreshControl={
        <RefreshControl refreshing={isRefetching} onRefresh={aoAtualizar} tintColor={colors.accentHi} />
      }
    >
      {erroDaAcao ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Fechar o aviso de erro"
          onPress={() => setErroDaAcao(null)}
          style={styles.erroBarra}
        >
          <Text style={styles.erroTexto}>{erroDaAcao}</Text>
          <X size={15} color={colors.dangerSoft} />
        </Pressable>
      ) : null}

      {agenda.atrasados > 0 && (
        <GlassCard style={styles.aviso}>
          <TriangleAlert size={18} color={colors.warn} />
          <Text style={styles.avisoTexto}>
            {agenda.atrasados === 1
              ? 'Tem 1 lembrete que passou da hora. Se já resolveu, me confirma aqui.'
              : `Tem ${agenda.atrasados} lembretes que passaram da hora. Se já resolveu, me confirma aqui.`}
          </Text>
        </GlassCard>
      )}

      {/* O acionável e o "+ Novo lembrete" são o herói da tela — antes de qualquer
          rolagem, e nunca só uma saudação. */}
      {formAberto ? (
        <NovoLembrete
          salvando={criar.isPending}
          erroServidor={criar.isError ? textoDoErro(criar.error) : null}
          onSalvar={salvar}
          onCancelar={fecharForm}
        />
      ) : (
        <GlassButton
          variant="primary"
          size="lg"
          icon={<Plus size={18} color="#ffffff" />}
          onPress={abrirForm}
          accessibilityLabel="Novo lembrete"
          style={styles.novo}
        >
          Novo lembrete
        </GlassButton>
      )}

      {/* O número é o que ESTÁ desenhado, e só ele.
          A resposta traz duas janelas que cortam de forma independente (o vencido e o que
          ainda vem), e `truncado` fica true se qualquer uma cortou — 20 vencidos + 3
          futuros viram 18 linhas. O teto de payload do servidor não descreve nada disso, e
          quando ele não vinha a frase chegava a dizer "estes são os 0 mais próximos". */}
      {data?.truncado && (
        <Text style={styles.truncado}>
          Você tem mais lembretes ativos do que eu mostro aqui de uma vez. Estes são os
          {' '}{lista.length} mais próximos — cancela os que já não usa e a lista volta a caber.
        </Text>
      )}

      {falhou ? (
        <LoadFailure
          erro={error}
          oQue="seus lembretes"
          tentando={isRefetching}
          onTentarDeNovo={aoAtualizar}
        />
      ) : nadaVivo ? (
        <GlassCard style={styles.vazio}>
          <EmptyState
            icon={<AlarmClock size={22} color={colors.textDim} />}
            title="Nada marcado por enquanto"
            hint={
              totalEncerrados && totalEncerrados > 0
                ? 'Nenhum lembrete ativo agora. Toque em “Novo lembrete” ali em cima, ou veja os já resolvidos logo abaixo.'
                : 'Toque em “Novo lembrete” ali em cima e eu te aviso na hora certa. O que você me pedir pelo WhatsApp também aparece aqui.'
            }
          />
        </GlassCard>
      ) : (
        <>
          {agenda.acionaveis.map((g) => (
            <View key={g.bloco}>
              <SectionHeader
                title={g.rotulo}
                size="sm"
                style={styles.secao}
                action={
                  g.bloco === 'atrasado' ? (
                    <GlassBadge tone="warn" size="xs">
                      {String(g.lembretes.length)}
                    </GlassBadge>
                  ) : undefined
                }
              />
              <View style={styles.lista}>
                {g.lembretes.map((r) => (
                  <ReminderCard
                    key={r.id}
                    lembrete={r}
                    bloco={g.bloco}
                    agoraMs={agora}
                    // Só a linha tocada trava. Desabilitar a tela inteira numa ação de
                    // 300ms faria o paciente achar que o app congelou.
                    ocupado={emAndamento && idEmAndamento === r.id}
                    onAgir={aoAgir}
                  />
                ))}
              </View>
            </View>
          ))}

          {/* O que o dedo acabou de tocar — e o que o WhatsApp já confirmou.
              A frase (`agiuAgora[r.id]`) só existe pro primeiro caso: é a resposta ao
              toque, e é o que substitui o cartão que antes sumia. */}
          {agenda.recemEncerrados.length > 0 && (
            <View>
              <SectionHeader title="Acabei de registrar" size="sm" style={styles.secao} />
              <View style={styles.lista}>
                {agenda.recemEncerrados.map((r) => (
                  <ReminderCard
                    key={r.id}
                    lembrete={r}
                    bloco="encerrado"
                    agoraMs={agora}
                    nota={agiuAgora[r.id]}
                    ocupado={emAndamento && idEmAndamento === r.id}
                    onAgir={aoAgir}
                  />
                ))}
              </View>
            </View>
          )}

          <CollapsibleSection
            title="Depois de hoje"
            count={agenda.totalFuturos}
            emptyHint="Nada marcado a partir de amanhã. Lembrete de todo dia aparece aqui com o horário do próximo."
          >
            {agenda.futuros.map((g) => (
              <View key={g.bloco}>
                <Text style={styles.subBloco}>{g.rotulo}</Text>
                <View style={styles.lista}>
                  {g.lembretes.map((r) => (
                    <ReminderCard
                      key={r.id}
                      lembrete={r}
                      bloco={g.bloco}
                      agoraMs={agora}
                      ocupado={emAndamento && idEmAndamento === r.id}
                      onAgir={aoAgir}
                    />
                  ))}
                </View>
              </View>
            ))}
          </CollapsibleSection>
        </>
      )}

      {/* O acervo. Fica FORA do `else` de propósito: mesmo quem não tem nada ativo tem
          direito de ver o que já resolveu — e o contador é o que prova que está guardado. */}
      <CollapsibleSection
        title="Já resolvidos"
        count={totalNoAcervo}
        onMudarAberta={setHistoricoAberto}
        emptyHint="Quando você confirmar ou cancelar um lembrete, ele fica registrado aqui — inclusive o que não deu certo."
      >
        {historico.isLoading ? (
          <Skeleton variant="line" height={44} />
        ) : historico.isError ? (
          <LoadFailure
            erro={historico.error}
            oQue="o histórico"
            tentando={historico.isFetching}
            onTentarDeNovo={() => void historico.refetch()}
          />
        ) : (
          <>
            {linhasHistorico.map((r) => (
              <HistoricoLinha key={r.id} lembrete={r} />
            ))}
            {historico.hasNextPage && (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Ver mais lembretes resolvidos"
                disabled={historico.isFetchingNextPage}
                onPress={() => {
                  void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                  void historico.fetchNextPage();
                }}
                style={styles.verMais}
              >
                <ChevronDown size={16} color={colors.accentHi} />
                <Text style={styles.verMaisTexto}>
                  {historico.isFetchingNextPage
                    ? 'carregando…'
                    : faltamNoHistorico
                      ? `ver mais · faltam ${faltamNoHistorico}`
                      : 'ver mais'}
                </Text>
              </Pressable>
            )}
          </>
        )}
      </CollapsibleSection>
    </Screen>
  );
}

const styles = StyleSheet.create({
  espaco: { height: 14 },
  aviso: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 14,
    marginBottom: 12,
    borderColor: 'rgba(251,191,36,0.25)',
    backgroundColor: 'rgba(251,191,36,0.06)',
  },
  avisoTexto: { flex: 1, color: colors.text, fontSize: FONTE_CLINICA, lineHeight: 19 },
  /** A mesma barra dispensável do chat — uma falha, uma forma de dizê-la. */
  erroBarra: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: 'rgba(248,113,113,0.35)',
    backgroundColor: 'rgba(248,113,113,0.12)',
  },
  erroTexto: { flex: 1, color: colors.dangerSoft, fontSize: FONTE_CLINICA, lineHeight: 19 },
  novo: { width: '100%' },
  truncado: { color: colors.textDim, fontSize: FONTE_MINIMA, lineHeight: 17, marginTop: 10 },
  vazio: { marginTop: 14 },
  secao: { marginTop: 22, marginBottom: 10 },
  subBloco: { color: colors.textDim, fontSize: FONTE_MINIMA, fontWeight: '600', marginBottom: 8, marginTop: 4 },
  lista: { gap: 10 },
  /** 44 de alvo pra um link que fica no fim de uma lista longa, alcançado com o polegar. */
  verMais: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    height: 44,
  },
  verMaisTexto: { color: colors.accentHi, fontSize: FONTE_CLINICA, fontWeight: '600' },
});
