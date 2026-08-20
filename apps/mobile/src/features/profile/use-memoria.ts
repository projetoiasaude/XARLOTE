/**
 * A memória da Xarlote como hook: ler, e (quando a API deixar) apagar um item.
 *
 * ## Uma consulta, não duas
 *
 * Os memory cards já vêm no `GET /app/overview` (até 80, ordenados por `last_seen_at`).
 * Criar um `GET /app/memory` só pro Perfil custaria uma segunda ida à rede pelo mesmo
 * dado — em rede de celular, que é onde este app vive. Então este hook DERIVA do
 * overview e não fala com a rede sozinho.
 *
 * ## O apagamento é o pedaço que falta, e ele está escrito aqui de propósito
 *
 * `useEsquecerCard` chama uma rota que **ainda não existe**. Ele fica no repositório,
 * completo e ligado ao interruptor `APAGAR_CARD_DISPONIVEL` (em `./memoria.ts`), porque
 * a alternativa era entregar a tela sem o caminho — e aí quem for escrever a rota
 * precisaria adivinhar o contrato que a interface espera. Com isto no lugar, subir o
 * apagamento é: criar a rota, virar a constante, apagar duas linhas de aviso na tela.
 *
 * Nada nesta versão CHAMA `esquecer` — a tela só desenha o botão quando o interruptor
 * está ligado. Botão que falha é pior que botão ausente; promessa sem nada atrás é pior
 * que as duas.
 */
import { useCallback, useMemo } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api/client';
import { useSession } from '@/lib/auth/session';
import { OVERVIEW_KEY, useOverview } from '@/features/health/use-overview';
import type { MemoryCard } from '@/features/health/overview';
import {
  APAGAR_CARD_DISPONIVEL,
  resumoDeMemoria,
  type ResumoMemoria,
} from './memoria';

export interface EstadoMemoria {
  cards: MemoryCard[];
  resumo: ResumoMemoria;
  carregando: boolean;
  erro: unknown;
  recarregar: () => void;
  recarregando: boolean;
}

export function useMemoria(): EstadoMemoria {
  const q = useOverview();
  const cards = q.data?.memoryCards ?? [];

  // `resumoDeMemoria` percorre os 80 cards contando origem. Memoizar pelo array evita
  // refazer a conta a cada render do Perfil (o `refetch` do overview troca o array; um
  // toque no interruptor de biometria, não).
  const resumo = useMemo(() => resumoDeMemoria(cards), [cards]);

  const refetch = q.refetch;
  const recarregar = useCallback(() => void refetch(), [refetch]);

  return {
    cards,
    resumo,
    // `isLoading` e não `isFetching`: um refetch de fundo com dado em mãos não é
    // "carregando" — trocar a lista por esqueleto nesse caso pisca a tela por nada.
    carregando: q.isLoading,
    erro: q.error,
    recarregar,
    recarregando: q.isRefetching,
  };
}

export interface EstadoEsquecer {
  esquecer: (id: string) => void;
  apagando: boolean;
  erro: Error | null;
  /** `false` hoje. Enquanto for, a tela não desenha o botão. */
  disponivel: boolean;
}

/**
 * Apagar UMA anotação.
 *
 * O contrato que a rota precisa cumprir: `DELETE /app/memory/:id`, autenticado por
 * `requirePatient`, apagando de `memory_cards_index` **e** do `conversations.memory_cards`
 * (o JSONB é a fonte canônica pela LGPD — apagar só o espelho indexado deixaria o card
 * vivo pra Xarlote e morto pra tela, que é a pior combinação possível). 204 no sucesso,
 * 404 quando o id não é do paciente.
 */
export function useEsquecerCard(): EstadoEsquecer {
  const qc = useQueryClient();
  const { user } = useSession();

  const m = useMutation<void, Error, string>({
    mutationFn: (id) => apiFetch<void>(`/app/memory/${id}`, { method: 'DELETE' }),
    // Sem update otimista: "apagado" é afirmação sobre o BANCO. Tirar o card da tela
    // antes da confirmação do servidor é exatamente a mentira que a tela de privacidade
    // foi construída pra evitar — num app de saúde, sumir com um dado que continua lá é
    // pior do que demorar meio segundo pra sumir com ele de verdade.
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: [OVERVIEW_KEY, user?.id ?? 'anon'] });
    },
  });

  return {
    // `m.mutate` e não `m` nas dependências de quem chamar: o objeto do useMutation é
    // novo a cada render e mataria o `memo` do cartão. `mutate` é estável.
    esquecer: m.mutate,
    apagando: m.isPending,
    erro: m.error,
    disponivel: APAGAR_CARD_DISPONIVEL,
  };
}
