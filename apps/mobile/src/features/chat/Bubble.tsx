/**
 * A bolha de mensagem.
 *
 * A da Xarlote nasce da esquerda com o vidro do design system; a do paciente vem da
 * direita em accent sólido. Três escolhas que parecem estética e não são:
 *
 * · **Sem blur** na bolha, mesmo no iOS. Ela vive dentro de uma lista que rola, e a
 *   regra do projeto (src/theme/glass.ts) é blur só em superfície parada.
 * · O status de envio é **texto e ícone**, não só cor: "enviando…" e "não enviou,
 *   toque pra tentar" precisam ser legíveis por quem não distingue tons.
 * · **A mídia é a mídia.** Quando há `mediaId`, a bolha desenha a FOTO ou um botão de
 *   tocar (ver ChatMedia.tsx). A palavra "imagem" em itálico é a promessa central do
 *   produto quebrada na interface, e era o que estava aqui.
 *
 * ## O que sobrou de honesto quando falta o `mediaId`
 *
 * O histórico vindo do servidor ainda não traz `mediaId` (o `select` do
 * `GET /app/messages` não o busca). Nesse caso a bolha diz "Foto enviada" com ícone —
 * afirma que o arquivo existe, em 13px, e NÃO oferece um toque que não leva a nada.
 * Fingir affordance é pior que admitir limite.
 */
import { memo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { AlertCircle, Clock, ImageIcon, Mic } from 'lucide-react-native';
import { colors, FONTE_CLINICA, FONTE_MINIMA, radii } from '@/theme';
import { ChatMedia } from './ChatMedia';
import type { ChatItem } from './merge';

/** "14:32" pelo relógio do aparelho — é o fuso em que o paciente está. */
function hora(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

interface Props {
  item: ChatItem;
  onRetry: (clientId: string) => void;
  onAbrirFoto: (url: string) => void;
}

/** Mídia sem id: diz que o arquivo existe, sem prometer um toque que não funciona. */
function MidiaSemFonte({ tipo, doPaciente }: { tipo: string; doPaciente: boolean }) {
  const ehAudio = tipo === 'audio';
  const cor = doPaciente ? 'rgba(255,255,255,0.85)' : colors.textDim;
  return (
    <View style={styles.semFonte}>
      {ehAudio ? <Mic size={14} color={cor} /> : <ImageIcon size={14} color={cor} />}
      <Text style={[styles.semFonteTexto, doPaciente && styles.textoMinha]}>
        {ehAudio ? 'Áudio enviado' : 'Foto enviada'}
      </Text>
    </View>
  );
}

export const Bubble = memo(function Bubble({ item, onRetry, onAbrirFoto }: Props) {
  // A direção vem do BANCO e é uma só: `in` = o paciente falando, `out` = a Xarlote
  // respondendo. A bolha otimista já nasce com `in` (ver merge.ts), então este lado
  // nunca muda quando a confirmação chega — a mensagem não salta de lado.
  const doPaciente = item.direction === 'in';
  const falhou = item.status === 'failed';
  const enviando = item.status === 'pending';
  const temMidia = item.contentType === 'image' || item.contentType === 'audio' || item.contentType === 'media';

  const corpo = (
    <View style={[styles.bubble, doPaciente ? styles.minha : styles.dela, falhou && styles.falhou]}>
      {temMidia ? (
        item.mediaId ? (
          // `contentType` e `mediaMime` descem juntos de propósito: é com eles que o
          // ChatMedia sabe que é ÁUDIO sem pedir a URL assinada. Sem essa pista, seis
          // mensagens de voz na tela viram seis requisições que ninguém vai ouvir.
          <ChatMedia
            mediaId={item.mediaId}
            contentType={item.contentType}
            mime={item.mediaMime}
            doPaciente={doPaciente}
            onAbrir={onAbrirFoto}
          />
        ) : (
          <MidiaSemFonte tipo={item.contentType} doPaciente={doPaciente} />
        )
      ) : null}

      {item.text ? (
        <Text style={[styles.texto, doPaciente && styles.textoMinha]}>{item.text}</Text>
      ) : temMidia ? null : (
        <Text style={[styles.texto, styles.semTexto, doPaciente && styles.textoMinha]}>
          mensagem sem texto
        </Text>
      )}

      <View style={styles.rodape}>
        {enviando && <Clock size={12} color="rgba(255,255,255,0.7)" />}
        {falhou && <AlertCircle size={12} color={colors.dangerSoft} />}
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
        style={[styles.linha, styles.direita]}
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
  textoMinha: { color: colors.textOnFill },
  semTexto: { fontStyle: 'italic', opacity: 0.7 },
  semFonte: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 4 },
  semFonteTexto: { color: colors.textDim, fontSize: FONTE_CLINICA, fontWeight: '500' },
  rodape: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 3, alignSelf: 'flex-end' },
  /**
   * Era 10px — abaixo do piso do app. A hora é metadado descartável, então fica no
   * mínimo (12) e não sobe a 13; mas "não enviou — toque pra tentar" mora nesta mesma
   * linha, e essa frase não é descartável: é a única instrução de recuperação que a
   * pessoa recebe quando uma mensagem sobre saúde não saiu.
   */
  hora: { color: colors.textDim, fontSize: FONTE_MINIMA },
  horaMinha: { color: 'rgba(255,255,255,0.78)' },
  horaFalhou: { color: colors.dangerSoft, fontWeight: '500' },
});
