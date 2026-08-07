/**
 * `GET /app/me` como hook — e com o `enabled` que impede a chamada sem sessão.
 *
 * O `enabled` não é detalhe de performance. Sem ele o React Query dispara a busca
 * assim que a tela monta, e no arranque frio a tela logada chega a montar por um
 * instante antes da guarda redirecionar pro login: o app mandava um request sem
 * token, tomava 401 e ainda tentava rotacionar um refresh que não existe.
 */
import { useQuery } from '@tanstack/react-query';
import { fetchMe, type MeResult } from './auth';
import { useSession } from '@/lib/auth/session';

export function useMe() {
  const { user } = useSession();
  return useQuery<MeResult>({
    queryKey: ['me', user?.id ?? 'anon'],
    queryFn: fetchMe,
    enabled: user !== null,
  });
}
