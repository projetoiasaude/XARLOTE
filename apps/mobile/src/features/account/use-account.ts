/**
 * Exportar meus dados e apagar minha conta — os dois direitos, como hooks.
 *
 * ## O export é assíncrono e a tela precisa saber disso
 *
 * `POST /app/export` responde 202 com um `exportId`; o arquivo é montado num worker
 * (dezenas de milhares de mensagens, às vezes). O hook faz polling do status e para
 * sozinho quando fica pronto ou falha — polling que não para é a forma mais fácil de
 * queimar bateria de alguém em segundo plano.
 *
 * ## O apagamento não tem estado "quase"
 *
 * Depois de um 202, a sessão do aparelho JÁ foi invalidada pelo servidor. Então o hook
 * chama `signOut()` local imediatamente: manter a tela logada com um token que o servidor
 * já rejeita produziria uma sequência de 401 e a impressão de que algo deu errado —
 * quando na verdade deu certo.
 */
import { useCallback, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api/client';
import { useSession } from '@/lib/auth/session';

export type StatusExport = 'pending' | 'ready' | 'failed';

interface ExportResumo {
  id: string;
  status: StatusExport;
  created_at: string;
  completed_at: string | null;
}

interface RespostaPedido {
  exportId: string;
  status: StatusExport;
  message?: string;
}

interface RespostaStatus {
  exportId: string;
  status: StatusExport;
  url?: string;
  expiraEmSegundos?: number;
  message?: string;
}

/** De quanto em quanto tempo o app pergunta se o arquivo ficou pronto. */
const INTERVALO_POLL_MS = 3_000;

/**
 * Teto de tentativas — 60 × 3s = 3 minutos.
 *
 * Não é para o caso normal (o arquivo sai em segundos): é para o caso em que o worker
 * morreu sem marcar `failed`. Sem teto, a tela ficaria "preparando" para sempre, que é
 * exatamente o estado que não explica nada a ninguém.
 */
const MAX_POLLS = 60;

export function useExports() {
  const { user } = useSession();
  return useQuery<{ exports: ExportResumo[] }>({
    queryKey: ['exports', user?.id ?? 'anon'],
    queryFn: () => apiFetch<{ exports: ExportResumo[] }>('/app/export'),
    enabled: user !== null,
    staleTime: 30_000,
  });
}

export interface EstadoExport {
  pedir: () => void;
  pedindo: boolean;
  /** null = nada em andamento. */
  status: StatusExport | null;
  /** Link assinado, curto. Só existe quando `status === 'ready'`. */
  url: string | null;
  erro: string | null;
  desistiu: boolean;
}

export function useExportarDados(): EstadoExport {
  const qc = useQueryClient();
  const { user } = useSession();
  const [exportId, setExportId] = useState<string | null>(null);
  const [tentativas, setTentativas] = useState(0);
  const [erro, setErro] = useState<string | null>(null);

  const pedido = useMutation<RespostaPedido, Error, void>({
    mutationFn: () => apiFetch<RespostaPedido>('/app/export', { method: 'POST' }),
    onSuccess: (r) => {
      setExportId(r.exportId);
      setTentativas(0);
      setErro(null);
      void qc.invalidateQueries({ queryKey: ['exports', user?.id ?? 'anon'] });
    },
    onError: (e) => setErro(e.message),
  });

  const desistiu = tentativas >= MAX_POLLS;

  const consulta = useQuery<RespostaStatus>({
    queryKey: ['export', exportId],
    queryFn: async () => {
      setTentativas((n) => n + 1);
      return apiFetch<RespostaStatus>(`/app/export/${exportId}`);
    },
    enabled: exportId !== null && !desistiu,
    // `false` PARA o polling. Sem isto o app continuaria perguntando pra sempre depois
    // de o arquivo ficar pronto — em segundo plano, na bateria de alguém.
    refetchInterval: (q) => {
      const s = q.state.data?.status;
      return s === 'ready' || s === 'failed' ? false : INTERVALO_POLL_MS;
    },
    staleTime: 0,
  });

  const pedir = useCallback(() => {
    setErro(null);
    pedido.mutate();
  }, [pedido]);

  return {
    pedir,
    pedindo: pedido.isPending,
    status: consulta.data?.status ?? (pedido.isPending ? 'pending' : null),
    url: consulta.data?.status === 'ready' ? (consulta.data.url ?? null) : null,
    erro,
    desistiu,
  };
}

export interface EstadoApagar {
  apagar: (confirmacao: string) => void;
  apagando: boolean;
  erro: string | null;
}

export function useApagarConta(): EstadoApagar {
  const { signOut } = useSession();
  const [erro, setErro] = useState<string | null>(null);

  const m = useMutation<{ ok: boolean; message?: string }, Error, string>({
    mutationFn: (confirmacao) =>
      apiFetch<{ ok: boolean; message?: string }>('/app/account', {
        method: 'DELETE',
        body: { confirmacao },
      }),
    onSuccess: () => {
      // O servidor já invalidou a sessão. Sair aqui na hora evita uma sequência de 401
      // que pareceria erro num fluxo que deu certo. `signOut` também limpa o cache de
      // dado clínico do aparelho — o apagamento não é só do lado do servidor.
      void signOut();
    },
    onError: (e) => setErro(e.message),
  });

  const apagar = useCallback(
    (confirmacao: string) => {
      setErro(null);
      m.mutate(confirmacao);
    },
    [m],
  );

  return { apagar, apagando: m.isPending, erro };
}
