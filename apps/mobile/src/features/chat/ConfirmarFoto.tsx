/**
 * A prévia antes de a foto virar mensagem.
 *
 * ## A assimetria que estava invertida
 *
 * O app protegia o paciente de "cancelar lembrete" (reversível — basta pedir outro),
 * pedia frase digitada pra apagar a conta, e confirmava derrubar o link do médico. A
 * ÚNICA ação irreversível sem nenhuma confirmação era mandar foto: `escolherDaGaleria()`
 * e o envio aconteciam na mesma expressão. Um toque na miniatura vizinha — numa galeria
 * de celular de família, isso é um neto ou um documento — colocava a imagem no prontuário
 * e num turno de LLM, sem volta e sem como ver o que foi.
 *
 * ## Onde a confirmação cabe, dado que o upload já aconteceu
 *
 * O `Compositor` sobe o arquivo e chama `onEnviar` na mesma ação; ele é de outra frente
 * do projeto e não foi tocado. Mas o upload NÃO cria mensagem — é a decisão de duas
 * etapas do `POST /app/media` (o arquivo vai pro bucket, a mensagem nasce depois). Então
 * a confirmação entra exatamente no ponto que importa: **entre o arquivo no bucket e a
 * mensagem no prontuário**. É a mensagem que é irreversível, não o upload.
 *
 * E há um ganho que só existe por causa dessa ordem: como o arquivo JÁ está no servidor,
 * a prévia mostra **a imagem que o servidor recebeu**, pela mesma URL assinada que a
 * bolha vai usar. Não é a miniatura local que o app achou que mandou — é o que chegou.
 * Foto tremida, dedo na frente do laudo, página errada: aparece aqui.
 *
 * ## O botão se chama "Não enviar" porque é isso que ele faz
 *
 * A primeira versão escrevia "Descartar", com lata de lixo, e o subtítulo prometia
 * conferir "antes de eu guardar no seu histórico". As duas coisas eram falsas na mesma
 * direção: quando este modal abre, o `POST /app/media` já rodou — o arquivo está no
 * bucket e a linha está em `app_media` com o `user_id` do paciente. `routes/app/media.ts`
 * expõe `POST /media` e `GET /media/:id/url`, e **nada mais**: não existe apagar.
 *
 * Então o cenário do começo deste arquivo — o toque errado na miniatura vizinha, que numa
 * galeria de celular de família é um neto ou um documento — terminava com a foto guardada
 * pra sempre e a pessoa acreditando que tinha desfeito. Mentir sobre a reversibilidade de
 * uma ação é pior do que não oferecer o desfazer.
 *
 * O que este botão de fato controla é a MENSAGEM: se o arquivo entra na conversa, vira
 * turno de LLM e passa a aparecer no prontuário como algo que a pessoa disse. Isso é o
 * que importa, e é o que o rótulo agora diz. O desfazer de verdade depende de um
 * `DELETE /app/media/:id` que ainda não existe no servidor; quando ele existir, este
 * botão volta a se chamar "Descartar" e passa a chamá-lo.
 *
 * "Não enviar" e não "Trocar": trocar exigiria reabrir a galeria, que é do `Compositor`.
 * Prometer um botão que faz outra coisa é pior que oferecer o botão honesto.
 */
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { Image } from 'expo-image';
import { Send, X } from 'lucide-react-native';
import { GlassButton } from '@/components/ui';
import { colors, FONTE_CLINICA, radii } from '@/theme';
import { tipoDoMime, useMediaUrl } from './use-media-url';

export interface RascunhoMidia {
  mediaId: string;
  legenda: string;
}

interface Props {
  rascunho: RascunhoMidia | null;
  onConfirmar: () => void;
  onDescartar: () => void;
}

export function ConfirmarFoto({ rascunho, onConfirmar, onDescartar }: Props) {
  const q = useMediaUrl(rascunho?.mediaId ?? null);
  const tipo = tipoDoMime(q.data?.mime);
  const ehAudio = tipo === 'audio';

  return (
    <Modal
      visible={rascunho !== null}
      animationType="fade"
      transparent
      // Voltar no Android tem que fechar sem enviar, não travar o app num modal sem saída.
      onRequestClose={onDescartar}
      statusBarTranslucent
    >
      <View style={styles.fundo}>
        <View style={styles.painel}>
          <Text style={styles.titulo}>{ehAudio ? 'Mandar este áudio?' : 'Mandar esta foto?'}</Text>
          {/* O subtítulo diz onde o arquivo JÁ está e o que este botão decide. A versão
              anterior dizia "antes de eu guardar no seu histórico" — e o arquivo já
              estava guardado quando a frase aparecia. */}
          <Text style={styles.sub}>
            {ehAudio
              ? 'Confere se gravou o que queria dizer — o arquivo já está comigo, isto decide se ele entra na conversa.'
              : 'Confere se está legível — o arquivo já está comigo, isto decide se ele entra na conversa.'}
          </Text>

          <View style={styles.previaCaixa}>
            {q.isPending ? (
              <Text style={styles.aviso}>carregando a prévia…</Text>
            ) : q.isError || !q.data ? (
              // Não bloqueia o envio: o arquivo está no servidor e pode ser só a URL que
              // falhou. Mas DIZ que não conseguiu mostrar, em vez de exibir um quadrado
              // vazio que a pessoa interpretaria como "a foto saiu preta".
              <Text style={styles.aviso}>não consegui mostrar a prévia — o arquivo está aqui</Text>
            ) : ehAudio ? (
              <Text style={styles.aviso}>áudio pronto pra enviar</Text>
            ) : (
              <Image source={{ uri: q.data.url }} style={styles.previa} contentFit="contain" transition={0} />
            )}
          </View>

          {rascunho?.legenda ? (
            <Text style={styles.legenda} numberOfLines={3}>
              “{rascunho.legenda}”
            </Text>
          ) : null}

          <View style={styles.acoes}>
            {/* `X` e não lata de lixo: o ícone de lixeira é a mesma promessa de apagar
                que o rótulo estava fazendo, desenhada. Isto FECHA sem mandar. */}
            <GlassButton
              variant="ghost"
              size="lg"
              onPress={onDescartar}
              icon={<X size={16} color={colors.textDim} />}
              accessibilityLabel="Não enviar este arquivo na conversa"
            >
              Não enviar
            </GlassButton>
            <GlassButton
              variant="primary"
              size="lg"
              onPress={onConfirmar}
              icon={<Send size={16} color={colors.textOnFill} />}
              accessibilityLabel="Enviar para a Xarlote"
              style={styles.enviar}
            >
              Enviar
            </GlassButton>
          </View>
        </View>

        {/* Toque fora também descarta — mas FORA da área do painel, nunca sobre ele. */}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Fechar sem enviar"
          onPress={onDescartar}
          style={styles.foraDoPainel}
        />
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  fundo: { flex: 1, backgroundColor: 'rgba(4,4,26,0.88)', justifyContent: 'flex-end' },
  foraDoPainel: { position: 'absolute', left: 0, right: 0, top: 0, height: 120 },
  painel: {
    margin: 12,
    padding: 18,
    borderRadius: radii['2xl'],
    borderWidth: 1,
    borderColor: colors.glassBorderHi,
    backgroundColor: 'rgba(16,16,42,0.98)',
  },
  titulo: { color: colors.text, fontSize: 19, fontWeight: '700', letterSpacing: -0.4 },
  sub: { color: colors.textDim, fontSize: FONTE_CLINICA, marginTop: 4, lineHeight: 19 },
  previaCaixa: {
    height: 280,
    marginTop: 14,
    borderRadius: radii.lg,
    backgroundColor: 'rgba(0,0,0,0.35)',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  previa: { width: '100%', height: '100%' },
  aviso: { color: colors.textDim, fontSize: FONTE_CLINICA, textAlign: 'center', paddingHorizontal: 20 },
  legenda: { color: colors.textDim, fontSize: FONTE_CLINICA, marginTop: 10, fontStyle: 'italic' },
  acoes: { flexDirection: 'row', gap: 10, marginTop: 16 },
  enviar: { flexGrow: 1 },
});
