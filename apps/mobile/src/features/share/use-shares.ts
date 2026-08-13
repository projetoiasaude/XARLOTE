/**
 * O link do médico, do lado do paciente.
 *
 * ## O token existe uma vez e some
 *
 * A resposta da criação é o ÚNICO momento em que o link em texto claro existe — o banco
 * guarda só o hash. Por isso ele fica no estado do hook (não no cache do React Query, que
 * é persistido em disco): o link é um segredo com validade de horas, e escrevê-lo no MMKV
 * seria guardar uma chave de prontuário no armazenamento do aparelho.
 *
 * Se o paciente sair da tela sem copiar, ele gera outro. Não há como recuperar, e essa é
 * a propriedade do desenho, não uma falha.
 */
import { useCallback, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api/client';
import { useSession } from '@/lib/auth/session';

export interface ShareResumo {
  id: string;
  expiresAt: string;
  revokedAt: string | null;
  acessos: number;
  ultimoAcesso: string | null;
  criadoEm: string;
  comPin: boolean;
}

export interface LinkCriado {
  id: string;
  token: string;
  url: string | null;
  expiresAt: string;
  comPin: boolean;
}

const CHAVE = 'shares';

export function useShares() {
  const { user } = useSession();
  return useQuery<{ shares: ShareResumo[] }>({
    queryKey: [CHAVE, user?.id ?? 'anon'],
    queryFn: () => apiFetch<{ shares: ShareResumo[] }>('/app/shares'),
    enabled: user !== null,
    staleTime: 30_000,
  });
}

export function useCriarShare() {
  const qc = useQueryClient();
  const { user } = useSession();
  /** Fora do React Query de propósito — ver o cabeçalho: não persiste em disco. */
  const [criado, setCriado] = useState<LinkCriado | null>(null);
  const [erro, setErro] = useState<string | null>(null);

  const m = useMutation<LinkCriado, Error, { horas?: number; pin?: string }>({
    mutationFn: (body) => apiFetch<LinkCriado>('/app/shares', { method: 'POST', body }),
    onSuccess: (r) => {
      setCriado(r);
      setErro(null);
      void qc.invalidateQueries({ queryKey: [CHAVE, user?.id ?? 'anon'] });
    },
    onError: (e) => setErro(e.message),
  });

  const criar = useCallback(
    (horas?: number, pin?: string) => {
      setErro(null);
      m.mutate({ ...(horas ? { horas } : {}), ...(pin ? { pin } : {}) });
    },
    [m],
  );

  /** Chamado ao sair da tela: o link não fica na memória depois que ela fecha. */
  const esquecer = useCallback(() => setCriado(null), []);

  return { criar, criando: m.isPending, criado, erro, esquecer };
}

export function useRevogarShare() {
  const qc = useQueryClient();
  const { user } = useSession();

  const m = useMutation<{ ok: boolean }, Error, string>({
    mutationFn: (id) => apiFetch<{ ok: boolean }>(`/app/shares/${id}`, { method: 'DELETE' }),
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: [CHAVE, user?.id ?? 'anon'] });
      const antes = qc.getQueryData<{ shares: ShareResumo[] }>([CHAVE, user?.id ?? 'anon']);
      // Otimista: revogar é o botão de emergência ("mandei pro grupo errado"). Ele tem
      // que responder na hora, não depois do round-trip.
      qc.setQueryData<{ shares: ShareResumo[] }>([CHAVE, user?.id ?? 'anon'], (atual) =>
        atual
          ? {
              shares: atual.shares.map((s) =>
                s.id === id ? { ...s, revokedAt: new Date().toISOString() } : s,
              ),
            }
          : atual,
      );
      return { antes } as never;
    },
    onError: (_e, _id, ctx) => {
      const anterior = (ctx as unknown as { antes?: { shares: ShareResumo[] } })?.antes;
      if (anterior) qc.setQueryData([CHAVE, user?.id ?? 'anon'], anterior);
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: [CHAVE, user?.id ?? 'anon'] });
    },
  });

  return { revogar: m.mutate, revogando: m.isPending };
}
