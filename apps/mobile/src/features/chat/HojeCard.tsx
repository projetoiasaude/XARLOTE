/**
 * O card **Hoje** — a resposta de "o que eu faço agora?", em zero toque.
 *
 * ## Por que ele existe no chat, e não na aba de Lembretes
 *
 * A queixa era que a navegação obrigava a passear pelo app pra saber o que fazer. A
 * resposta não é duplicar menu: é **matar a razão de navegar**. A primeira tela do app
 * abria com uma saudação ("Boa tarde, Maria") e nada mais — bonito e vazio. Quem toma
 * quatro remédios não abre um app de saúde pra ser cumprimentado; abre pra saber se já
 * tomou o das 8h.
 *
 * A dose que passou da hora e ninguém viu é a origem mecânica da adesão de 44% do
 * Arthur. O bloco "Passou da hora" na aba de Lembretes resolveu a visibilidade PARA QUEM
 * ABRE A ABA. Este card resolve pra quem abre o app.
 *
 * ## Um item, nunca a lista
 *
 * Mostra o MAIS urgente e só ele — atrasado ganha de hoje. Uma lista aqui competiria com
 * a própria aba de Lembretes e empurraria a conversa pra baixo da dobra. Se houver mais,
 * o card diz quantos e a aba continua sendo o lugar deles.
 *
 * ## Quando não há nada, ele DESAPARECE
 *
 * Único lugar do app onde some por design, e a razão é específica: aqui "nada pendente"
 * já é dito pela conversa que aparece embaixo. Um cartão anunciando "nada a fazer" todo
 * dia treina a pessoa a ignorar o topo da tela — e no dia em que houver uma dose
 * atrasada, ela ignora essa também. O estado vazio desta pergunta é a ausência do card.
 */
import { memo, useCallback } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { AlarmClock, Check, Clock3 } from 'lucide-react-native';
import { GlassButton } from '@/components/ui';
import { colors, FONTE_CLINICA, radii } from '@/theme';
import { brQuando } from '@/lib/br-format';
import type { ReminderRow } from '@/features/health/overview';
import { acoesDisponiveis, blocoDoLembrete, rotuloDoTipo } from '@/features/reminders/format';
import { useReminderAction, useReminders } from '@/features/reminders/use-reminders';

/** O que pede ação AGORA: atrasado primeiro, depois hoje. Nada mais entra. */
function maisUrgente(
  lembretes: readonly ReminderRow[],
  agoraMs: number,
): { alvo: ReminderRow; atrasado: boolean; total: number } | null {
  const atrasados: ReminderRow[] = [];
  const deHoje: ReminderRow[] = [];
  for (const r of lembretes) {
    if (acoesDisponiveis(r).length === 0) continue;
    const bloco = blocoDoLembrete(r, agoraMs);
    if (bloco === 'atrasado') atrasados.push(r);
    else if (bloco === 'hoje') deHoje.push(r);
  }
  const fila = atrasados.length > 0 ? atrasados : deHoje;
  const alvo = fila[0];
  if (!alvo) return null;
  return { alvo, atrasado: atrasados.length > 0, total: atrasados.length + deHoje.length };
}

interface Props {
  /**
   * O instante de referência, vindo de FORA.
   *
   * A tela do chat reavalia quando o app volta do background (ela já faz isso pela
   * saudação). Congelar o relógio aqui, na montagem, faria uma dose que vence às 8h com
   * a tela montada às 7h nunca migrar pra "passou da hora" — e é exatamente esse bloco
   * que o card existe pra antecipar.
   */
  agoraMs: number;
}

export const HojeCard = memo(function HojeCard({ agoraMs }: Props) {
  /**
   * 🤝 `doProprio` — este card é SEMPRE de quem está logado, nunca de quem ele cuida.
   *
   * Duas razões, e as duas são de leitura errada: (1) a conversa embaixo é a do titular
   * do JWT, então um "Já tomei" da mãe no topo de um chat que é da filha é a dose no
   * prontuário errado por um toque; (2) esta tela não usa a moldura `Screen`, então aqui
   * NÃO existe o chip "Você está no registro de X" — a única pista da troca não chega.
   *
   * Os lembretes de quem se cuida continuam na aba de Lembretes, que tem o chip e manda
   * `?subject=` em toda ação.
   */
  const { data, isError } = useReminders({ doProprio: true });
  const { agir, emAndamento, idEmAndamento } = useReminderAction({ doProprio: true });

  const feito = useCallback((id: string) => agir(id, 'done'), [agir]);
  const adiar = useCallback((id: string) => agir(id, 'snooze', 30), [agir]);

  // Falha de leitura NÃO vira "nada pendente". A tela diz o que sabe e o que não sabe:
  // silêncio aqui seria a mesma mentira de um estado vazio sobre uma resposta 404.
  if (isError) {
    return (
      <View style={styles.card}>
        <Text style={styles.avisoFalha}>Não consegui ver seus lembretes agora.</Text>
      </View>
    );
  }

  const urgente = data ? maisUrgente(data.reminders, agoraMs) : null;
  if (!urgente) return null;

  const { alvo, atrasado, total } = urgente;
  const ocupado = emAndamento && idEmAndamento === alvo.id;
  const titulo = alvo.title?.trim() || rotuloDoTipo(alvo.type);
  const quando = brQuando(alvo.next_run_at ?? alvo.scheduled_at, agoraMs);

  return (
    <View style={[styles.card, atrasado && styles.cardAtrasado]}>
      <View style={styles.topo}>
        <AlarmClock size={16} color={atrasado ? colors.warn : colors.accentHi} />
        <Text style={[styles.rotulo, atrasado && styles.rotuloAtrasado]}>
          {atrasado ? 'PASSOU DA HORA' : 'AGORA'}
        </Text>
        {total > 1 ? <Text style={styles.resto}>+{total - 1} pra hoje</Text> : null}
      </View>

      <Text style={styles.titulo} numberOfLines={2}>
        {titulo}
      </Text>
      {quando ? <Text style={styles.quando}>{quando}</Text> : null}

      <View style={styles.acoes}>
        <GlassButton
          variant="success"
          size="lg"
          onPress={() => feito(alvo.id)}
          loading={ocupado}
          icon={<Check size={17} color={colors.textOnFill} />}
          accessibilityLabel={`Marcar ${titulo} como já tomado`}
          style={styles.botaoPrincipal}
        >
          Já tomei
        </GlassButton>
        <GlassButton
          variant="secondary"
          size="lg"
          onPress={() => adiar(alvo.id)}
          disabled={ocupado}
          icon={<Clock3 size={16} color={colors.textDim} />}
          accessibilityLabel={`Me lembrar de ${titulo} em 30 minutos`}
        >
          +30 min
        </GlassButton>
      </View>
    </View>
  );
});

const styles = StyleSheet.create({
  /**
   * Superfície escrita à mão em vez de `GlassCard`: este é o único bloco de tela cheia
   * acima da conversa, e ele não pode empilhar mais uma camada de vidro com sombra e
   * degradê sobre o fundo aurora — são no máximo 2 superfícies de tela cheia por tela.
   */
  card: {
    marginHorizontal: 16,
    marginBottom: 10,
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderRadius: radii.xl,
    borderWidth: 1,
    borderColor: 'rgba(124,135,255,0.28)',
    backgroundColor: 'rgba(124,135,255,0.10)',
  },
  cardAtrasado: { borderColor: 'rgba(251,191,36,0.32)', backgroundColor: 'rgba(251,191,36,0.10)' },
  topo: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  rotulo: { color: colors.accentHi, fontSize: 12, fontWeight: '700', letterSpacing: 1 },
  rotuloAtrasado: { color: colors.warn },
  resto: { color: colors.textDim, fontSize: 12, marginLeft: 'auto' },
  titulo: { color: colors.text, fontSize: 18, fontWeight: '600', marginTop: 6, letterSpacing: -0.3 },
  /** Horário é dado clínico: 14px, nunca 11. É por ele que a pessoa decide se já tomou. */
  quando: { color: colors.textDim, fontSize: 14, marginTop: 2 },
  acoes: { flexDirection: 'row', gap: 10, marginTop: 12 },
  botaoPrincipal: { flexGrow: 1 },
  avisoFalha: { color: colors.textDim, fontSize: FONTE_CLINICA },
});
