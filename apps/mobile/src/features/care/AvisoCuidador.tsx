/**
 * 🤝 A linha que explica por que os botões de "falar com a Xarlote" estão apagados.
 *
 * Botão desabilitado calado é o defeito que o app já conserta em outros lugares (ver
 * `CartaoIdentidade`): quando a ação não serve, a tela DIZ o que falta. Aqui o que falta
 * é uma conversa que não é a de quem está logado — e a frase diz onde o pedido vale.
 *
 * Fica UMA vez por tela, no topo, e não uma cópia embaixo de cada botão: a Saúde tem seis
 * ações de seção mais uma por aviso, e sete repetições da mesma frase viram ruído que
 * ninguém lê. Some por completo quando é o próprio registro.
 */
import { StyleSheet, Text, View } from 'react-native';
import { Info } from 'lucide-react-native';
import { colors, FONTE_CLINICA, radii } from '@/theme';
import { useSujeito } from '@/lib/care/sujeito';
import { decidirFalarComXarlote } from './escrita';

export function AvisoCuidador() {
  const { pessoa, cuidandoDeOutro } = useSujeito();
  const decisao = decidirFalarComXarlote({ cuidandoDeOutro, nome: pessoa?.nome ?? null });
  if (decisao.pode || !decisao.aviso) return null;

  return (
    <View style={styles.faixa} accessibilityRole="summary">
      <Info size={15} color={colors.accentHi} />
      <Text style={styles.texto}>{decisao.aviso}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  /**
   * Superfície escrita à mão, não `GlassCard`: isto é um recado, não um cartão de
   * conteúdo, e a tela já tem o vidro do herói logo abaixo (teto de 2 superfícies).
   */
  faixa: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 9,
    marginBottom: 14,
    paddingHorizontal: 13,
    paddingVertical: 11,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: 'rgba(124,135,255,0.28)',
    backgroundColor: 'rgba(124,135,255,0.10)',
  },
  texto: { flex: 1, color: colors.textDim, fontSize: FONTE_CLINICA, lineHeight: 19 },
});
