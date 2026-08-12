/**
 * Lembretes — remédios, consultas e exames, com as ações que o paciente já tinha no
 * WhatsApp agora a um toque.
 *
 * ## Por que "passou da hora" é o primeiro bloco
 *
 * O caso Arthur (adesão de 44%) não foi falta de lembrete: foi lembrete que passou e
 * ninguém viu que tinha passado. O bloco de atraso no topo, com contagem, é a resposta
 * de tela pra isso — e é a única seção que a tela destaca com cor.
 *
 * ## O estado vazio não mente sobre o WhatsApp
 *
 * Quem não tem lembrete aqui continua recebendo pelo WhatsApp; a frase diz isso. Dizer
 * "você não tem lembretes" seria falso pra quem tem e apenas ainda não sincronizou.
 */
import { useCallback, useMemo, useState } from 'react';
import { RefreshControl, StyleSheet, Text, View } from 'react-native';
import { AlarmClock, TriangleAlert } from 'lucide-react-native';
import { EmptyState, GlassBadge, GlassCard, LoadFailure, SectionHeader, Skeleton } from '@/components/ui';
import { Screen } from '@/components/xarlote/Screen';
import { ReminderCard } from '@/features/reminders/ReminderCard';
import { agruparLembretes } from '@/features/reminders/format';
import { useReminderAction, useReminders } from '@/features/reminders/use-reminders';
import { colors } from '@/theme';

export default function LembretesScreen() {
  const { data, isLoading, isRefetching, isError, error, refetch } = useReminders();
  const { agir, emAndamento, idEmAndamento } = useReminderAction();
  const [agora] = useState(() => Date.now());

  const grupos = useMemo(
    () => agruparLembretes(data?.reminders ?? [], agora),
    [data?.reminders, agora],
  );

  const atrasados = grupos.find((g) => g.bloco === 'atrasado')?.lembretes.length ?? 0;
  const aoAtualizar = useCallback(() => void refetch(), [refetch]);

  if (isLoading && !data) {
    return (
      <Screen title="Lembretes" subtitle="remédios, consultas e exames">
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
  const vazio = !falhou && grupos.length === 0;

  return (
    <Screen
      title="Lembretes"
      subtitle="remédios, consultas e exames"
      refreshControl={
        <RefreshControl refreshing={isRefetching} onRefresh={aoAtualizar} tintColor={colors.accentHi} />
      }
    >
      {atrasados > 0 && (
        <GlassCard style={styles.aviso}>
          <TriangleAlert size={18} color={colors.warn} />
          <Text style={styles.avisoTexto}>
            {atrasados === 1
              ? 'Tem 1 lembrete que passou da hora. Se já resolveu, me confirma aqui.'
              : `Tem ${atrasados} lembretes que passaram da hora. Se já resolveu, me confirma aqui.`}
          </Text>
        </GlassCard>
      )}

      {falhou ? (
        <LoadFailure
          erro={error}
          oQue="seus lembretes"
          tentando={isRefetching}
          onTentarDeNovo={aoAtualizar}
        />
      ) : vazio ? (
        <GlassCard>
          <EmptyState
            icon={<AlarmClock size={22} color={colors.textFaint} />}
            title="Nenhum lembrete por aqui"
            hint="Seus lembretes do WhatsApp aparecem nesta tela. Me pede um no chat — “me lembra do losartana todo dia às 8” — e ele nasce aqui."
          />
        </GlassCard>
      ) : (
        grupos.map((g) => (
          <View key={g.bloco}>
            <SectionHeader
              title={g.rotulo}
              size="sm"
              style={styles.secao}
              action={
                g.bloco === 'atrasado' ? (
                  <GlassBadge tone="warn" size="xs">
                    {g.lembretes.length}
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
                  onAgir={agir}
                />
              ))}
            </View>
          </View>
        ))
      )}
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
    marginBottom: 8,
    borderColor: 'rgba(251,191,36,0.25)',
    backgroundColor: 'rgba(251,191,36,0.06)',
  },
  avisoTexto: { flex: 1, color: colors.text, fontSize: 12, lineHeight: 18 },
  secao: { marginTop: 22, marginBottom: 10 },
  lista: { gap: 10 },
});
