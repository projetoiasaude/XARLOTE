/**
 * UM tocador de áudio para a conversa inteira.
 *
 * ## Por que um só, e não um por bolha
 *
 * `useAudioPlayer` cria um player NATIVO. Um por bolha significaria um objeto nativo por
 * mensagem de voz visível, criado e destruído conforme a lista rola — e dois áudios
 * tocando junto se a pessoa tocar em dois play. Um player compartilhado resolve as duas
 * coisas: só existe um, e começar um áudio necessariamente para o outro.
 *
 * ## O detalhe que impede a lista de re-renderizar a cada segundo
 *
 * `useAudioPlayerStatus` atualiza a cada `updateInterval` enquanto toca. Se esse status
 * atravessasse o contexto, todo `Bubble` visível re-renderizaria duas vezes por segundo
 * durante um áudio de 3 minutos.
 *
 * Duas defesas: (1) o valor do contexto é memoizado por `[ativo, tocando]` — dois
 * booleanos que mudam raramente, não por `currentTime`; (2) `children` é o MESMO elemento
 * entre re-renders do provider, então o React salta a subárvore e só os consumidores do
 * contexto acordam. Nada de duração na tela, de propósito: mostrar o cronômetro custaria
 * um re-render por segundo em todos os consumidores pra informar o que ninguém pediu.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { setAudioModeAsync, useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';

interface Controle {
  /** Chave da mídia que está carregada no player (não necessariamente tocando). */
  ativo: string | null;
  tocando: boolean;
  /** Toca, ou pausa se já for esta. */
  alternar: (chave: string, url: string) => void;
}

const Ctx = createContext<Controle | null>(null);

export function AudioPlaybackProvider({ children }: { children: ReactNode }) {
  const player = useAudioPlayer(undefined, { updateInterval: 500 });
  const status = useAudioPlayerStatus(player);
  const [ativo, setAtivo] = useState<string | null>(null);

  /**
   * `playsInSilentMode`: sem isto, o iPhone no modo silencioso toca MUDO — e a pessoa
   * conclui que o áudio dela não gravou. O gravador já fazia isso na entrada; a saída
   * precisa do mesmo cuidado.
   */
  useEffect(() => {
    void setAudioModeAsync({ playsInSilentMode: true });
  }, []);

  // Terminou: solta a bolha do play, senão o botão fica em "pausar" num áudio parado.
  useEffect(() => {
    if (status.didJustFinish) setAtivo(null);
  }, [status.didJustFinish]);

  const alternar = useCallback(
    (chave: string, url: string) => {
      if (ativo === chave) {
        if (player.playing) player.pause();
        else player.play();
        return;
      }
      player.replace(url);
      setAtivo(chave);
      player.play();
    },
    [ativo, player],
  );

  const valor = useMemo<Controle>(
    () => ({ ativo, tocando: status.playing, alternar }),
    [ativo, status.playing, alternar],
  );

  return <Ctx.Provider value={valor}>{children}</Ctx.Provider>;
}

/**
 * Fora do provider devolve um controle INERTE em vez de lançar.
 *
 * A bolha é usada em lista virtualizada e um dia pode ser montada num contexto sem
 * áudio (uma prévia, um teste). Derrubar a tela inteira por causa do botão de tocar
 * seria trocar um defeito pequeno por um fatal.
 */
export function useAudioPlayback(): Controle {
  return useContext(Ctx) ?? INERTE;
}

const INERTE: Controle = { ativo: null, tocando: false, alternar: () => undefined };
