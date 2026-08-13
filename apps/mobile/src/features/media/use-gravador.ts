/**
 * O gravador de voz.
 *
 * ## Por que voz importa aqui
 *
 * Boa parte dos 26 pacientes manda áudio no WhatsApp — é mais rápido que digitar, e
 * para quem tem dificuldade com o teclado é a única forma confortável. Sem voz no app,
 * essas pessoas continuariam no WhatsApp para metade das coisas.
 *
 * O áudio sobe pelo mesmo `/app/media` da foto e cai na transcrição que JÁ existe.
 * Nenhum pipeline novo.
 *
 * ## Formato: m4a/AAC
 *
 * É o que o `scribe_v1` aceita — o transcritor primário. O fallback (`gpt-4o-audio`)
 * NÃO aceita m4a, então no canal do app o scribe é obrigatório, não preferencial.
 *
 * ## O limite de duração é um cuidado, não um capricho
 *
 * Áudio longo vira transcrição longa vira contexto caro — e um gravador esquecido ligado
 * no bolso mandaria minutos de nada. 3 minutos cobre um relato clínico completo.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AudioModule,
  RecordingPresets,
  setAudioModeAsync,
  useAudioRecorder,
  useAudioRecorderState,
} from 'expo-audio';

export const MAX_SEGUNDOS = 180;

export interface EstadoGravador {
  gravando: boolean;
  segundos: number;
  erro: string | null;
  comecar: () => Promise<void>;
  /** Para e devolve o arquivo pronto pra subir, ou null se não deu. */
  parar: () => Promise<{ uri: string; mime: string; nome: string } | null>;
  /** Para e DESCARTA — o paciente desistiu. */
  cancelar: () => Promise<void>;
}

export function useGravador(): EstadoGravador {
  const gravador = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const estado = useAudioRecorderState(gravador);
  const [erro, setErro] = useState<string | null>(null);
  const cancelado = useRef(false);

  const segundos = Math.floor((estado.durationMillis ?? 0) / 1000);
  const gravando = estado.isRecording;

  const comecar = useCallback(async () => {
    setErro(null);
    cancelado.current = false;
    try {
      const perm = await AudioModule.requestRecordingPermissionsAsync();
      if (!perm.granted) {
        setErro('Preciso do microfone pra gravar. Você pode liberar nos Ajustes.');
        return;
      }
      // `playsInSilentMode`: sem isso, o iPhone no modo silencioso grava mudo — e o
      // paciente só descobre depois de mandar um áudio vazio.
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      await gravador.prepareToRecordAsync();
      gravador.record();
    } catch {
      setErro('Não consegui começar a gravar. Tenta de novo?');
    }
  }, [gravador]);

  const parar = useCallback(async () => {
    try {
      await gravador.stop();
      const uri = gravador.uri;
      if (!uri || cancelado.current) return null;
      return { uri, mime: 'audio/m4a', nome: 'voz.m4a' };
    } catch {
      setErro('Não consegui finalizar o áudio.');
      return null;
    }
  }, [gravador]);

  const cancelar = useCallback(async () => {
    cancelado.current = true;
    try {
      await gravador.stop();
    } catch {
      /* já parado — cancelar nunca pode dar erro na cara do paciente */
    }
  }, [gravador]);

  /**
   * Corta sozinho no limite.
   *
   * Um gravador esquecido ligado é o caso real: o paciente toca em gravar, se distrai, e
   * o app fica ouvindo. O corte automático protege a bateria dele e o custo da
   * transcrição — e ele ainda fica com os 3 minutos que falou.
   */
  useEffect(() => {
    if (gravando && segundos >= MAX_SEGUNDOS) void gravador.stop();
  }, [gravando, segundos, gravador]);

  return { gravando, segundos, erro, comecar, parar, cancelar };
}
