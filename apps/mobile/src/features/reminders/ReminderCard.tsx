/**
 * Uma linha de lembrete VIVO, com as três ações.
 *
 * ## Cartão é só pra quem pede ação
 *
 * Este componente desenha atraso, hoje e os próximos — o que o paciente ainda pode
 * resolver. Lembrete encerrado NÃO passa por aqui: ele é uma linha
 * (`HistoricoLinha.tsx`), porque cartão completo com três botões desabilitados e
 * `opacity: 0.6` não é hierarquia, é o mesmo objeto ilegível. A única exceção é o que
 * ACABOU de ser resolvido nesta sessão, que continua em cartão de propósito: a
 * confirmação tem que ficar onde o dedo estava.
 *
 * ## Cancelar pede confirmação; confirmar e adiar não
 *
 * A assimetria é deliberada. "Feito" e "+30min" são reversíveis (o lembrete volta na
 * próxima ocorrência, ou 30 minutos depois); cancelar é terminal no servidor — não há
 * como o paciente desfazer. Um toque errado no cancelar apaga um remédio da agenda de
 * quem depende dele pra lembrar. Foi o que motivou a auditoria do `cancel_reminders`
 * como "curinga sobre a agenda do paciente" (A3).
 *
 * ## Sem blur, sem specular, sem sombra
 *
 * `GlassCard` entra com os três ornamentos no default `false`: esta é uma linha de lista
 * que rola, e cada camada de preenchimento é cobrada por linha, animando ou não.
 */
import { memo, useCallback } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import * as Haptics from 'expo-haptics';
import { AlarmClock, Ban, Check, Clock3, Pill, Stethoscope, TestTube } from 'lucide-react-native';
import type { ReminderAppAction } from '@iasaude/shared';
import { GlassBadge, GlassCard } from '@/components/ui';
import { colors, folgaDeToque, FONTE_CLINICA, radii } from '@/theme';
import { brQuando } from '@/lib/br-format';
import type { ReminderRow } from '@/features/health/overview';
import { acoesDisponiveis, rotuloDoTipo, type BlocoLembrete } from './format';

interface Props {
  lembrete: ReminderRow;
  bloco: BlocoLembrete;
  agoraMs: number;
  ocupado?: boolean;
  /**
   * A frase que a Xarlote diz sobre o que ACABOU de acontecer com este lembrete —
   * "Anotado, o de hoje está feito.", "Te chamo de novo em 30 minutos."
   *
   * Existe porque a confirmação tem que ficar ONDE O DEDO ESTAVA. Um remédio de todo dia
   * confirmado volta `pending` com a data de amanhã: sem a frase, o único retorno do
   * toque seria o háptico, e o cartão mudaria de bloco em silêncio. `fraseDaAcao` em
   * `format.ts` é quem a escreve.
   */
  nota?: string;
  onAgir: (id: string, acao: ReminderAppAction, minutos?: number) => void;
}

function IconeDoTipo({ tipo }: { tipo: string | null | undefined }) {
  const cor = colors.accentHi;
  if (tipo === 'medication' || tipo === 'medication_backup' || tipo === 'refill') return <Pill size={15} color={cor} />;
  if (tipo === 'appointment') return <Stethoscope size={15} color={cor} />;
  if (tipo === 'exam') return <TestTube size={15} color={cor} />;
  return <AlarmClock size={15} color={cor} />;
}

export const ReminderCard = memo(function ReminderCard({ lembrete, bloco, agoraMs, ocupado, nota, onAgir }: Props) {
  const acoes = acoesDisponiveis(lembrete);
  const quando = brQuando(lembrete.next_run_at ?? lembrete.scheduled_at, agoraMs);

  const cancelar = useCallback(() => {
    Alert.alert(
      'Cancelar este lembrete?',
      'Eu paro de te avisar sobre ele. Isso não dá pra desfazer aqui — mas você pode criar outro a qualquer momento.',
      [
        { text: 'Manter', style: 'cancel' },
        { text: 'Cancelar lembrete', style: 'destructive', onPress: () => onAgir(lembrete.id, 'cancel') },
      ],
    );
  }, [lembrete.id, onAgir]);

  return (
    <GlassCard style={styles.card}>
      <View style={styles.topo}>
        <View style={styles.icone}>
          <IconeDoTipo tipo={lembrete.type} />
        </View>
        <View style={styles.textos}>
          <Text style={styles.titulo} numberOfLines={2}>
            {lembrete.title?.trim() || rotuloDoTipo(lembrete.type)}
          </Text>
          {/* Logo abaixo do título, antes da posologia: é a resposta ao toque, e resposta
              ao toque vem antes de qualquer outra leitura. */}
          {nota ? <Text style={styles.nota}>{nota}</Text> : null}
          {lembrete.body?.trim() ? (
            <Text style={styles.corpo} numberOfLines={3}>
              {lembrete.body.trim()}
            </Text>
          ) : null}
          <View style={styles.metaLinha}>
            {quando ? (
              // "era hoje às 08:00" no bloco de atraso: sem o verbo no passado, a mesma
              // frase que anuncia o futuro anuncia o que já passou, e a pessoa lê como
              // se ainda fosse acontecer.
              <Text style={[styles.quando, bloco === 'atrasado' && styles.quandoAtrasado]}>
                {bloco === 'atrasado' ? `era ${quando}` : quando}
              </Text>
            ) : null}
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
            icone={<Check size={15} color={colors.success} />}
            cor={colors.success}
            desabilitado={ocupado}
            onPress={() => onAgir(lembrete.id, 'done')}
          />
          <Botao
            rotulo="+30 min"
            icone={<Clock3 size={15} color={colors.textDim} />}
            cor={colors.textDim}
            desabilitado={ocupado}
            onPress={() => onAgir(lembrete.id, 'snooze', 30)}
          />
          <Botao
            rotulo="Cancelar"
            icone={<Ban size={15} color={colors.textDim} />}
            cor={colors.textDim}
            desabilitado={ocupado}
            onPress={cancelar}
          />
        </View>
      )}
    </GlassCard>
  );
});

/** Altura real do alvo antes da folga. `folgaDeToque` fecha a conta até os 44pt. */
const ALTURA_BOTAO = 36;

/**
 * Botão de ação inline.
 *
 * Não é o `GlassButton`: aqui são três alvos lado a lado dentro de uma linha de lista, e
 * o primitivo do design system tem fundo e borda pensados pra botão de tela. Forçá-lo
 * aqui daria três blocos gordos onde deveria haver três toques discretos.
 *
 * O que ele NÃO pode economizar é o alvo e o háptico: `folgaDeToque(36)` leva os 36pt de
 * altura aos 44 mínimos, e a vibração leve é o único retorno que o dedo tem de que
 * "Já tomei" foi registrado — a resposta da rede pode levar segundos.
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
      onPress={() => {
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        onPress();
      }}
      disabled={desabilitado}
      hitSlop={folgaDeToque(ALTURA_BOTAO)}
      style={({ pressed }) => [styles.botao, (desabilitado || pressed) && styles.botaoApagado]}
      accessibilityRole="button"
      accessibilityLabel={rotulo}
      accessibilityState={{ disabled: !!desabilitado }}
    >
      {icone}
      <Text style={[styles.botaoTexto, { color: cor }]}>{rotulo}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: { padding: 14, gap: 10 },
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
  titulo: { color: colors.text, fontSize: 15, fontWeight: '600', lineHeight: 20 },
  /** Dose e instrução de uso: 13px é o piso, não uma preferência. Era 12. */
  corpo: { color: colors.textDim, fontSize: FONTE_CLINICA, lineHeight: 19 },
  /**
   * A confirmação é a Xarlote FALANDO — contraste cheio, não metadado apagado. Quem
   * acabou de tocar em "Já tomei" está lendo exatamente esta linha pra saber se
   * registrou.
   */
  nota: { color: colors.text, fontSize: FONTE_CLINICA, lineHeight: 19, fontWeight: '500' },
  metaLinha: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 4, flexWrap: 'wrap' },
  /** O HORÁRIO da dose. Era 11px — o dado mais consultado da tela, no menor tamanho. */
  quando: { color: colors.accentHi, fontSize: FONTE_CLINICA, fontWeight: '600' },
  quandoAtrasado: { color: colors.warn },
  acoes: {
    flexDirection: 'row',
    gap: 16,
    paddingTop: 6,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.glassBorder,
  },
  botao: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    minHeight: ALTURA_BOTAO,
    paddingRight: 4,
  },
  botaoTexto: { fontSize: FONTE_CLINICA, fontWeight: '600' },
  botaoApagado: { opacity: 0.4 },
});
