/**
 * Saúde 360 — o prontuário do paciente na mão dele.
 *
 * ## A ordem das seções não é estética
 *
 * Alergias vêm ANTES de medicamentos e condições. É o dado que muda conduta numa
 * emergência, e é o que alguém vai procurar às pressas — inclusive um médico com o
 * celular do paciente na mão (o link do médico, na F4, mostra este mesmo conteúdo).
 * Adesão vem no topo porque é a única coisa aqui que o paciente pode mudar hoje.
 *
 * ## Estado vazio que FALA
 *
 * Cada seção sem dado explica como o dado entra ("me manda uma foto do exame"), em vez
 * de sumir. Seção que desaparece faz o paciente concluir que o app não tem aquilo —
 * quando na verdade ele é que ainda não contou. É a regra do estado vazio que fala.
 */
import { useCallback, useMemo, useState } from 'react';
import { RefreshControl, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import {
  Activity,
  ChevronRight,
  FlaskConical,
  HeartPulse,
  Pill,
  ShieldAlert,
  Stethoscope,
  TriangleAlert,
} from 'lucide-react-native';
import { adherenceLabel } from '@iasaude/shared';
import { EmptyState, GlassBadge, GlassCard, LoadFailure, SectionHeader, Skeleton } from '@/components/ui';
import { Screen } from '@/components/xarlote/Screen';
import { AdherenceChart } from '@/features/health/AdherenceChart';
import { useOverview } from '@/features/health/use-overview';
import {
  detalheDoMedicamento,
  ordenarAlergias,
  resumoAdesao,
  tarjaDoMedicamento,
  tomDaSeveridade,
} from '@/features/health/overview';
import { brData, brDiaMes } from '@/lib/br-format';
import { colors } from '@/theme';

export default function SaudeScreen() {
  const { data, isLoading, isRefetching, isError, error, refetch } = useOverview();
  const router = useRouter();
  // `agora` congelado por render: usado por várias funções puras nesta tela, e um
  // Date.now() por chamada faria dois rótulos da MESMA tela discordarem na virada do dia.
  const [agora] = useState(() => Date.now());

  const adesao = useMemo(
    () => (data ? resumoAdesao(data.medicationLog, 30, agora) : null),
    [data, agora],
  );
  const alergias = useMemo(() => (data ? ordenarAlergias(data.allergies) : []), [data]);

  const aoAtualizar = useCallback(() => void refetch(), [refetch]);

  if (isLoading && !data) {
    return (
      <Screen title="Saúde" subtitle="seu histórico, organizado">
        <Skeleton variant="card" height={150} />
        <View style={styles.espaco} />
        <Skeleton variant="card" height={110} />
        <View style={styles.espaco} />
        <Skeleton variant="card" height={110} />
      </Screen>
    );
  }

  /**
   * Numa falha de carregamento, esta tela é a MAIS perigosa das três.
   *
   * Ela tem seis seções, cada uma com o seu estado vazio. Sem esta saída antecipada, um
   * erro de rede produziria "Nenhuma alergia registrada", "Nenhum medicamento em uso" e
   * "Nenhum exame guardado" de uma vez — seis afirmações falsas sobre o prontuário de
   * alguém, na mesma tela. Uma mensagem de falha honesta vale mais que seis mentiras
   * bem formatadas.
   */
  if (isError && !data) {
    return (
      <Screen title="Saúde" subtitle="seu histórico, organizado">
        <LoadFailure
          erro={error}
          oQue="seu histórico"
          tentando={isRefetching}
          onTentarDeNovo={aoAtualizar}
        />
      </Screen>
    );
  }

  const exames = data?.examResults ?? [];
  const medicamentos = data?.medications ?? [];
  const condicoes = data?.conditions ?? [];
  const prescritores = data?.prescribers ?? [];

  return (
    <Screen
      title="Saúde"
      subtitle="seu histórico, organizado"
      refreshControl={
        <RefreshControl refreshing={isRefetching} onRefresh={aoAtualizar} tintColor={colors.accentHi} />
      }
    >
      {/* ── Adesão ─────────────────────────────────────────────────────────── */}
      <GlassCard style={styles.cardAdesao} blur>
        <SectionHeader
          icon={<Activity size={16} color={colors.accentHi} />}
          title="Como você vem seguindo"
          subtitle={adesao ? adherenceLabel(adesao.score) : undefined}
        />
        {adesao && adesao.diasComRegistro > 0 ? (
          <View style={styles.grafico}>
            <AdherenceChart serie={adesao.serie} />
          </View>
        ) : (
          <Text style={styles.vazioInline}>
            Ainda não tenho doses registradas. Quando eu te lembrar de um remédio e você
            responder, o histórico começa a aparecer aqui.
          </Text>
        )}
      </GlassCard>

      {/* ── Alergias (primeiro de propósito) ───────────────────────────────── */}
      <SectionHeader
        icon={<ShieldAlert size={16} color={colors.danger} />}
        title="Alergias"
        subtitle={alergias.length > 0 ? 'o que eu nunca vou sugerir pra você' : undefined}
        style={styles.secao}
      />
      {alergias.length === 0 ? (
        <GlassCard>
          <EmptyState
            icon={<ShieldAlert size={20} color={colors.textFaint} />}
            title="Nenhuma alergia registrada"
            hint="Se você tem alergia a algum medicamento, me conta no chat — eu guardo e passo a considerar isso em tudo."
          />
        </GlassCard>
      ) : (
        <View style={styles.lista}>
          {alergias.map((a) => (
            <GlassCard key={a.id} style={styles.linha}>
              <View style={styles.linhaTextos}>
                <Text style={styles.linhaTitulo}>{a.substance}</Text>
                {a.reaction ? <Text style={styles.linhaHint}>{a.reaction}</Text> : null}
              </View>
              {a.severity ? (
                <GlassBadge tone={tomDaSeveridade(a.severity)} size="xs">
                  {a.severity}
                </GlassBadge>
              ) : (
                // Gravidade desconhecida é DITA, não omitida: silêncio aqui seria lido
                // como "é leve", e a ordenação já trata desconhecido como risco médio.
                <GlassBadge tone="neutral" size="xs">
                  gravidade a confirmar
                </GlassBadge>
              )}
            </GlassCard>
          ))}
        </View>
      )}

      {/* ── Medicamentos ───────────────────────────────────────────────────── */}
      <SectionHeader
        icon={<Pill size={16} color={colors.accentHi} />}
        title="Meus medicamentos"
        subtitle={medicamentos.length > 0 ? `${medicamentos.length} em uso` : undefined}
        style={styles.secao}
      />
      {medicamentos.length === 0 ? (
        <GlassCard>
          <EmptyState
            icon={<Pill size={20} color={colors.textFaint} />}
            title="Nenhum medicamento em uso"
            hint="Me diz o que você toma e com que frequência — eu monto os lembretes e cuido das recompras."
          />
        </GlassCard>
      ) : (
        <View style={styles.lista}>
          {medicamentos.map((m) => {
            const tarja = tarjaDoMedicamento(m);
            return (
              <GlassCard key={m.id} style={styles.linha}>
                <View style={styles.linhaTextos}>
                  <Text style={styles.linhaTitulo}>{m.medication_name}</Text>
                  <Text style={styles.linhaHint}>{detalheDoMedicamento(m)}</Text>
                </View>
                {tarja ? (
                  <GlassBadge tone={tarja.tom} size="xs">
                    {tarja.rotulo}
                  </GlassBadge>
                ) : null}
              </GlassCard>
            );
          })}
        </View>
      )}

      {/* ── Exames ─────────────────────────────────────────────────────────── */}
      <SectionHeader
        icon={<FlaskConical size={16} color={colors.info} />}
        title="Meus exames"
        subtitle={exames.length > 0 ? `${exames.length} guardado${exames.length > 1 ? 's' : ''}` : undefined}
        style={styles.secao}
        action={
          exames.length > 0 ? (
            <Text style={styles.verTudo} onPress={() => router.push('/exames')}>
              ver todos
            </Text>
          ) : undefined
        }
      />
      {exames.length === 0 ? (
        <GlassCard>
          <EmptyState
            icon={<FlaskConical size={20} color={colors.textFaint} />}
            title="Nenhum exame guardado ainda"
            hint="Me manda a foto do resultado no chat. Eu leio, organizo por data e guardo aqui pra você não precisar procurar em papel."
          />
        </GlassCard>
      ) : (
        <View style={styles.lista}>
          {exames.slice(0, 3).map((e) => (
            <GlassCard key={e.id} style={styles.linha} interactive onPress={() => router.push(`/exames/${e.id}`)}>
              <View style={styles.linhaTextos}>
                <Text style={styles.linhaTitulo}>{e.title?.trim() || e.exam_type}</Text>
                <Text style={styles.linhaHint}>{brData(e.exam_date) || 'data não identificada'}</Text>
              </View>
              <ChevronRight size={16} color={colors.textFaint} />
            </GlassCard>
          ))}
        </View>
      )}

      {/* ── Condições ──────────────────────────────────────────────────────── */}
      {condicoes.length > 0 && (
        <>
          <SectionHeader
            icon={<HeartPulse size={16} color={colors.auroraPink} />}
            title="Condições de saúde"
            style={styles.secao}
          />
          <View style={styles.lista}>
            {condicoes.map((c) => (
              <GlassCard key={c.id} style={styles.linha}>
                <View style={styles.linhaTextos}>
                  <Text style={styles.linhaTitulo}>{c.name}</Text>
                  {c.notes ? (
                    <Text style={styles.linhaHint} numberOfLines={2}>
                      {c.notes}
                    </Text>
                  ) : null}
                </View>
                {/* `active` é booleano — a coluna `status` que eu supus não existe.
                    "Em acompanhamento" só é dito quando é VERDADE. */}
                {c.active ? (
                  <GlassBadge tone="accent" size="xs">
                    em acompanhamento
                  </GlassBadge>
                ) : c.active === false ? (
                  <GlassBadge tone="neutral" size="xs">
                    resolvida
                  </GlassBadge>
                ) : null}
              </GlassCard>
            ))}
          </View>
        </>
      )}

      {/* ── Médicos ────────────────────────────────────────────────────────── */}
      {prescritores.length > 0 && (
        <>
          <SectionHeader
            icon={<Stethoscope size={16} color={colors.accentHi} />}
            title="Meus médicos"
            style={styles.secao}
          />
          <View style={styles.lista}>
            {prescritores.map((p) => (
              <GlassCard key={p.id} style={styles.linha}>
                <View style={styles.linhaTextos}>
                  <Text style={styles.linhaTitulo}>{p.name}</Text>
                  <Text style={styles.linhaHint}>
                    {[p.specialty, p.crm ? `CRM ${p.crm}${p.crm_state ? `/${p.crm_state}` : ''}` : null]
                      .filter(Boolean)
                      .join(' · ') || 'sem detalhes'}
                  </Text>
                </View>
              </GlassCard>
            ))}
          </View>
        </>
      )}

      {/* ── Sintomas recentes ──────────────────────────────────────────────── */}
      {(data?.symptoms.length ?? 0) > 0 && (
        <>
          <SectionHeader
            icon={<TriangleAlert size={16} color={colors.warn} />}
            title="O que você me contou"
            subtitle="sintomas registrados"
            style={styles.secao}
          />
          <GlassCard style={styles.sintomas}>
            {data!.symptoms.slice(0, 8).map((s) => (
              <View key={s.id} style={styles.sintomaLinha}>
                <Text style={styles.sintomaData}>{brDiaMes(s.created_at)}</Text>
                <Text style={styles.sintomaNome} numberOfLines={1}>
                  {s.name}
                </Text>
                {typeof s.intensity === 'number' ? (
                  <Text style={styles.sintomaIntensidade}>{s.intensity}/10</Text>
                ) : null}
              </View>
            ))}
          </GlassCard>
        </>
      )}

      {/* O rodapé médico-legal: a Xarlote NUNCA diagnostica, e a tela diz isso. */}
      <Text style={styles.rodape}>
        Isto é um histórico organizado, não um diagnóstico. Em caso de emergência, ligue
        192 (SAMU).
      </Text>
    </Screen>
  );
}

const styles = StyleSheet.create({
  espaco: { height: 14 },
  cardAdesao: { padding: 16, gap: 14 },
  grafico: { marginTop: 2 },
  vazioInline: { color: colors.textFaint, fontSize: 12, lineHeight: 18 },
  secao: { marginTop: 30, marginBottom: 12 },
  lista: { gap: 10 },
  linha: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: 14 },
  linhaTextos: { flex: 1, gap: 2 },
  linhaTitulo: { color: colors.text, fontSize: 14, fontWeight: '600' },
  linhaHint: { color: colors.textFaint, fontSize: 11, lineHeight: 16 },
  verTudo: { color: colors.accentHi, fontSize: 12, fontWeight: '600' },
  sintomas: { padding: 14, gap: 10 },
  sintomaLinha: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  sintomaData: { color: colors.textFaint, fontSize: 11, width: 42 },
  sintomaNome: { color: colors.textDim, fontSize: 13, flex: 1 },
  sintomaIntensidade: { color: colors.warn, fontSize: 11, fontWeight: '600' },
  rodape: {
    color: colors.textFaint,
    fontSize: 10,
    lineHeight: 15,
    marginTop: 32,
    textAlign: 'center',
    paddingHorizontal: 20,
  },
});
