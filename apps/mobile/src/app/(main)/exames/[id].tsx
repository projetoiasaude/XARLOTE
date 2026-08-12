/**
 * Um exame por inteiro.
 *
 * A tela lê do cache do overview em vez de buscar por id: quem chega aqui vem da
 * biblioteca, que acabou de listar o exame — uma segunda ida à rede pra buscar um dado
 * que já está na memória atrasaria a abertura sem nada em troca. Se o cache não tiver
 * (link direto, app reaberto por notificação), o overview carrega e a tela preenche.
 *
 * ## Nada é escondido por não caber no formato
 *
 * `values` é JSONB livre — o extrator grava o que consegue ler do laudo. `paresDoExame`
 * lida com objeto, lista e texto solto; o que não casa com nenhum formato aparece como
 * observação. O princípio: o paciente pode ver TUDO que guardamos dele, mesmo o que
 * ficou torto (é o mesmo compromisso da portabilidade LGPD).
 */
import { useMemo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { ArrowLeft, FlaskConical } from 'lucide-react-native';
import { EmptyState, GlassBadge, GlassCard, LoadFailure, SectionHeader, Skeleton } from '@/components/ui';
import { Screen } from '@/components/xarlote/Screen';
import { useOverview } from '@/features/health/use-overview';
import { paresDoExame } from '@/features/health/overview';
import { brDataLonga } from '@/lib/br-format';
import { colors, radii } from '@/theme';

const ROTULO_ORIGEM: Record<string, string> = {
  photo: 'lido de uma foto que você mandou',
  whatsapp: 'recebido pelo WhatsApp',
  app: 'enviado pelo app',
  manual: 'anotado manualmente',
  self_reported: 'você me contou',
};

export default function ExameScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { data, isLoading, isRefetching, isError, error, refetch } = useOverview();
  const router = useRouter();

  const exame = useMemo(() => data?.examResults.find((e) => e.id === id) ?? null, [data, id]);
  const pares = useMemo(() => (exame ? paresDoExame(exame.findings) : []), [exame]);

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <Screen>
        <Pressable onPress={() => router.back()} hitSlop={12} style={styles.voltar} accessibilityRole="button">
          <ArrowLeft size={14} color={colors.textDim} />
          <Text style={styles.voltarTexto}>voltar</Text>
        </Pressable>

        {isLoading && !exame ? (
          <>
            <Skeleton variant="line" height={26} width="70%" />
            <View style={styles.espaco} />
            <Skeleton variant="card" height={160} />
          </>
        ) : isError && !data ? (
          // Falha de carregamento NÃO é "exame não existe": um diz tenta de novo, o
          // outro diz que o dado sumiu. Confundir os dois assusta sem motivo.
          <LoadFailure
            erro={error}
            oQue="este exame"
            tentando={isRefetching}
            onTentarDeNovo={() => void refetch()}
          />
        ) : !exame ? (
          <GlassCard>
            <EmptyState
              icon={<FlaskConical size={22} color={colors.textFaint} />}
              title="Não encontrei este exame"
              hint="Ele pode ter sido apagado. Volta pra biblioteca e confere a lista atual."
            />
          </GlassCard>
        ) : (
          <>
            <View style={styles.cabecalho}>
              <Text style={styles.tipo}>{exame.title?.trim() || exame.exam_type}</Text>
              {exame.title?.trim() && exame.title.trim() !== exame.exam_type ? (
                <Text style={styles.subtipo}>{exame.exam_type}</Text>
              ) : null}
              <Text style={styles.data}>{brDataLonga(exame.exam_date) || 'data não identificada'}</Text>
              {exame.source ? (
                <GlassBadge tone="neutral" size="xs" style={styles.origem}>
                  {ROTULO_ORIGEM[exame.source] ?? exame.source}
                </GlassBadge>
              ) : null}
            </View>

            {pares.length > 0 && (
              <>
                <SectionHeader title="Resultados" size="sm" style={styles.secao} />
                <GlassCard style={styles.tabela} blur>
                  {pares.map((p, i) => (
                    <View key={`${p.rotulo}-${i}`} style={[styles.par, i > 0 && styles.parComLinha]}>
                      <Text style={styles.parRotulo}>{p.rotulo}</Text>
                      <Text style={styles.parValor}>{p.valor}</Text>
                    </View>
                  ))}
                </GlassCard>
              </>
            )}

            {exame.summary?.trim() ? (
              <>
                <SectionHeader title="Observações" size="sm" style={styles.secao} />
                <GlassCard style={styles.notas}>
                  <Text style={styles.notasTexto}>{exame.summary!.trim()}</Text>
                </GlassCard>
              </>
            ) : null}

            {pares.length === 0 && !exame.summary?.trim() ? (
              <GlassCard style={styles.secao}>
                <EmptyState
                  icon={<FlaskConical size={20} color={colors.textFaint} />}
                  title="Sem valores extraídos"
                  hint="Registrei este exame mas não consegui ler os números do laudo. Se quiser, me manda a foto de novo com mais luz — eu tento outra vez."
                />
              </GlassCard>
            ) : null}

            {/* O limite do que esta tela é. Vale mais aqui do que na Saúde 360: um
                número de exame na tela convida à autointerpretação. */}
            <Text style={styles.rodape}>
              Eu organizo e guardo — quem interpreta é o seu médico. Nenhum valor aqui é
              diagnóstico.
            </Text>
          </>
        )}
      </Screen>
    </>
  );
}

const styles = StyleSheet.create({
  voltar: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 18, alignSelf: 'flex-start' },
  voltarTexto: { color: colors.textDim, fontSize: 13 },
  espaco: { height: 14 },
  cabecalho: { gap: 6, marginBottom: 8 },
  tipo: { color: colors.text, fontSize: 24, fontWeight: '700', letterSpacing: -0.4 },
  subtipo: { color: colors.textFaint, fontSize: 12 },
  data: { color: colors.textDim, fontSize: 13 },
  origem: { alignSelf: 'flex-start', marginTop: 4 },
  secao: { marginTop: 26, marginBottom: 10 },
  tabela: { paddingHorizontal: 16, paddingVertical: 4 },
  par: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, paddingVertical: 12 },
  parComLinha: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.glassBorder },
  parRotulo: { color: colors.textDim, fontSize: 13, flex: 1, textTransform: 'capitalize' },
  parValor: { color: colors.text, fontSize: 13, fontWeight: '600', textAlign: 'right', maxWidth: '55%' },
  notas: { padding: 16, borderRadius: radii.xl },
  notasTexto: { color: colors.textDim, fontSize: 13, lineHeight: 20 },
  rodape: { color: colors.textFaint, fontSize: 10, lineHeight: 15, marginTop: 30, textAlign: 'center' },
});
