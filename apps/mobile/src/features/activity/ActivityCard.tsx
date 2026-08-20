/**
 * Um pedido ou consulta VIVO, com as etapas visíveis e a saída do lado.
 *
 * A etapa `esperando` desenhada como círculo VAZIO, e a `agora` com o ponto cheio,
 * dizem duas coisas diferentes que a mesma cor esconderia: "a bola está com você" e
 * "estou trabalhando nisso". `parado` é um traço — nem falha vermelha alarmante, nem
 * pendência que finge estar viva.
 *
 * ## Nada aqui pulsa, e a mudança é deliberada
 *
 * Este cartão instanciava o `StatusPing` duas vezes (um por etapa `agora`, um dentro do
 * badge "em andamento") e nunca passava `pulse` — que nascia `true`. Um paciente com 4
 * pedidos abertos carregava 6-8 `withRepeat(-1)` simultâneos dentro de linha de lista, o
 * mesmo padrão que custou o dia 18/08 pra tirar do fundo e do OrbNav. "Em andamento" dura
 * HORAS: não é estado transiente, é estado normal, e estado normal é cor parada. Os
 * defaults dos primitivos já foram invertidos; aqui o `pulse={false}` fica EXPLÍCITO pra
 * que reativar isso um dia seja uma decisão visível no diff, não um default herdado.
 *
 * ## O cartão só existe pra quem está vivo
 *
 * Encerrado virou `ActivityLine`. Cartão é o que pede ação; linha é o que só registra.
 */
import { memo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { GlassBadge, GlassButton, GlassCard, StatusPing } from '@/components/ui';
import { colors, FONTE_CLINICA, FONTE_MINIMA, radii } from '@/theme';
import { desdeNoPassado, type Atividade, type Etapa } from './timeline';

interface Props {
  atividade: Atividade;
  agoraMs: number;
  /** Chamado com a ação derivada — a tela decide se navega ou manda mensagem. */
  onAcao: (atividade: Atividade) => void;
  /** Este cartão tem um envio em voo. */
  ocupado?: boolean;
}

function Marcador({ estado }: { estado: Etapa['estado'] }) {
  if (estado === 'feito') {
    return <View style={[styles.marcador, styles.marcadorFeito]} />;
  }
  if (estado === 'agora') {
    return (
      <View style={styles.marcadorAgora}>
        <StatusPing tone="success" size="md" pulse={false} />
      </View>
    );
  }
  if (estado === 'parado') {
    return <View style={styles.marcadorParado} />;
  }
  return <View style={[styles.marcador, styles.marcadorEsperando]} />;
}

export const ActivityCard = memo(function ActivityCard({ atividade, agoraMs, onAcao, ocupado }: Props) {
  // `desdeNoPassado`, não `brDesde` cru: carimbo no futuro não pode virar "agora".
  const desde = desdeNoPassado(atividade.atualizadoEm ?? atividade.criadoEm, agoraMs);

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
          <GlassBadge tone="live" size="xs" dot pulse={false}>
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

      {atividade.acao ? (
        <GlassButton
          variant={atividade.esperandoVoce ? 'primary' : 'secondary'}
          size="md"
          style={styles.botao}
          loading={ocupado ?? false}
          onPress={() => onAcao(atividade)}
          accessibilityLabel={`${atividade.acao.rotulo}: ${atividade.titulo}`}
        >
          {atividade.acao.rotulo}
        </GlassButton>
      ) : null}

      {desde ? <Text style={styles.desde}>atualizado {desde}</Text> : null}
    </GlassCard>
  );
});

const styles = StyleSheet.create({
  card: { padding: 16, gap: 14 },
  cabecalho: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  cabecalhoTextos: { flex: 1, gap: 3 },
  titulo: { color: colors.text, fontSize: 16, fontWeight: '600', lineHeight: 21 },
  resumo: { color: colors.textDim, fontSize: FONTE_CLINICA, lineHeight: 18 },
  etapas: { gap: 0 },
  etapa: { flexDirection: 'row', gap: 12 },
  trilha: { width: 12, alignItems: 'center' },
  fio: { flex: 1, width: StyleSheet.hairlineWidth, backgroundColor: colors.glassBorder, minHeight: 14 },
  marcador: { width: 9, height: 9, borderRadius: radii.full, marginTop: 5 },
  marcadorFeito: { backgroundColor: colors.accent },
  marcadorEsperando: {
    backgroundColor: 'transparent',
    borderWidth: 1.5,
    borderColor: 'rgba(255,255,255,0.28)',
  },
  marcadorParado: { width: 9, height: 2, borderRadius: 1, backgroundColor: 'rgba(255,255,255,0.24)', marginTop: 9 },
  marcadorAgora: { marginTop: 3 },
  etapaTextos: { flex: 1, paddingBottom: 12, gap: 2 },
  // Preço, farmácia e horário saem daqui: é dado que decide compra, piso de 13px.
  etapaRotulo: { color: colors.textDim, fontSize: FONTE_CLINICA, lineHeight: 18 },
  etapaFeita: { color: colors.text },
  etapaAgora: { color: colors.accentHi, fontWeight: '600' },
  etapaParada: { color: colors.textFaint },
  etapaDetalhe: { color: colors.textDim, fontSize: FONTE_CLINICA, lineHeight: 18 },
  botao: { height: 44, alignSelf: 'flex-start' },
  desde: { color: colors.textFaint, fontSize: FONTE_MINIMA },
});
