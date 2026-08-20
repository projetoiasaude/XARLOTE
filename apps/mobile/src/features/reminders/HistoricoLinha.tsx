/**
 * Um lembrete encerrado — em LINHA, não em cartão.
 *
 * A regra de densidade do projeto: "encerrado é linha, pede ação é cartão, pede leitura
 * é tela". O histórico não pede nada: ele existe pra o paciente poder olhar pra trás e
 * ver que a Xarlote registrou — inclusive o que não deu certo. Desenhá-lo como cartão
 * completo (ícone com fundo, três botões, badges) punia quem usa mais o app: quinze
 * cartões mortos entre a pessoa e a dose de hoje.
 *
 * `opacity: 0.6` num cartão inteiro NÃO era hierarquia — era o mesmo objeto, ilegível.
 * Linha com um ponto colorido e o desfecho escrito diz mais, em um terço da altura.
 *
 * Nenhuma sombra, nenhum degradê, nenhum blur: é o item que mais se repete na tela.
 */
import { memo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { colors, FONTE_CLINICA, FONTE_MINIMA } from '@/theme';
import { brData } from '@/lib/br-format';
import type { ReminderRow } from '@/features/health/overview';
import { linhaHistorico, rotuloDoTipo } from './format';

interface Props {
  lembrete: ReminderRow;
}

export const HistoricoLinha = memo(function HistoricoLinha({ lembrete }: Props) {
  const { desfecho, quandoIso, positivo } = linhaHistorico(lembrete);
  const data = brData(quandoIso);

  return (
    <View style={styles.linha}>
      <View style={[styles.ponto, positivo ? styles.pontoOk : styles.pontoNeutro]} />
      <View style={styles.textos}>
        <Text style={styles.titulo} numberOfLines={1}>
          {lembrete.title?.trim() || rotuloDoTipo(lembrete.type)}
        </Text>
        <Text style={styles.meta}>
          {/* `data` vazia acontece com dado torto; a linha mostra só o desfecho em vez
              de um separador solto pendurado no fim da frase. */}
          {data ? `${desfecho} · ${data}` : desfecho}
        </Text>
      </View>
    </View>
  );
});

const styles = StyleSheet.create({
  linha: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.glassBorder,
  },
  ponto: { width: 7, height: 7, borderRadius: 4 },
  pontoOk: { backgroundColor: colors.success },
  pontoNeutro: { backgroundColor: 'rgba(255,255,255,0.28)' },
  textos: { flex: 1, gap: 1 },
  /** 13px mesmo em linha de acervo: é o nome de um remédio, não um metadado. */
  titulo: { color: colors.text, fontSize: FONTE_CLINICA, fontWeight: '500' },
  meta: { color: colors.textDim, fontSize: FONTE_MINIMA },
});
