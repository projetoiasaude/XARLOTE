/**
 * Um pedido ou consulta ENCERRADO, em uma linha.
 *
 * ## Por que uma linha, e não o cartão com `opacity: 0.6`
 *
 * O servidor manda até 10 pedidos e 5 consultas. Desenhados como cartão completo — título,
 * resumo, quatro etapas com marcadores e detalhes, "atualizado há X" — são até quinze
 * paredes de passos mortos entre o paciente e o único item que pede algo dele. E
 * `opacity: 0.6` não é hierarquia: é o mesmo objeto, do mesmo tamanho, ilegível.
 *
 * A escada do projeto: **encerrado é linha, pede ação é cartão, pede leitura é tela.**
 * Aqui fica a linha — título, desfecho em uma palavra, e quando. Continua visível de
 * propósito: esconder o que não deu certo é o erro mais grave dos dois, porque o paciente
 * conclui que nada aconteceu quando o que houve foi um fracasso que ele tem o direito de
 * ver.
 *
 * Não é tocável, e isso é escolha: não existe tela de detalhe de pedido encerrado. Uma
 * linha que afunda ao toque e não leva a lugar nenhum é affordance falsa — decore o que
 * age, não o que informa.
 */
import { memo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { colors, FONTE_CLINICA, FONTE_MINIMA, radii } from '@/theme';
import { desdeNoPassado, type Atividade } from './timeline';

interface Props {
  atividade: Atividade;
  agoraMs: number;
}

const COR_DESFECHO = {
  success: colors.success,
  neutral: colors.textFaint,
  warn: colors.warn,
} as const;

export const ActivityLine = memo(function ActivityLine({ atividade, agoraMs }: Props) {
  const desde = desdeNoPassado(atividade.atualizadoEm ?? atividade.criadoEm, agoraMs);
  const tom = atividade.desfecho?.tom ?? 'neutral';

  return (
    <View style={styles.linha} accessibilityRole="text">
      <View style={[styles.ponto, { backgroundColor: COR_DESFECHO[tom] }]} />
      <Text style={styles.titulo} numberOfLines={1}>
        {atividade.titulo}
      </Text>
      {atividade.desfecho ? (
        <Text style={[styles.desfecho, { color: COR_DESFECHO[tom] }]}>{atividade.desfecho.rotulo}</Text>
      ) : null}
      {desde ? <Text style={styles.quando}>{desde}</Text> : null}
    </View>
  );
});

const styles = StyleSheet.create({
  linha: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: radii.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.glassBorder,
  },
  ponto: { width: 7, height: 7, borderRadius: radii.full, opacity: 0.8 },
  titulo: { color: colors.textDim, fontSize: FONTE_CLINICA, flexShrink: 1 },
  desfecho: { fontSize: FONTE_MINIMA, fontWeight: '600', flexGrow: 1 },
  quando: { color: colors.textFaint, fontSize: FONTE_MINIMA },
});
