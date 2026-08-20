/**
 * Lembretes: as duas listas, a criação e as ações, com eco otimista HONESTO.
 *
 * ## Duas consultas, porque são dois problemas diferentes
 *
 * `useReminders` pede `?scope=active`: um conjunto pequeno, limitado pelo tratamento
 * real, que a tela precisa ter na mão para responder "o que eu faço agora?".
 *
 * `useHistoricoLembretes` pede `?scope=history` e **só é habilitada quando o paciente
 * abre a seção**. O histórico cresce para sempre — o do paciente de dois anos tem
 * centenas de linhas — e ele não responde à pergunta da tela. Abrir a aba de Lembretes
 * não baixa histórico nenhum: em rede móvel isso é a diferença entre uma requisição
 * pequena e a lista inteira da vida do paciente.
 *
 * O `gcTime` curto do histórico é deliberado: o cache do app é persistido em disco
 * (MMKV) e reserializado inteiro a cada mudança. Guardar por 24h um acervo que a pessoa
 * abriu uma vez engorda esse blob para sempre. A lista VIVA vale cache offline; o
 * cemitério não.
 *
 * ## O eco otimista aqui não é um chute
 *
 * O estado otimista é `lembreteOtimista()`, que aplica a MESMA função pura que o
 * servidor vai aplicar (`reminderActionPatch`, de shared). Um "feito" em lembrete
 * recorrente aparece na hora já como "próximo amanhã às 7h", porque é isso que o
 * servidor vai responder. E quando a função diz que o servidor recusaria (cancelado é
 * terminal), a tela não finge ter feito nada.
 *
 * ## Rollback é obrigatório, não zelo
 *
 * Toda ação guarda a lista anterior e a restaura no erro. Sem isso, um toque em
 * "confirmei o remédio" que falhou na rede deixaria a tela dizendo que a dose foi
 * tomada — e o paciente confia nessa tela pra saber se já tomou. É a diferença entre
 * uma UI otimista e uma UI que mente.
 */
import { useCallback } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ReminderAppAction } from '@iasaude/shared';
import { apiFetch } from '@/lib/api/client';
import { useSession } from '@/lib/auth/session';
import { OVERVIEW_KEY } from '@/features/health/use-overview';
import type { ReminderRow } from '@/features/health/overview';
import { lembreteOtimista, type CorpoNovoLembrete } from './format';

export const REMINDERS_KEY = 'reminders';
export const REMINDERS_HISTORY_KEY = 'reminders-history';

/** Página do histórico. Igual ao default da rota — pedir mais seria puxar mais. */
const HISTORICO_PAGINA = 12;

interface ListaAtivos {
  reminders: ReminderRow[];
  /**
   * O servidor cortou a lista viva. A tela DIZ isso em vez de mostrar a metade calada.
   *
   * Não existe um `limite` junto, e isso é deliberado: o servidor lê os vivos em duas
   * janelas que cortam de forma INDEPENDENTE, então nenhum número único descreve o que
   * veio. O único que a tela pode afirmar é `reminders.length`.
   */
  truncado?: boolean;
  /**
   * Quantos encerrados existem no banco — o número do cabeçalho recolhido, que chega
   * SEM as linhas. `null` quando a contagem falhou: aí a seção aparece sem número, e
   * nunca com zero (zero seria uma afirmação sobre o banco que ninguém verificou).
   */
  historico?: number | null;
}

interface PaginaHistorico {
  reminders: ReminderRow[];
  nextCursor: string | null;
}

interface AcaoResposta {
  ok: boolean;
  reminder: ReminderRow | null;
}

interface CriarResposta {
  ok: boolean;
  reminder: ReminderRow | null;
}

export function useReminders() {
  const { user } = useSession();
  return useQuery<ListaAtivos>({
    queryKey: [REMINDERS_KEY, user?.id ?? 'anon'],
    queryFn: () => apiFetch<ListaAtivos>('/app/reminders?scope=active'),
    enabled: user !== null,
    staleTime: 60_000,
  });
}

/**
 * O histórico, sob demanda e por cursor.
 *
 * `enabled: aberta` é o coração da coisa. Enquanto a seção está recolhida, esta query
 * não existe — nenhuma requisição, nenhuma linha em memória, nenhum byte no cache.
 */
export function useHistoricoLembretes(aberta: boolean) {
  const { user } = useSession();
  return useInfiniteQuery({
    queryKey: [REMINDERS_HISTORY_KEY, user?.id ?? 'anon'],
    enabled: user !== null && aberta,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      apiFetch<PaginaHistorico>(
        `/app/reminders?scope=history&limit=${HISTORICO_PAGINA}` +
          (pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ''),
      ),
    getNextPageParam: (ultima) => ultima.nextCursor,
    staleTime: 60_000,
    // Acervo não vale disco: 5 min depois de fechar a seção, sai do cache (e do blob
    // persistido). Ver o cabeçalho deste arquivo.
    gcTime: 5 * 60_000,
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
  const chaveHistorico = [REMINDERS_HISTORY_KEY, user?.id ?? 'anon'];

  const mutation = useMutation<AcaoResposta, Error, AcaoLembrete, { anterior: ListaAtivos | undefined }>({
    mutationFn: ({ id, acao, minutos }) =>
      apiFetch<AcaoResposta>(`/app/reminders/${id}/action`, {
        method: 'POST',
        body: { action: acao, ...(minutos !== undefined ? { minutes: minutos } : {}) },
      }),

    onMutate: async ({ id, acao, minutos }) => {
      // Cancela refetch em voo: uma resposta antiga chegando DEPOIS do patch otimista
      // sobrescreveria a linha de volta pro estado anterior — o "pisca e volta".
      await qc.cancelQueries({ queryKey: chave });
      const anterior = qc.getQueryData<ListaAtivos>(chave);

      qc.setQueryData<ListaAtivos>(chave, (atual) => {
        if (!atual) return atual;
        return {
          ...atual,
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
      qc.setQueryData<ListaAtivos>(chave, (atual) =>
        atual
          ? { ...atual, reminders: atual.reminders.map((r) => (r.id === data.reminder!.id ? data.reminder! : r)) }
          : atual,
      );
    },

    onSettled: () => {
      // O prontuário mostra os mesmos lembretes e a adesão muda com um "feito":
      // invalidar aqui é o que evita a Saúde 360 discordar da tela de Lembretes.
      void qc.invalidateQueries({ queryKey: [OVERVIEW_KEY, user?.id ?? 'anon'] });
      /**
       * O histórico é RESETADO, não invalidado.
       *
       * `invalidateQueries` numa infinite query refaz TODAS as páginas já carregadas,
       * em sequência — quem rolou 4 páginas pagaria 4 requisições por cada "cancelar".
       * `resetQueries` volta à página 1, que é exatamente onde o item recém-encerrado
       * vai aparecer, e custa uma requisição só (e nenhuma, se a seção estiver fechada).
       */
      void qc.resetQueries({ queryKey: chaveHistorico });
    },
  });

  const agir = useCallback(
    /**
     * `aoFalhar` é o par obrigatório da frase de confirmação que a tela mostra.
     *
     * O rollback aqui devolve a LINHA ao estado anterior, mas a tela guarda por fora o
     * que ela já disse ao paciente ("Anotado, o de hoje está feito."). Sem este aviso, a
     * ação que morreu na rede deixaria a frase no ar — e falha que vira sucesso na tela
     * é o defeito mais caro possível num app que a pessoa consulta pra saber se já tomou
     * o remédio. Vai como argumento, e não como dependência, pra não dar identidade nova
     * a `agir` em todo render.
     */
    (id: string, acao: ReminderAppAction, minutos?: number, aoFalhar?: () => void) => {
      mutation.mutate(
        { id, acao, ...(minutos !== undefined ? { minutos } : {}) },
        aoFalhar ? { onError: aoFalhar } : undefined,
      );
    },
    // `mutation.mutate` e NÃO `mutation`: o objeto de resultado do useMutation é NOVO a
    // cada render, então depender dele dava identidade nova a `agir` em todo render — e
    // o `memo` do ReminderCard, posto ali de propósito, não segurava nada. Uma linha de
    // dependência transformava um memo em enfeite.
    [mutation.mutate],
  );

  return { agir, emAndamento: mutation.isPending, idEmAndamento: mutation.variables?.id ?? null };
}

/**
 * Criar lembrete.
 *
 * Sem eco otimista, e isso é escolha: o servidor é quem decide o primeiro disparo
 * (`nextOccurrence`) e quem cobra o teto de lembretes ativos. Fingir na tela um lembrete
 * que o servidor pode recusar por teto faria a linha nascer e morrer — e num app de
 * saúde, "criei seu lembrete" tem que significar que ele existe no banco.
 */
export function useCriarLembrete() {
  const { user } = useSession();
  const qc = useQueryClient();

  return useMutation<CriarResposta, Error, CorpoNovoLembrete>({
    mutationFn: (corpo) => apiFetch<CriarResposta>('/app/reminders', { method: 'POST', body: corpo }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: [REMINDERS_KEY, user?.id ?? 'anon'] });
      void qc.invalidateQueries({ queryKey: [OVERVIEW_KEY, user?.id ?? 'anon'] });
    },
  });
}
