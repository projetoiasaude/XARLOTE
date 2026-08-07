/**
 * React Query + cache em disco (MMKV).
 *
 * Por que persistir: o paciente abre o app no ônibus, no elevador, na fila da
 * farmácia — lugares sem sinal. Sem cache em disco a tela abre vazia e parece que os
 * dados sumiram. Com cache, abre com o que já sabia e atualiza quando a rede voltar.
 *
 * MMKV e não SecureStore: aqui é CACHE de tela, não segredo. Token nenhum passa por
 * este arquivo (ver auth/token-store.ts). Ainda assim o cache é limpo no logout —
 * dado clínico não fica no aparelho depois que a sessão acaba.
 */
import { QueryClient } from '@tanstack/react-query';
import { createSyncStoragePersister } from '@tanstack/query-sync-storage-persister';
import { createMMKV } from 'react-native-mmkv';
import { ApiError } from './api/errors';

// MMKV v4 trocou `new MMKV()` pela fábrica `createMMKV()` (o binding virou Nitro).
const storage = createMMKV({ id: 'xarlote.cache' });

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: 24 * 60 * 60 * 1000,
      retry: (failureCount, error) => {
        // Não insistir no que não vai melhorar: 401 já foi tratado pelo cliente
        // (refresh + retry), e 4xx de regra de negócio só repete o mesmo erro.
        if (error instanceof ApiError && !error.failure.retryable) return false;
        return failureCount < 2;
      },
      refetchOnReconnect: true,
    },
  },
});

export const queryPersister = createSyncStoragePersister({
  storage: {
    getItem: (key) => storage.getString(key) ?? null,
    setItem: (key, value) => storage.set(key, value),
    // v4 renomeou `delete` pra `remove`.
    removeItem: (key) => {
      storage.remove(key);
    },
  },
});

/** Chamado no logout — o prontuário não sobrevive à sessão. */
export function clearQueryCache(): void {
  queryClient.clear();
  storage.clearAll();
}
