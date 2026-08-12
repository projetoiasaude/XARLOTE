/**
 * Lembretes: a lista e as ações, com eco otimista HONESTO.
 *
 * ## O que "honesto" quer dizer aqui
 *
 * O estado otimista não é um palpite bonito — é `lembreteOtimista()`, que aplica a
 * MESMA função pura que o servidor vai aplicar (`reminderActionPatch`, de shared). Um
 * "feito" em lembrete recorrente aparece na hora já como "próximo amanhã às 7h",
 * porque é isso que o servidor vai responder. E quando a função diz que o servidor
 * recusaria (cancelado é terminal), a tela não finge ter feito nada.
 *
 * ## Rollback é obrigatório, não zelo
 *
 * Toda ação guarda a lista anterior e a restaura no erro. Sem isso, um toque em
 * "confirmei o remédio" que falhou na rede deixaria a tela dizendo que a dose foi
 * tomada — e o paciente confia nessa tela pra saber se já tomou. É a diferença entre
 * uma UI otimista e uma UI que mente.
 */
import { useCallback } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ReminderAppAction } from '@iasaude/shared';
import { apiFetch } from '@/lib/api/client';
import { useSession } from '@/lib/auth/session';
import { OVERVIEW_KEY } from '@/features/health/use-overview';
import type { ReminderRow } from '@/features/health/overview';
import { lembreteOtimista } from './format';

export const REMINDERS_KEY = 'reminders';

interface ListaResposta {
  reminders: ReminderRow[];
}

interface AcaoResposta {
  ok: boolean;
  reminder: ReminderRow | null;
}

export function useReminders() {
  const { user } = useSession();
  return useQuery<ListaResposta>({
    queryKey: [REMINDERS_KEY, user?.id ?? 'anon'],
    queryFn: () => apiFetch<ListaResposta>('/app/reminders'),
    enabled: user !== null,
    staleTime: 60_000,
  });
}

export interface AcaoLembrete {
  id: string;
  acao: ReminderAppAction;
  minutos?: number;
}

export function useReminderAction() {
  const { user } = useSession();
  const qc = useQueryClient();
  const chave = [REMINDERS_KEY, user?.id ?? 'anon'];

  const mutation = useMutation<AcaoResposta, Error, AcaoLembrete, { anterior: ListaResposta | undefined }>({
    mutationFn: ({ id, acao, minutos }) =>
      apiFetch<AcaoResposta>(`/app/reminders/${id}/action`, {
        method: 'POST',
        body: { action: acao, ...(minutos !== undefined ? { minutes: minutos } : {}) },
      }),

    onMutate: async ({ id, acao, minutos }) => {
      // Cancela refetch em voo: uma resposta antiga chegando DEPOIS do patch otimista
      // sobrescreveria a linha de volta pro estado anterior — o "pisca e volta".
      await qc.cancelQueries({ queryKey: chave });
      const anterior = qc.getQueryData<ListaResposta>(chave);

      qc.setQueryData<ListaResposta>(chave, (atual) => {
        if (!atual) return atual;
        return {
          reminders: atual.reminders.map((r) => {
            if (r.id !== id) return r;
            // `null` = o servidor recusaria; mantém a linha como está.
            return lembreteOtimista(r, acao, minutos, Date.now()) ?? r;
          }),
        };
      });

      return { anterior };
    },

    onError: (_err, _vars, ctx) => {
      if (ctx?.anterior) qc.setQueryData(chave, ctx.anterior);
    },

    onSuccess: (data) => {
      // A linha REAL do servidor substitui a otimista. Elas devem ser iguais (mesma
      // função pura decidiu as duas); quando não forem, a do servidor é a verdade.
      if (!data.reminder) return;
      qc.setQueryData<ListaResposta>(chave, (atual) =>
        atual ? { reminders: atual.reminders.map((r) => (r.id === data.reminder!.id ? data.reminder! : r)) } : atual,
      );
    },

    onSettled: () => {
      // O prontuário mostra os mesmos lembretes e a adesão muda com um "feito":
      // invalidar aqui é o que evita a Saúde 360 discordar da tela de Lembretes.
      void qc.invalidateQueries({ queryKey: [OVERVIEW_KEY, user?.id ?? 'anon'] });
    },
  });

  const agir = useCallback(
    (id: string, acao: ReminderAppAction, minutos?: number) => {
      mutation.mutate({ id, acao, ...(minutos !== undefined ? { minutos } : {}) });
    },
    [mutation],
  );

  return { agir, emAndamento: mutation.isPending, idEmAndamento: mutation.variables?.id ?? null };
}
