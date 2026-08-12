/**
 * Um pedido ou consulta como cartão com as etapas visíveis.
 *
 * A etapa `esperando` desenhada como círculo VAZIO, e a `agora` com um ponto pulsando,
 * dizem duas coisas diferentes que a mesma cor esconderia: "a bola está com você" e
 * "estou trabalhando nisso". `parado` é um traço — nem falha vermelha alarmante, nem
 * pendência que finge estar viva.
 */
import { memo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { GlassBadge, GlassCard, StatusPing } from '@/components/ui';
import { colors, radii } from '@/theme';
import { brDesde } from '@/lib/br-format';
import type { Atividade, Etapa } from './timeline';

interface Props {
  atividade: Atividade;
  agoraMs: number;
}

function Marcador({ estado }: { estado: Etapa['estado'] }) {
  if (estado === 'feito') {
    return <View style={[styles.marcador, styles.marcadorFeito]} />;
  }
  if (estado === 'agora') {
    return (
      <View style={styles.marcadorAgora}>
        <StatusPing tone="success" />
      </View>
    );
  }
  if (estado === 'parado') {
    return <View style={styles.marcadorParado} />;
  }
  return <View style={[styles.marcador, styles.marcadorEsperando]} />;
}

export const ActivityCard = memo(function ActivityCard({ atividade, agoraMs }: Props) {
  const desde = brDesde(atividade.atualizadoEm ?? atividade.criadoEm, agoraMs);

  return (
    <GlassCard style={styles.card}>
      <View style={styles.cabecalho}>
        <View style={styles.cabecalhoTextos}>
          <Text style={styles.titulo} numberOfLines={2}>
            {atividade.titulo}
          </Text>
          <Text style={styles.resumo}>{atividade.resumo}</Text>
        </View>
        {atividade.esperandoVoce ? (
          <GlassBadge tone="warn" size="xs">
            sua vez
          </GlassBadge>
        ) : atividade.viva ? (
          <GlassBadge tone="live" size="xs" dot>
            em andamento
          </GlassBadge>
        ) : null}
      </View>

      <View style={styles.etapas}>
        {atividade.etapas.map((e, i) => (
          <View key={e.chave} style={styles.etapa}>
            <View style={styles.trilha}>
              <Marcador estado={e.estado} />
              {/* O fio só entre etapas — depois da última ele apontaria pro vazio. */}
              {i < atividade.etapas.length - 1 && <View style={styles.fio} />}
            </View>
            <View style={styles.etapaTextos}>
              <Text
                style={[
                  styles.etapaRotulo,
                  e.estado === 'feito' && styles.etapaFeita,
                  e.estado === 'agora' && styles.etapaAgora,
                  e.estado === 'parado' && styles.etapaParada,
                ]}
              >
                {e.rotulo}
              </Text>
              {e.detalhe ? <Text style={styles.etapaDetalhe}>{e.detalhe}</Text> : null}
            </View>
          </View>
        ))}
      </View>

      {desde ? <Text style={styles.desde}>atualizado {desde}</Text> : null}
    </GlassCard>
  );
});

const styles = StyleSheet.create({
  card: { padding: 16, gap: 14 },
  cabecalho: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  cabecalhoTextos: { flex: 1, gap: 3 },
  titulo: { color: colors.text, fontSize: 15, fontWeight: '600', lineHeight: 20 },
  resumo: { color: colors.textDim, fontSize: 12, lineHeight: 17 },
  etapas: { gap: 0 },
  etapa: { flexDirection: 'row', gap: 12 },
  trilha: { width: 12, alignItems: 'center' },
  fio: { flex: 1, width: StyleSheet.hairlineWidth, backgroundColor: colors.glassBorder, minHeight: 14 },
  marcador: { width: 9, height: 9, borderRadius: radii.full, marginTop: 4 },
  marcadorFeito: { backgroundColor: colors.accent },
  marcadorEsperando: {
    backgroundColor: 'transparent',
    borderWidth: 1.5,
    borderColor: 'rgba(255,255,255,0.22)',
  },
  marcadorParado: { width: 9, height: 2, borderRadius: 1, backgroundColor: 'rgba(255,255,255,0.18)', marginTop: 8 },
  marcadorAgora: { marginTop: 2 },
  etapaTextos: { flex: 1, paddingBottom: 12, gap: 2 },
  etapaRotulo: { color: colors.textDim, fontSize: 13, lineHeight: 18 },
  etapaFeita: { color: colors.text },
  etapaAgora: { color: colors.accentHi, fontWeight: '600' },
  etapaParada: { color: colors.textFaint },
  etapaDetalhe: { color: colors.textFaint, fontSize: 11, lineHeight: 16 },
  desde: { color: colors.textFaint, fontSize: 10 },
});
