/**
 * Biblioteca de exames — por mês, do mais recente pro mais antigo.
 *
 * A tabela `user_exam_results` existe desde a migration 0014 e até aqui só alimentava a
 * memória da Xarlote: o paciente mandava a foto do laudo, nós leríamos e guardávamos, e
 * ele nunca mais via aquilo organizado. Esta tela é a primeira superfície desse dado —
 * a razão pela qual `examResults` entrou no `buildOverview`.
 *
 * Exame sem data legível NÃO é escondido: cai num grupo "sem data" no fim. Um exame que
 * existe e não aparece é pior do que um exame com data incerta.
 */
import { useCallback, useMemo, useState } from 'react';
import { RefreshControl, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { ChevronRight, FlaskConical } from 'lucide-react-native';
import { EmptyState, GlassCard, LoadFailure, SectionHeader, Skeleton } from '@/components/ui';
import { Screen } from '@/components/xarlote/Screen';
import { useOverview } from '@/features/health/use-overview';
import { agruparExamesPorMes, paresDoExame } from '@/features/health/overview';
import { brData, brMesAno } from '@/lib/br-format';
import { colors, radii } from '@/theme';

export default function ExamesScreen() {
  const { data, isLoading, isRefetching, isError, error, refetch } = useOverview();
  const router = useRouter();

  const grupos = useMemo(
    () => agruparExamesPorMes(data?.examResults ?? [], brMesAno),
    [data?.examResults],
  );

  const aoAtualizar = useCallback(() => void refetch(), [refetch]);

  if (isLoading && !data) {
    return (
      <Screen voltar title="Exames" subtitle="tudo que você me mandou">
        <Skeleton variant="card" height={80} />
        <View style={styles.espaco} />
        <Skeleton variant="card" height={80} />
      </Screen>
    );
  }

  const total = data?.examResults.length ?? 0;

  return (
    <Screen
      // Subtela de Saúde, e não destino do orb: sem o voltar, a única saída é abrir o menu
      // e escolher de novo — o que faz a pessoa achar que entrou num lugar sem retorno.
      voltar
      title="Exames"
      subtitle={total > 0 ? `${total} guardado${total > 1 ? 's' : ''}` : 'tudo que você me mandou'}
      refreshControl={
        <RefreshControl refreshing={isRefetching} onRefresh={aoAtualizar} tintColor={colors.accentHi} />
      }
    >
      {isError && !data ? (
        <LoadFailure
          erro={error}
          oQue="seus exames"
          tentando={isRefetching}
          onTentarDeNovo={aoAtualizar}
        />
      ) : grupos.length === 0 ? (
        <GlassCard>
          <EmptyState
            icon={<FlaskConical size={22} color={colors.textFaint} />}
            title="Nenhum exame ainda"
            hint="Manda a foto do resultado no chat. Eu leio, identifico o tipo, organizo por data e guardo aqui — pra você nunca mais procurar em papel."
          />
        </GlassCard>
      ) : (
        grupos.map((g) => (
          <View key={g.rotulo}>
            <SectionHeader title={g.rotulo} size="sm" style={styles.secao} />
            <View style={styles.lista}>
              {g.exames.map((e) => {
                const pares = paresDoExame(e.findings);
                return (
                  <GlassCard
                    key={e.id}
                    style={styles.linha}
                    interactive
                    onPress={() => router.push(`/exames/${e.id}`)}
                  >
                    <View style={styles.icone}>
                      <FlaskConical size={15} color={colors.info} />
                    </View>
                    <View style={styles.textos}>
                      <Text style={styles.titulo} numberOfLines={1}>
                        {e.title?.trim() || e.exam_type}
                      </Text>
                      <Text style={styles.hint}>
                        {[
                          brData(e.exam_date) || 'data não identificada',
                          pares.length > 0
                            ? `${pares.length} ${pares.length === 1 ? 'medida' : 'medidas'}`
                            : null,
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      </Text>
                    </View>
                    <ChevronRight size={16} color={colors.textFaint} />
                  </GlassCard>
                );
              })}
            </View>
          </View>
        ))
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  espaco: { height: 12 },
  secao: { marginTop: 20, marginBottom: 10 },
  lista: { gap: 10 },
  linha: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14 },
  icone: {
    width: 30,
    height: 30,
    borderRadius: radii.md,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(56,189,248,0.12)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(56,189,248,0.22)',
  },
  textos: { flex: 1, gap: 2 },
  titulo: { color: colors.text, fontSize: 14, fontWeight: '600' },
  hint: { color: colors.textFaint, fontSize: 11 },
});
