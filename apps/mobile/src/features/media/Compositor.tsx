/**
 * A barra de envio do chat: texto, anexo e voz.
 *
 * ## Três estados, e a tela só mostra um por vez
 *
 * `escrevendo` (o normal), `anexando` (as opções de foto) e `gravando`. Empilhar tudo ao
 * mesmo tempo numa barra que já divide espaço com o orb deixaria os alvos de toque
 * pequenos demais — e o alvo pequeno é o que faz alguém mandar áudio sem querer.
 *
 * ## O microfone só aparece quando não há texto
 *
 * Mesma convenção do WhatsApp, e por um motivo prático: com texto escrito, o botão
 * daquele canto precisa ser "enviar". Trocar a função do mesmo botão conforme o estado é
 * o que as pessoas já esperam ali.
 */
import { useCallback, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { ArrowUp, Camera, Images, Mic, Paperclip, Trash2, X } from 'lucide-react-native';
import { useGravador, MAX_SEGUNDOS } from './use-gravador';
import { useMedia } from './use-media';
import { colors, radii } from '@/theme';

interface Props {
  /** `texto` pode ser vazio quando há `mediaId`. */
  onEnviar: (texto: string, mediaId?: string) => void;
  /** Folga à direita pro orb de navegação não cobrir o botão. */
  paddingRight: number;
  paddingBottom: number;
}

function mmss(s: number): string {
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, '0')}`;
}

export function Compositor({ onEnviar, paddingRight, paddingBottom }: Props) {
  const [rascunho, setRascunho] = useState('');
  const [anexando, setAnexando] = useState(false);
  const midia = useMedia();
  const gravador = useGravador();

  const temTexto = rascunho.trim().length > 0;
  const ocupado = midia.fase !== 'parado';

  const submeterTexto = useCallback(() => {
    if (!temTexto) return;
    onEnviar(rascunho.trim());
    setRascunho('');
  }, [rascunho, temTexto, onEnviar]);

  /** Anexo: sobe o arquivo e JÁ manda, com a legenda que estiver escrita. */
  const anexar = useCallback(
    async (origem: 'camera' | 'galeria') => {
      setAnexando(false);
      const r = origem === 'camera' ? await midia.fotografar() : await midia.escolherDaGaleria();
      if (!r) return;
      onEnviar(rascunho.trim(), r.mediaId);
      setRascunho('');
    },
    [midia, onEnviar, rascunho],
  );

  const pararEEnviar = useCallback(async () => {
    const arquivo = await gravador.parar();
    if (!arquivo) return;
    const r = await midia.subirArquivo(arquivo.uri, arquivo.mime, arquivo.nome);
    if (r) onEnviar('', r.mediaId);
  }, [gravador, midia, onEnviar]);

  // ── Gravando ────────────────────────────────────────────────────────────────
  if (gravador.gravando) {
    return (
      <View style={[styles.barra, { paddingBottom, paddingRight }]}>
        <Pressable
          onPress={() => void gravador.cancelar()}
          hitSlop={10}
          style={styles.iconeBotao}
          accessibilityLabel="Descartar o áudio"
        >
          <Trash2 size={20} color={colors.danger} />
        </Pressable>

        <View style={styles.gravando}>
          <View style={styles.pontoVermelho} />
          <Text style={styles.tempo}>{mmss(gravador.segundos)}</Text>
          <Text style={styles.tempoLimite}>/ {mmss(MAX_SEGUNDOS)}</Text>
        </View>

        <Pressable
          onPress={() => void pararEEnviar()}
          style={styles.enviar}
          accessibilityLabel="Enviar o áudio"
        >
          <ArrowUp size={19} color="#fff" />
        </Pressable>
      </View>
    );
  }

  return (
    <View>
      {midia.erro ? (
        <Pressable onPress={midia.limparErro} style={styles.erroBarra}>
          <Text style={styles.erroTexto}>{midia.erro}</Text>
          <X size={14} color={colors.textFaint} />
        </Pressable>
      ) : null}

      {gravador.erro ? <Text style={styles.erroTexto}>{gravador.erro}</Text> : null}

      {/* ── Opções de anexo ──────────────────────────────────────────────── */}
      {anexando && (
        <View style={styles.opcoes}>
          <Opcao
            icone={<Camera size={20} color={colors.accentHi} />}
            rotulo="Tirar foto"
            hint="do exame ou da receita"
            onPress={() => void anexar('camera')}
          />
          <Opcao
            icone={<Images size={20} color={colors.info} />}
            rotulo="Escolher da galeria"
            hint="uma foto que já está no celular"
            onPress={() => void anexar('galeria')}
          />
          <Pressable onPress={() => setAnexando(false)} style={styles.fechar} hitSlop={8}>
            <Text style={styles.fecharTexto}>fechar</Text>
          </Pressable>
        </View>
      )}

      <View style={[styles.barra, { paddingBottom, paddingRight }]}>
        <Pressable
          onPress={() => setAnexando((v) => !v)}
          disabled={ocupado}
          hitSlop={10}
          style={styles.iconeBotao}
          accessibilityLabel="Anexar foto"
        >
          <Paperclip size={20} color={ocupado ? colors.textFaint : colors.textDim} />
        </Pressable>

        <TextInput
          value={rascunho}
          onChangeText={setRascunho}
          placeholder={ocupado ? 'Enviando…' : 'Escreve pra Xarlote…'}
          placeholderTextColor={colors.textFaint}
          selectionColor={colors.accentHi}
          keyboardAppearance="dark"
          editable={!ocupado}
          multiline
          style={styles.campo}
          onSubmitEditing={submeterTexto}
        />

        {ocupado ? (
          <View style={styles.enviar}>
            <ActivityIndicator color="#fff" size="small" />
          </View>
        ) : temTexto ? (
          <Pressable onPress={submeterTexto} style={styles.enviar} accessibilityLabel="Enviar">
            <ArrowUp size={19} color="#fff" />
          </Pressable>
        ) : (
          <Pressable
            onPress={() => void gravador.comecar()}
            style={styles.microfone}
            accessibilityLabel="Gravar um áudio"
          >
            <Mic size={19} color={colors.textDim} />
          </Pressable>
        )}
      </View>
    </View>
  );
}

function Opcao({
  icone,
  rotulo,
  hint,
  onPress,
}: {
  icone: React.ReactNode;
  rotulo: string;
  hint: string;
  onPress: () => void;
}) {
  return (
    <Pressable onPress={onPress} style={styles.opcao}>
      <View style={styles.opcaoIcone}>{icone}</View>
      <View style={styles.opcaoTextos}>
        <Text style={styles.opcaoRotulo}>{rotulo}</Text>
        <Text style={styles.opcaoHint}>{hint}</Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  barra: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 8,
    paddingHorizontal: 16,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: colors.glassBorder,
    backgroundColor: 'rgba(10,10,30,0.72)',
  },
  campo: {
    flex: 1,
    maxHeight: 132,
    minHeight: 42,
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderWidth: 1,
    borderColor: colors.glassBorder,
    borderRadius: radii.xl,
    paddingHorizontal: 14,
    paddingTop: 11,
    paddingBottom: 11,
    color: colors.text,
    fontSize: 15,
  },
  iconeBotao: { height: 42, width: 32, alignItems: 'center', justifyContent: 'center' },
  enviar: {
    height: 42,
    width: 42,
    borderRadius: 21,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.accent,
  },
  microfone: {
    height: 42,
    width: 42,
    borderRadius: 21,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderWidth: 1,
    borderColor: colors.glassBorder,
  },
  gravando: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 6 },
  pontoVermelho: { width: 9, height: 9, borderRadius: 5, backgroundColor: colors.danger },
  tempo: { color: colors.text, fontSize: 16, fontVariant: ['tabular-nums'], fontWeight: '600' },
  tempoLimite: { color: colors.textFaint, fontSize: 12, fontVariant: ['tabular-nums'] },
  opcoes: {
    marginHorizontal: 16,
    marginBottom: 8,
    borderRadius: radii['2xl'],
    borderWidth: 1,
    borderColor: colors.glassBorder,
    backgroundColor: 'rgba(16,16,40,0.96)',
    overflow: 'hidden',
  },
  opcao: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 14 },
  opcaoIcone: {
    width: 38,
    height: 38,
    borderRadius: radii.md,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.05)',
  },
  opcaoTextos: { flex: 1 },
  opcaoRotulo: { color: colors.text, fontSize: 14, fontWeight: '600' },
  opcaoHint: { color: colors.textFaint, fontSize: 11, marginTop: 1 },
  fechar: { alignItems: 'center', paddingVertical: 10, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.glassBorder },
  fecharTexto: { color: colors.textDim, fontSize: 12 },
  erroBarra: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginHorizontal: 16,
    marginBottom: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: radii.lg,
    backgroundColor: 'rgba(251,191,36,0.10)',
    borderWidth: 1,
    borderColor: 'rgba(251,191,36,0.25)',
  },
  erroTexto: { flex: 1, color: colors.warn, fontSize: 12, lineHeight: 17 },
});
