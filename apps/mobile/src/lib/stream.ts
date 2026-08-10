/**
 * O tempo real do lado do app: um SSE que sabe se cuidar.
 *
 * Celular não é navegador em mesa. A conexão morre a toda hora — o app vai pro
 * background, o metrô entra no túnel, a operadora troca de torre, o Wi-Fi cede pro
 * 4G. Então o desenho aqui parte do princípio de que a conexão CAI, e o que importa é
 * o que acontece depois:
 *
 * 1. **Reconectar não basta: tem que RECUPERAR.** O servidor não guarda histórico de
 *    eventos (contrato deliberado — ver routes/app/stream.ts). Então a cada reconexão
 *    o app chama `onResync`, que refaz a busca por cursor. É o banco, e não um buffer
 *    de eventos, que garante que nada se perdeu.
 *
 * 2. **Token vencido na reabertura.** O access token vive 15 minutos e a conexão pode
 *    ficar aberta muito mais. Na reabertura, um 401 dispara a rotação (em voo único,
 *    compartilhada com o resto do app) e tenta de novo com o token novo.
 *
 * 3. **Desistir com dignidade.** Depois de algumas falhas seguidas, marca `degraded` e
 *    o chamador liga o polling. Melhor uma tela que atualiza a cada 5s do que uma tela
 *    que jura estar ao vivo e está morta.
 *
 * 4. **Nada disso roda em background.** `AppState` fecha a conexão quando o app sai da
 *    tela: SSE aberto em background é bateria queimada à toa, e o iOS mata mesmo.
 *    Quem avisa o paciente com o app fechado é o push, não isto.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import EventSource from 'react-native-sse';
import { API_BASE_URL, currentAccessToken, refreshAccessToken } from './api/client';

/** Espelho do envelope do servidor (apps/api/src/lib/app-events.ts). */
export interface StreamEvent {
  type: 'message' | 'typing' | 'reminder' | 'activity';
  at: number;
  id?: string;
  direction?: 'in' | 'out';
  contentType?: string;
  text?: string;
  clientId?: string;
}

const TIPOS = ['message', 'typing', 'reminder', 'activity'] as const;

/** Falhas seguidas antes de assumir que o tempo real não vai acontecer. */
const MAX_FALHAS = 2;
/** Espera entre tentativas — cresce, pra não martelar um servidor que está mal. */
const BACKOFF_MS = [1_000, 4_000, 10_000];

export interface StreamState {
  /** Conexão aberta e recebendo. */
  connected: boolean;
  /** Desistiu do SSE — o chamador deve ligar o polling. */
  degraded: boolean;
}

export interface UseAppStreamOptions {
  /** Só conecta quando há sessão e a tela está viva. */
  enabled: boolean;
  onEvent: (ev: StreamEvent) => void;
  /** Chamado a cada (re)conexão — o app refaz a busca por cursor. */
  onResync: () => void;
}

export function useAppStream({ enabled, onEvent, onResync }: UseAppStreamOptions): StreamState {
  const [state, setState] = useState<StreamState>({ connected: false, degraded: false });

  // Callbacks em ref: o efeito de conexão NÃO deve depender delas. Se dependesse,
  // cada re-render do chat (uma tecla digitada!) derrubaria e reabriria o SSE.
  const onEventRef = useRef(onEvent);
  const onResyncRef = useRef(onResync);
  onEventRef.current = onEvent;
  onResyncRef.current = onResync;

  const esRef = useRef<EventSource<(typeof TIPOS)[number]> | null>(null);
  const falhas = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const vivo = useRef(true);

  const fechar = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    if (esRef.current) {
      esRef.current.removeAllEventListeners();
      esRef.current.close();
      esRef.current = null;
    }
  }, []);

  const conectar = useCallback(
    async (tentativa = 0) => {
      if (!vivo.current) return;
      fechar();

      let token = currentAccessToken();
      if (!token) token = await refreshAccessToken();
      if (!token || !vivo.current) return;

      const es = new EventSource<(typeof TIPOS)[number]>(`${API_BASE_URL}/app/stream`, {
        headers: { Authorization: `Bearer ${token}` },
        // Reconexão é NOSSA, não da biblioteca: só assim o resync por cursor e a
        // rotação de token acontecem no lugar certo. 0 desliga a dela.
        pollingInterval: 0,
        // Sem timeout: um SSE saudável fica minutos calado entre eventos (o
        // heartbeat de 25s do servidor é comentário, não evento).
        timeout: 0,
      });
      esRef.current = es;

      es.addEventListener('open', () => {
        if (!vivo.current) return;
        falhas.current = 0;
        setState({ connected: true, degraded: false });
        // O pulo do gato: toda conexão nova recupera o que passou pelo banco.
        onResyncRef.current();
      });

      for (const tipo of TIPOS) {
        es.addEventListener(tipo, (ev) => {
          if (!vivo.current || !('data' in ev) || !ev.data) return;
          try {
            onEventRef.current(JSON.parse(ev.data) as StreamEvent);
          } catch {
            /* evento malformado no canal: ignora, o resync cobre */
          }
        });
      }

      es.addEventListener('error', (ev) => {
        if (!vivo.current) return;
        setState((s) => ({ ...s, connected: false }));

        // 401 = token venceu enquanto a conexão estava aberta (ou na reabertura).
        // Rotaciona e tenta de novo IMEDIATAMENTE, sem contar como falha de rede —
        // senão duas expirações seguidas jogariam o app pro modo degradado à toa.
        const status = 'xhrStatus' in ev ? ev.xhrStatus : 0;
        if (status === 401) {
          void refreshAccessToken().then((novo) => {
            if (novo && vivo.current) void conectar(0);
          });
          return;
        }

        falhas.current += 1;
        if (falhas.current > MAX_FALHAS) {
          // Desistiu: o chamador liga o polling. Nunca fingir que está ao vivo.
          setState({ connected: false, degraded: true });
          return;
        }
        const espera = BACKOFF_MS[Math.min(tentativa, BACKOFF_MS.length - 1)]!;
        timer.current = setTimeout(() => void conectar(tentativa + 1), espera);
      });
    },
    [fechar],
  );

  // Ciclo de vida da conexão.
  useEffect(() => {
    vivo.current = enabled;
    if (!enabled) {
      fechar();
      setState({ connected: false, degraded: false });
      return;
    }
    falhas.current = 0;
    void conectar(0);
    return () => {
      vivo.current = false;
      fechar();
    };
  }, [enabled, conectar, fechar]);

  // Background fecha, volta ao ativo reabre. Sem isto o iOS mata a conexão e o app
  // volta "conectado" na tela mas sem receber nada — o pior dos dois mundos.
  useEffect(() => {
    if (!enabled) return;
    const onChange = (status: AppStateStatus) => {
      if (status === 'active') {
        vivo.current = true;
        falhas.current = 0;
        void conectar(0);
      } else {
        vivo.current = false;
        fechar();
        setState({ connected: false, degraded: false });
      }
    };
    const sub = AppState.addEventListener('change', onChange);
    return () => sub.remove();
  }, [enabled, conectar, fechar]);

  return state;
}

/** Intervalo do polling quando o SSE desiste. */
export const POLL_FALLBACK_MS = 5_000;
