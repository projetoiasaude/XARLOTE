/**
 * A foto em tela cheia.
 *
 * Existe por um motivo de leitura, não de vitrine: a bolha tem 82% da largura da tela, o
 * que basta pra reconhecer uma foto e não basta pra LER um laudo. O valor de referência
 * de um hemograma tem dois dígitos e um ponto; num retângulo de 232px ele é uma mancha.
 *
 * `contentFit="contain"` e nada de recorte: o laudo inteiro, com as margens, do jeito que
 * o papel é. Recortar aqui esconderia justamente a linha que a pessoa procura.
 */
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { Image } from 'expo-image';
import { X } from 'lucide-react-native';
import { colors, FONTE_CLINICA } from '@/theme';

interface Props {
  url: string | null;
  onFechar: () => void;
}

export function VisorFoto({ url, onFechar }: Props) {
  return (
    <Modal visible={url !== null} animationType="fade" transparent={false} onRequestClose={onFechar}>
      <View style={styles.fundo}>
        {url ? (
          <Image source={{ uri: url }} style={styles.foto} contentFit="contain" transition={0} />
        ) : null}

        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Fechar a foto"
          onPress={onFechar}
          hitSlop={12}
          style={styles.fechar}
        >
          <X size={22} color={colors.text} />
        </Pressable>

        <Text style={styles.dica}>Toque no X pra voltar à conversa</Text>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  fundo: { flex: 1, backgroundColor: '#04041a', justifyContent: 'center' },
  foto: { width: '100%', height: '82%' },
  /** 48×48: fechar é o único caminho de saída daqui e não pode ser um alvo apertado. */
  fechar: {
    position: 'absolute',
    top: 52,
    right: 18,
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.12)',
    borderWidth: 1,
    borderColor: colors.glassBorderHi,
  },
  dica: { color: colors.textDim, fontSize: FONTE_CLINICA, textAlign: 'center', marginTop: 12 },
});
