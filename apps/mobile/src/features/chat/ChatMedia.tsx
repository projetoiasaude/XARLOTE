/**
 * A mídia DENTRO da bolha — a foto que aparece e o áudio que toca.
 *
 * ## O que estava quebrado
 *
 * Uma mensagem com imagem desenhava a palavra **"imagem"** em itálico. Uma com áudio, uma
 * etiqueta "áudio" com ícone de microfone e nenhum botão de tocar. O wedge do produto é
 * "manda a foto do teu exame" — está escrito no cabeçalho do `use-media.ts` — e do momento
 * do envio em diante o registro da pessoa dizia "imagem". Ela não conseguia conferir se a
 * foto saiu legível, nem reler o próprio laudo. Quem fotografou a página errada não tinha
 * como descobrir.
 *
 * ## As três decisões
 *
 * · **O tipo vem do MIME da URL assinada, não do palpite do app.** O servidor decide
 *   imagem-ou-áudio farejando os bytes (`media-sniff.ts`); repetir esse palpite no cliente
 *   criaria uma segunda verdade que envelhece sozinha. Enquanto a URL não chega, a bolha
 *   diz "carregando" — não "imagem".
 *
 * · **Falha de carregamento é BOTÃO, não texto.** URL assinada vence em 10 minutos e rede
 *   móvel cai; o caminho de volta tem que ser um toque, ali mesmo. Um "não consegui
 *   carregar" sem ação é a mesma promessa quebrada com outra fonte.
 *
 * · **A foto abre em tela cheia.** 82% da largura da bolha é bom pra reconhecer a foto e
 *   inútil pra LER um laudo. Quem tem 55 anos precisa do valor de referência, não da
 *   miniatura.
 *
 * ## O tipo DECLARADO é o que segura a rede
 *
 * "O tipo vem do MIME da URL assinada" continua valendo pro veredicto final — mas existe
 * um palpite honesto *antes* dela, e ele não é palpite: a própria mensagem diz. O
 * `GET /app/messages` devolve `media_mime`, e a linha canônica já vem com
 * `contentType: 'audio'`. Quando qualquer um dos dois diz "áudio", o botão de tocar pode
 * ser desenhado **sem pedir URL nenhuma** — que é exatamente o que o `sobDemanda` do
 * `use-media-url.ts` existe pra permitir. Sem isso, uma conversa com seis mensagens de
 * voz na tela dispara seis URLs assinadas que ninguém vai ouvir, em rede móvel.
 *
 * O que NÃO se faz é o contrário: assumir "imagem" por declaração e desenhar um `<Image>`
 * contra uma URL que talvez seja PDF. Declaração adianta o botão de tocar (barato de
 * errar: um toque pede a URL e o mime real corrige); nunca adianta o conteúdo.
 */
import { memo, useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Image } from 'expo-image';
import * as Haptics from 'expo-haptics';
import { ImageOff, Pause, Play, RefreshCw } from 'lucide-react-native';
import { colors, FONTE_CLINICA, radii } from '@/theme';
import { useAudioPlayback } from './audio-playback';
import { tipoDoMime, useMediaUrl } from './use-media-url';

interface Props {
  mediaId: string;
  /**
   * O que a mensagem diz que é (`'image' | 'audio' | 'media'`). `'media'` = o próprio
   * aparelho ainda não sabe (bolha otimista), e aí só a URL assinada decide.
   */
  contentType?: string;
  /** `media_mime` da mensagem, quando o servidor mandou. A pista mais confiável das duas. */
  mime?: string | null;
  /** Bolha do paciente: os tons de "carregando" e de erro mudam sobre o accent. */
  doPaciente: boolean;
  /** Abre a foto em tela cheia. A tela do chat é quem sabe desenhar o visor. */
  onAbrir: (url: string) => void;
}

export const ChatMedia = memo(function ChatMedia({
  mediaId,
  contentType,
  mime,
  doPaciente,
  onAbrir,
}: Props) {
  const [pediuAudio, setPediuAudio] = useState(false);
  const [autoTocar, setAutoTocar] = useState(false);

  // A query fica DESLIGADA enquanto se sabe que é áudio e ninguém tocou no play.
  const ehAudioDeclarado = tipoDoMime(mime) === 'audio' || contentType === 'audio';
  const sobDemanda = ehAudioDeclarado && !pediuAudio;
  const q = useMediaUrl(mediaId, sobDemanda);
  const audio = useAudioPlayback();

  const dados = q.data;

  // O primeiro toque no play PEDE a URL; quando ela chega, toca. Sem isto o áudio pediria
  // dois toques — o primeiro só buscaria o link, e o segundo pareceria o que funcionou.
  useEffect(() => {
    if (!autoTocar || !dados) return;
    setAutoTocar(false);
    audio.alternar(mediaId, dados.url);
  }, [autoTocar, dados, audio, mediaId]);

  if (ehAudioDeclarado || tipoDoMime(dados?.mime) === 'audio') {
    const falhou = q.isError && !dados;
    const estaTocando = audio.ativo === mediaId && audio.tocando;
    const buscando = autoTocar && !dados;
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={
          falhou
            ? 'Tentar carregar o áudio de novo'
            : estaTocando
              ? 'Pausar o áudio'
              : 'Tocar o áudio'
        }
        onPress={() => {
          void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
          if (falhou) {
            setAutoTocar(true);
            void q.refetch();
            return;
          }
          setPediuAudio(true);
          if (dados) {
            audio.alternar(mediaId, dados.url);
            return;
          }
          // Sem URL ainda: este toque liga a query (via `pediuAudio`) e agenda o play.
          // Um segundo toque enquanto ela viaja é desistência — e cancela o play.
          setAutoTocar((v) => !v);
        }}
        style={styles.audio}
      >
        <View style={[styles.botaoPlay, doPaciente && styles.botaoPlayMinha]}>
          {falhou ? (
            <RefreshCw size={18} color={colors.textOnFill} />
          ) : estaTocando ? (
            <Pause size={18} color={colors.textOnFill} />
          ) : (
            <Play size={18} color={colors.textOnFill} />
          )}
        </View>
        <Text
          style={[styles.audioRotulo, doPaciente && styles.avisoMinha, falhou && styles.rotuloFalha]}
        >
          {falhou
            ? 'não carregou — toque pra tentar'
            : estaTocando
              ? 'tocando…'
              : buscando
                ? 'buscando o áudio…'
                : pediuAudio
                  ? 'pausado'
                  : 'mensagem de voz'}
        </Text>
      </Pressable>
    );
  }

  if (q.isPending) {
    return (
      <View style={[styles.moldura, styles.placeholder]}>
        <Text style={[styles.aviso, doPaciente && styles.avisoMinha]}>carregando…</Text>
      </View>
    );
  }

  if (q.isError || !dados) {
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Tentar carregar o arquivo de novo"
        onPress={() => void q.refetch()}
        style={[styles.moldura, styles.placeholder, styles.falha]}
      >
        <ImageOff size={16} color={colors.warn} />
        <Text style={styles.avisoFalha}>não carregou — toque pra tentar</Text>
        <RefreshCw size={14} color={colors.warn} />
      </Pressable>
    );
  }

  // Áudio já saiu acima, pelos dois caminhos (declarado e descoberto no mime).
  const tipo = tipoDoMime(dados.mime);

  if (tipo !== 'image') {
    // Documento (PDF etc). Diz o que é em vez de fingir que é foto — e não oferece um
    // toque que não leva a lugar nenhum.
    return (
      <View style={[styles.moldura, styles.placeholder]}>
        <Text style={[styles.aviso, doPaciente && styles.avisoMinha]}>arquivo guardado</Text>
      </View>
    );
  }

  return (
    <Pressable
      accessibilityRole="imagebutton"
      accessibilityLabel="Abrir a foto em tela cheia"
      onPress={() => {
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        onAbrir(dados.url);
      }}
      style={styles.moldura}
    >
      <Image
        source={{ uri: dados.url }}
        style={styles.foto}
        contentFit="cover"
        // `transition={0}`: um fade de entrada aqui é animação que REVELA conteúdo — se
        // ela não rodar, a foto do exame fica invisível. Aparecer parado é melhor.
        transition={0}
        cachePolicy="memory-disk"
        accessible
        accessibilityLabel="Foto enviada por você"
      />
    </Pressable>
  );
});

const styles = StyleSheet.create({
  moldura: {
    width: 232,
    borderRadius: radii.md,
    overflow: 'hidden',
    marginBottom: 6,
    backgroundColor: 'rgba(0,0,0,0.22)',
  },
  foto: { width: 232, height: 176 },
  placeholder: { height: 64, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 6 },
  falha: { borderWidth: 1, borderColor: 'rgba(251,191,36,0.35)', backgroundColor: 'rgba(251,191,36,0.10)' },
  aviso: { color: colors.textDim, fontSize: FONTE_CLINICA },
  avisoMinha: { color: 'rgba(255,255,255,0.85)' },
  avisoFalha: { color: colors.warn, fontSize: FONTE_CLINICA, fontWeight: '500' },
  /** 44 de altura: a linha inteira é o alvo, não só o círculo do play. */
  audio: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 44, paddingRight: 6 },
  botaoPlay: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.accent,
  },
  botaoPlayMinha: { backgroundColor: 'rgba(255,255,255,0.22)' },
  audioRotulo: { color: colors.textDim, fontSize: FONTE_CLINICA, fontWeight: '500' },
  rotuloFalha: { color: colors.warn },
});
