/**
 * A bolha de mensagem.
 *
 * A da Xarlote nasce da esquerda com o vidro do design system; a do paciente vem da
 * direita em accent sólido. Duas escolhas que parecem estética e não são:
 *
 * · **Sem blur** na bolha, mesmo no iOS. Ela vive dentro de uma lista que rola, e a
 *   regra do projeto (src/theme/glass.ts) é blur só em superfície parada.
 * · O status de envio é **texto e ícone**, não só cor: "enviando…" e "não enviou,
 *   toque pra tentar" precisam ser legíveis por quem não distingue tons.
 */
import { memo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { AlertCircle, Clock, Mic } from 'lucide-react-native';
import { colors, radii } from '@/theme';
import type { ChatItem } from './merge';

/** "14:32" pelo relógio do aparelho — é o fuso em que o paciente está. */
function hora(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

interface Props {
  item: ChatItem;
  onRetry: (clientId: string) => void;
}

export const Bubble = memo(function Bubble({ item, onRetry }: Props) {
  // A direção vem do BANCO e é uma só: `in` = o paciente falando, `out` = a Xarlote
  // respondendo. A bolha otimista já nasce com `in` (ver merge.ts), então este lado
  // nunca muda quando a confirmação chega — a mensagem não salta de lado.
  const doPaciente = item.direction === 'in';
  const falhou = item.status === 'failed';
  const enviando = item.status === 'pending';

  const corpo = (
    <View style={[styles.bubble, doPaciente ? styles.minha : styles.dela, falhou && styles.falhou]}>
      {item.contentType === 'audio' && (
        <View style={styles.audioTag}>
          <Mic size={12} color={doPaciente ? 'rgba(255,255,255,0.75)' : colors.textDim} />
          <Text style={[styles.audioTexto, doPaciente && styles.textoMinha]}>áudio</Text>
        </View>
      )}

      {item.text ? (
        <Text style={[styles.texto, doPaciente && styles.textoMinha]}>{item.text}</Text>
      ) : (
        <Text style={[styles.texto, styles.semTexto, doPaciente && styles.textoMinha]}>
          {item.contentType === 'image' ? 'imagem' : 'mensagem sem texto'}
        </Text>
      )}

      <View style={styles.rodape}>
        {enviando && <Clock size={11} color="rgba(255,255,255,0.55)" />}
        {falhou && <AlertCircle size={11} color="#fda4af" />}
        <Text style={[styles.hora, doPaciente && styles.horaMinha, falhou && styles.horaFalhou]}>
          {falhou ? 'não enviou — toque pra tentar' : enviando ? 'enviando…' : hora(item.createdAt)}
        </Text>
      </View>
    </View>
  );

  if (falhou && item.clientId) {
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Tentar enviar de novo"
        onPress={() => onRetry(item.clientId!)}
        style={styles.linha}
      >
        {corpo}
      </Pressable>
    );
  }

  return <View style={[styles.linha, doPaciente ? styles.direita : styles.esquerda]}>{corpo}</View>;
});

const styles = StyleSheet.create({
  linha: { paddingHorizontal: 16, marginVertical: 3, flexDirection: 'row' },
  esquerda: { justifyContent: 'flex-start' },
  direita: { justifyContent: 'flex-end' },
  bubble: { maxWidth: '82%', paddingHorizontal: 14, paddingVertical: 9, borderWidth: 1 },
  dela: {
    backgroundColor: colors.glassFillHi,
    borderColor: colors.glassBorder,
    borderRadius: radii.xl,
    borderBottomLeftRadius: 6,
  },
  minha: {
    backgroundColor: 'rgba(124,135,255,0.85)',
    borderColor: 'rgba(124,135,255,0.5)',
    borderRadius: radii.xl,
    borderBottomRightRadius: 6,
  },
  falhou: { backgroundColor: 'rgba(248,113,113,0.18)', borderColor: 'rgba(248,113,113,0.45)' },
  texto: { color: colors.text, fontSize: 15, lineHeight: 21 },
  textoMinha: { color: '#ffffff' },
  semTexto: { fontStyle: 'italic', opacity: 0.7 },
  audioTag: { flexDirection: 'row', alignItems: 'center', gap: 4, marginBottom: 3 },
  audioTexto: { color: colors.textDim, fontSize: 11, fontWeight: '600' },
  rodape: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 3, alignSelf: 'flex-end' },
  hora: { color: colors.textFaint, fontSize: 10 },
  horaMinha: { color: 'rgba(255,255,255,0.6)' },
  horaFalhou: { color: '#fda4af' },
});
