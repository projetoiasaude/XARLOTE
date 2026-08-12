/**
 * Atividade — "o que a Xarlote está fazendo por você agora".
 *
 * O gargalo de conversão que a auditoria de 03/08 achou tinha uma causa mecânica (a
 * mensagem nunca chegava à farmácia) e uma causa de percepção: o paciente pedia o
 * remédio e, do lado dele, nada acontecia. Esta tela é o antídoto da segunda — passos
 * verificáveis, com o preço e o nome da farmácia quando existem, e um "sua vez" quando
 * a bola está com ele.
 *
 * Todas as etapas saem de `timeline.ts` (puro): a tela não deduz progresso, só desenha
 * o que a função derivou dos dados.
 */
import { useCallback, useMemo, useState } from 'react';
import { RefreshControl, StyleSheet, Text, View } from 'react-native';
import { Zap } from 'lucide-react-native';
import { EmptyState, GlassCard, LoadFailure, SectionHeader, Skeleton } from '@/components/ui';
import { Screen } from '@/components/xarlote/Screen';
import { ActivityCard } from '@/features/activity/ActivityCard';
import { montarAtividades } from '@/features/activity/timeline';
import { useOverview } from '@/features/health/use-overview';
import { colors } from '@/theme';

export default function AtividadeScreen() {
  const { data, isLoading, isRefetching, isError, error, refetch } = useOverview();
  const [agora] = useState(() => Date.now());

  const atividades = useMemo(
    () => (data ? montarAtividades(data.orders, data.consultations, agora) : []),
    [data, agora],
  );

  const vivas = atividades.filter((a) => a.viva);
  const encerradas = atividades.filter((a) => !a.viva);
  const aoAtualizar = useCallback(() => void refetch(), [refetch]);

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
          />
        </GlassCard>
      ) : (
        <>
          {vivas.length > 0 && (
            <View style={styles.lista}>
              {vivas.map((a) => (
                <ActivityCard key={`${a.tipo}-${a.id}`} atividade={a} agoraMs={agora} />
              ))}
            </View>
          )}

          {encerradas.length > 0 && (
            <>
              <SectionHeader
                title="Já encerrados"
                size="sm"
                subtitle="fica registrado, mesmo o que não deu certo"
                style={styles.secao}
              />
              <View style={styles.lista}>
                {encerradas.map((a) => (
                  <View key={`${a.tipo}-${a.id}`} style={styles.apagado}>
                    <ActivityCard atividade={a} agoraMs={agora} />
                  </View>
                ))}
              </View>
            </>
          )}

          {vivas.length === 0 && (
            <Text style={styles.rodape}>
              Nada em andamento no momento. É só me chamar no chat quando precisar.
            </Text>
          )}
        </>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  espaco: { height: 14 },
  lista: { gap: 12 },
  secao: { marginTop: 28, marginBottom: 12 },
  apagado: { opacity: 0.6 },
  rodape: { color: colors.textFaint, fontSize: 12, lineHeight: 18, marginTop: 24, textAlign: 'center' },
});
