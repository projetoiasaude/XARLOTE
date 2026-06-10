'use client';
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
import { getPairedPhone, setPairedPhone, clearPairedPhone } from './pairing';
import { fetchOverview } from './api';
import type { XarOverview } from './types';

interface XarloteAppCtx {
  /** Telefone pareado (E.164) — null = não pareado */
  phone: string | null;
  /** true depois de hidratar o localStorage (evita flash/redirect indevido) */
  ready: boolean;
  pair: (phoneE164: string) => void;
  unpair: () => void;
  overview: XarOverview | null;
  overviewLoading: boolean;
  overviewError: string | null;
  /** true quando o telefone pareado ainda não existe no backend (onboarding) */
  unknownUser: boolean;
  refreshOverview: () => Promise<void>;
  /** Xarlote “digitando” (setado pelo chat; o orb pulsa junto) */
  typing: boolean;
  setTyping: (b: boolean) => void;
}

const Ctx = createContext<XarloteAppCtx | null>(null);

export function XarloteAppProvider({ children }: { children: ReactNode }) {
  const [phone, setPhone] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [overview, setOverview] = useState<XarOverview | null>(null);
  const [overviewLoading, setOverviewLoading] = useState(false);
  const [overviewError, setOverviewError] = useState<string | null>(null);
  const [unknownUser, setUnknownUser] = useState(false);
  const [typing, setTyping] = useState(false);
  const inflight = useRef(false);

  useEffect(() => {
    setPhone(getPairedPhone());
    setReady(true);
  }, []);

  const refreshOverview = useCallback(async () => {
    if (!phone || inflight.current) return;
    inflight.current = true;
    setOverviewLoading(true);
    try {
      const data = await fetchOverview(phone);
      if (data) {
        setOverview(data);
        setUnknownUser(false);
      } else {
        setOverview(null);
        setUnknownUser(true);
      }
      setOverviewError(null);
    } catch (err) {
      setOverviewError(err instanceof Error ? err.message : 'erro ao carregar');
    } finally {
      setOverviewLoading(false);
      inflight.current = false;
    }
  }, [phone]);

  // Carrega + mantém fresco: intervalo de 30s e refetch ao voltar pro app
  useEffect(() => {
    if (!phone) return;
    void refreshOverview();
    const interval = setInterval(() => void refreshOverview(), 30_000);
    const onFocus = () => void refreshOverview();
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refreshOverview();
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(interval);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [phone, refreshOverview]);

  const pair = useCallback((p: string) => {
    setPairedPhone(p);
    setPhone(p);
    setOverview(null);
    setUnknownUser(false);
  }, []);

  const unpair = useCallback(() => {
    clearPairedPhone();
    setPhone(null);
    setOverview(null);
    setUnknownUser(false);
  }, []);

  const value = useMemo(
    () => ({
      phone,
      ready,
      pair,
      unpair,
      overview,
      overviewLoading,
      overviewError,
      unknownUser,
      refreshOverview,
      typing,
      setTyping,
    }),
    [phone, ready, pair, unpair, overview, overviewLoading, overviewError, unknownUser, refreshOverview, typing],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useXarloteApp(): XarloteAppCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useXarloteApp precisa do <XarloteAppProvider>');
  return ctx;
}
