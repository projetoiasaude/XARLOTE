/**
 * `GET /app/overview` como hook — a fonte de TODAS as telas de dados.
 *
 * Uma chamada alimenta Saúde, Atividade e o Perfil 360 porque o backend agrega as 14
 * consultas em paralelo (`lib/app-overview.ts`). Três telas com três endpoints
 * pareceria mais organizado e custaria três idas à rede numa conexão de celular.
 *
 * `enabled: user !== null` pela mesma razão do `useMe`: no arranque frio a tela logada
 * chega a montar por um instante antes da guarda redirecionar, e sem isso o app dispara
 * uma busca de prontuário sem token.
 */
import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api/client';
import { useSession } from '@/lib/auth/session';
import type { Overview } from './overview';

export const OVERVIEW_KEY = 'overview';

export function useOverview() {
  const { user } = useSession();
  return useQuery<Overview>({
    queryKey: [OVERVIEW_KEY, user?.id ?? 'anon'],
    queryFn: () => apiFetch<Overview>('/app/overview'),
    enabled: user !== null,
    // Prontuário não muda de segundo em segundo, e a resposta é grande (até 180 linhas
    // de log de dose). 2 minutos evita refetch a cada troca de aba sem deixar a tela
    // velha: qualquer ação do paciente invalida a chave na hora.
    staleTime: 120_000,
  });
}
