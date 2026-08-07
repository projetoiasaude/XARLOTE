/**
 * A sessão do paciente — a única fonte de verdade sobre "quem está usando o app".
 *
 * Ela liga três peças que não se conhecem:
 *   · o token-store (Keychain/Keystore),
 *   · o cliente HTTP (que precisa dos tokens e devolve as rotações),
 *   · a decisão de rota (função pura em ./route-decision.ts).
 *
 * Detalhe que não é detalhe: os tokens vivem num `useRef`, não em `useState`. O
 * cliente HTTP lê o token no momento EXATO do request, e state em React é assíncrono
 * — durante o re-render um request usaria o token velho e tomaria 401 à toa. O state
 * existe só pra a UI reagir.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import { connectAuthBridge } from '@/lib/api/client';
import { logout as apiLogout, type AuthUser, type VerifyResult } from '@/lib/api/auth';
import { clearQueryCache } from '@/lib/query';
import {
  clearSession,
  isLockEnabled as readLockEnabled,
  loadSession,
  saveSession,
  saveTokens,
  setLockEnabled as writeLockEnabled,
} from './token-store';
import { decideGate, shouldRelock, type AuthGate } from './route-decision';

interface SessionState {
  restored: boolean;
  user: AuthUser | null;
  consentRequired: boolean;
  lockEnabled: boolean;
  unlocked: boolean;
}

interface SessionApi extends SessionState {
  gate: AuthGate;
  signIn: (result: VerifyResult) => Promise<void>;
  signOut: () => Promise<void>;
  markConsented: () => void;
  unlock: () => void;
  setLockEnabled: (enabled: boolean) => Promise<void>;
}

const Ctx = createContext<SessionApi | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const tokens = useRef<{ access: string | null; refresh: string | null }>({ access: null, refresh: null });
  const backgroundedAt = useRef<number | null>(null);

  const [state, setState] = useState<SessionState>({
    restored: false,
    user: null,
    consentRequired: false,
    lockEnabled: false,
    unlocked: true,
  });

  const signOut = useCallback(async () => {
    // Avisa o servidor por gentileza (revoga a sessão do lado de lá), mas a limpeza
    // LOCAL acontece de qualquer jeito: se a rede estiver fora, deixar o token no
    // aparelho seria pior do que uma sessão órfã no banco.
    if (tokens.current.access) {
      try {
        await apiLogout();
      } catch {
        /* sessão do servidor expira sozinha */
      }
    }
    tokens.current = { access: null, refresh: null };
    await clearSession();
    // Dado clínico não sobrevive à sessão no aparelho. Fica AQUI e não na tela de
    // perfil porque a sessão também morre sozinha (token revogado, conta apagada) —
    // e nesses caminhos ninguém passa pelo botão de sair.
    clearQueryCache();
    setState((s) => ({ ...s, user: null, consentRequired: false, lockEnabled: false, unlocked: true }));
  }, []);

  // O cliente HTTP precisa saber ler/escrever tokens sem conhecer React.
  useEffect(() => {
    connectAuthBridge({
      getAccessToken: () => tokens.current.access,
      getRefreshToken: () => tokens.current.refresh,
      onRotated: (access, refresh) => {
        // Rotação que chegou TARDE, de uma sessão que já acabou: descarta.
        // O caso real é o paciente sair da conta com um refresh em voo — a resposta
        // volta depois do clearSession e gravaria o par novo no Keychain, deixando
        // uma sessão viva num app que diz estar deslogado. Ter apagado o refresh de
        // memória é justamente a marca de que não há mais sessão pra rotacionar.
        if (tokens.current.refresh === null) return;
        tokens.current = { access, refresh };
        void saveTokens(access, refresh).catch(() => {
          // Keychain recusou a escrita: a sessão segue viva em memória e o paciente
          // continua usando o app; ele só vai precisar entrar de novo no próximo
          // arranque. Melhor do que derrubar quem está no meio de uma conversa.
        });
      },
      onSignedOut: () => {
        tokens.current = { access: null, refresh: null };
        void clearSession();
        clearQueryCache();
        setState((s) => ({ ...s, user: null, consentRequired: false, unlocked: true }));
      },
    });
  }, []);

  // Arranque: lê o disco UMA vez. Enquanto isso o gate fica em 'loading' e nenhuma
  // tela decide nada — é o que impede o pisca-pisca de login em app já logado.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [session, lockEnabled] = await Promise.all([loadSession(), readLockEnabled()]);
      if (cancelled) return;
      if (session) tokens.current = { access: session.accessToken, refresh: session.refreshToken };
      setState({
        restored: true,
        user: session?.user ?? null,
        // Em arranque frio o consentimento é confirmado pelo /app/me; assumir
        // "pendente" aqui mostraria a tela de termos a quem já aceitou.
        consentRequired: false,
        lockEnabled,
        // Arranque frio SEMPRE travado quando há cadeado — é o ponto do cadeado.
        unlocked: !lockEnabled,
      });
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Volta do background: re-trava se ficou fora tempo demais (ver RELOCK_AFTER_MS).
  useEffect(() => {
    const onChange = (status: AppStateStatus) => {
      if (status === 'active') {
        const away = backgroundedAt.current;
        backgroundedAt.current = null;
        if (shouldRelock(away, Date.now())) {
          setState((s) => (s.lockEnabled ? { ...s, unlocked: false } : s));
        }
      } else if (status === 'background') {
        backgroundedAt.current = Date.now();
      }
    };
    const sub = AppState.addEventListener('change', onChange);
    return () => sub.remove();
  }, []);

  const signIn = useCallback(async (result: VerifyResult) => {
    tokens.current = { access: result.accessToken, refresh: result.refreshToken };
    // Se o Keychain recusar a escrita, o login NÃO falha: o código estava certo e a
    // sessão vale em memória. Deixar a exceção subir faria a tela do OTP dizer
    // "esse código não confere" pra quem digitou o código certo — mentira, e o
    // paciente ainda queimaria uma das 3 tentativas tentando de novo.
    try {
      await saveSession({
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
        user: result.user,
      });
    } catch {
      /* sessão só nesta execução — no próximo arranque pede login de novo */
    }
    setState((s) => ({
      ...s,
      restored: true,
      user: result.user,
      consentRequired: result.consentRequired,
      // Acabou de provar posse do WhatsApp por OTP — pedir o dedo agora é atrito puro.
      unlocked: true,
    }));
  }, []);

  const value = useMemo<SessionApi>(
    () => ({
      ...state,
      gate: decideGate({
        restored: state.restored,
        hasSession: state.user !== null,
        consentRequired: state.consentRequired,
        lockEnabled: state.lockEnabled,
        unlocked: state.unlocked,
      }),
      signIn,
      signOut,
      markConsented: () => setState((s) => ({ ...s, consentRequired: false })),
      unlock: () => setState((s) => ({ ...s, unlocked: true })),
      setLockEnabled: async (enabled: boolean) => {
        await writeLockEnabled(enabled);
        setState((s) => ({ ...s, lockEnabled: enabled, unlocked: true }));
      },
    }),
    [state, signIn, signOut],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession(): SessionApi {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useSession fora do SessionProvider');
  return ctx;
}
