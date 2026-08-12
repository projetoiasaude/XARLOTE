/**
 * Uma linha de lembrete com as três ações.
 *
 * ## Cancelar pede confirmação; confirmar e adiar não
 *
 * A assimetria é deliberada. "Feito" e "+30min" são reversíveis (o lembrete volta na
 * próxima ocorrência, ou 30 minutos depois); cancelar é terminal no servidor — não há
 * como o paciente desfazer. Um toque errado no cancelar apaga um remédio da agenda de
 * quem depende dele pra lembrar. Foi o que motivou a auditoria do `cancel_reminders`
 * como "curinga sobre a agenda do paciente" (A3).
 *
 * ## Sem blur aqui
 *
 * `GlassCard` com `blur` fica de fora de propósito: esta é uma linha de lista que rola,
 * e blur em linha que rola é o caminho mais curto pra derrubar o frame rate no Android.
 */
import { memo, useCallback } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { AlarmClock, Ban, Check, Clock3, Pill, Stethoscope, TestTube } from 'lucide-react-native';
import type { ReminderAppAction } from '@iasaude/shared';
import { GlassBadge, GlassCard } from '@/components/ui';
import { colors, radii } from '@/theme';
import { brQuando } from '@/lib/br-format';
import type { ReminderRow } from '@/features/health/overview';
import { acoesDisponiveis, rotuloDoTipo, type BlocoLembrete } from './format';

interface Props {
  lembrete: ReminderRow;
  bloco: BlocoLembrete;
  agoraMs: number;
  ocupado?: boolean;
  onAgir: (id: string, acao: ReminderAppAction, minutos?: number) => void;
}

function IconeDoTipo({ tipo }: { tipo: string | null | undefined }) {
  const cor = colors.accentHi;
  if (tipo === 'medication' || tipo === 'medication_backup' || tipo === 'refill') return <Pill size={15} color={cor} />;
  if (tipo === 'appointment') return <Stethoscope size={15} color={cor} />;
  if (tipo === 'exam') return <TestTube size={15} color={cor} />;
  return <AlarmClock size={15} color={cor} />;
}

export const ReminderCard = memo(function ReminderCard({ lembrete, bloco, agoraMs, ocupado, onAgir }: Props) {
  const acoes = acoesDisponiveis(lembrete);
  const quando = brQuando(lembrete.next_run_at ?? lembrete.scheduled_at, agoraMs);
  const encerrado = bloco === 'encerrado';

  const cancelar = useCallback(() => {
    Alert.alert(
      'Cancelar este lembrete?',
      'Eu paro de te avisar sobre ele. Isso não dá pra desfazer aqui — mas você pode me pedir um novo a qualquer momento.',
      [
        { text: 'Manter', style: 'cancel' },
        { text: 'Cancelar lembrete', style: 'destructive', onPress: () => onAgir(lembrete.id, 'cancel') },
      ],
    );
  }, [lembrete.id, onAgir]);

  return (
    <GlassCard style={[styles.card, encerrado && styles.cardEncerrado]}>
      <View style={styles.topo}>
        <View style={styles.icone}>
          <IconeDoTipo tipo={lembrete.type} />
        </View>
        <View style={styles.textos}>
          <Text style={styles.titulo} numberOfLines={2}>
            {lembrete.title?.trim() || rotuloDoTipo(lembrete.type)}
          </Text>
          {lembrete.body?.trim() ? (
            <Text style={styles.corpo} numberOfLines={3}>
              {lembrete.body.trim()}
            </Text>
          ) : null}
          <View style={styles.metaLinha}>
            {quando ? <Text style={styles.quando}>{quando}</Text> : null}
            {lembrete.rrule ? (
              <GlassBadge tone="neutral" size="xs">
                todo dia
              </GlassBadge>
            ) : null}
            {lembrete.status === 'cancelled' ? (
              <GlassBadge tone="neutral" size="xs">
                cancelado
              </GlassBadge>
            ) : null}
            {lembrete.status === 'acknowledged' ? (
              <GlassBadge tone="success" size="xs">
                feito
              </GlassBadge>
            ) : null}
          </View>
        </View>
      </View>

      {acoes.length > 0 && (
        <View style={styles.acoes}>
          <Botao
            rotulo="Já tomei"
            icone={<Check size={14} color={colors.success} />}
            cor={colors.success}
            desabilitado={ocupado}
            onPress={() => onAgir(lembrete.id, 'done')}
          />
          <Botao
            rotulo="+30 min"
            icone={<Clock3 size={14} color={colors.textDim} />}
            cor={colors.textDim}
            desabilitado={ocupado}
            onPress={() => onAgir(lembrete.id, 'snooze', 30)}
          />
          <Botao
            rotulo="Cancelar"
            icone={<Ban size={14} color={colors.textFaint} />}
            cor={colors.textFaint}
            desabilitado={ocupado}
            onPress={cancelar}
          />
        </View>
      )}
    </GlassCard>
  );
});

/**
 * Botão de ação inline.
 *
 * Não é o `GlassButton`: aqui são três alvos pequenos lado a lado dentro de uma linha
 * de lista, e o primitivo do design system tem padding e sombra pensados pra botão de
 * tela. Forçá-lo aqui daria três blocos gordos onde deveria haver três toques discretos.
 */
function Botao({
  rotulo,
  icone,
  cor,
  desabilitado,
  onPress,
}: {
  rotulo: string;
  icone: React.ReactNode;
  cor: string;
  desabilitado?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={desabilitado}
      // O alvo de toque cresce além do texto: três ações lado a lado numa linha de
      // lista, com dedo grande e celular na mão, erram fácil sem essa folga.
      hitSlop={10}
      style={({ pressed }) => [styles.botao, (desabilitado || pressed) && styles.botaoApagado]}
      accessibilityRole="button"
      accessibilityLabel={rotulo}
    >
      {icone}
      <Text style={[styles.botaoTexto, { color: cor }]}>{rotulo}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: { padding: 14, gap: 12 },
  cardEncerrado: { opacity: 0.55 },
  topo: { flexDirection: 'row', gap: 12 },
  icone: {
    width: 30,
    height: 30,
    borderRadius: radii.md,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(124,135,255,0.12)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(124,135,255,0.22)',
  },
  textos: { flex: 1, gap: 3 },
  titulo: { color: colors.text, fontSize: 14, fontWeight: '600', lineHeight: 19 },
  corpo: { color: colors.textDim, fontSize: 12, lineHeight: 17 },
  metaLinha: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 3, flexWrap: 'wrap' },
  quando: { color: colors.accentHi, fontSize: 11, fontWeight: '600' },
  acoes: {
    flexDirection: 'row',
    gap: 18,
    paddingTop: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.glassBorder,
  },
  botao: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 4 },
  botaoTexto: { fontSize: 12, fontWeight: '600' },
  botaoApagado: { opacity: 0.4 },
});
