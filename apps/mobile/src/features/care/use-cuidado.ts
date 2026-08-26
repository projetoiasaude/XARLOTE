/**
 * Cuidado compartilhado, do lado do app.
 *
 * ## O código existe uma vez e some
 *
 * Mesma propriedade do link do médico: o banco guarda só o hash, e a resposta da criação é
 * o único momento em que os seis dígitos existem em texto claro. Por isso ele fica no
 * estado do hook, e não no cache do React Query — que é persistido em MMKV, e guardar ali
 * um código que abre prontuário seria deixá-lo no disco do aparelho.
 *
 * Se a pessoa sair da tela sem passar o código, ela gera outro. Não há como recuperar, e
 * isso é o desenho, não uma falha.
 */
import { useCallback, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api/client';
import { useSession } from '@/lib/auth/session';

export interface PessoaDoVinculo {
  id: string;
  nome: string | null;
}

export interface QuemEuCuido {
  pessoa: PessoaDoVinculo;
  relation: string;
  tipo: 'vinculo' | 'dependente';
}

export interface QuemMeCuida {
  vinculoId: string;
  pessoa: PessoaDoVinculo;
  relation: string;
  desde: string;
}

export interface Vinculos {
  cuido: QuemEuCuido[];
  cuidamDeMim: QuemMeCuida[];
}

export interface CodigoGerado {
  codigo: string;
  expiraEm: string;
}

const CHAVE = 'care-links';

/** Como o parentesco é lido na tela. Espelha `descreverParentesco` do backend. */
export const RELACOES: ReadonlyArray<{ valor: string; rotulo: string }> = [
  { valor: 'mae', rotulo: 'Minha mãe' },
  { valor: 'pai', rotulo: 'Meu pai' },
  { valor: 'avo', rotulo: 'Meu avô / minha avó' },
  { valor: 'filho', rotulo: 'Meu filho' },
  { valor: 'filha', rotulo: 'Minha filha' },
  { valor: 'conjuge', rotulo: 'Meu cônjuge' },
  { valor: 'irmao', rotulo: 'Meu irmão' },
  { valor: 'irma', rotulo: 'Minha irmã' },
  { valor: 'neto', rotulo: 'Meu neto' },
  { valor: 'neta', rotulo: 'Minha neta' },
  { valor: 'outro', rotulo: 'Outro' },
];

export function rotuloDaRelacao(valor: string): string {
  return RELACOES.find((r) => r.valor === valor)?.rotulo ?? 'Outro';
}

export function useVinculos() {
  const { user } = useSession();
  return useQuery<Vinculos>({
    queryKey: [CHAVE, user?.id ?? 'anon'],
    queryFn: () => apiFetch<Vinculos>('/app/care/links'),
    enabled: user !== null,
    staleTime: 60_000,
  });
}

/** Gera o código que EU entrego a quem vai cuidar de mim. */
export function useGerarCodigo() {
  const [codigo, setCodigo] = useState<CodigoGerado | null>(null);
  const m = useMutation({
    mutationFn: () => apiFetch<CodigoGerado>('/app/care/invites', { method: 'POST', body: {} }),
    onSuccess: (r) => setCodigo(r),
  });
  const esquecer = useCallback(() => setCodigo(null), []);
  return { ...m, codigo, esquecer };
}

/** Resgato o código de alguém pra passar a acompanhar essa pessoa. */
export function useConectar() {
  const qc = useQueryClient();
  const { user } = useSession();
  return useMutation({
    mutationFn: (corpo: { codigo: string; relation: string }) =>
      apiFetch<{ vinculoId: string; pessoa: PessoaDoVinculo }>('/app/care/links', { method: 'POST', body: corpo }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: [CHAVE, user?.id ?? 'anon'] }),
  });
}

/** Crio o perfil de quem não tem WhatsApp próprio (uma criança). */
export function useCriarDependente() {
  const qc = useQueryClient();
  const { user } = useSession();
  return useMutation({
    mutationFn: (corpo: { nome: string; relation: string; nascimento?: string }) =>
      apiFetch<{ vinculoId: string; pessoa: PessoaDoVinculo }>('/app/care/dependents', { method: 'POST', body: corpo }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: [CHAVE, user?.id ?? 'anon'] }),
  });
}

/**
 * Revogar. Serve pras duas direções — tirar o acesso de quem me acompanha, ou parar de
 * acompanhar alguém. É a mesma rota porque é a mesma operação: derrubar um vínculo.
 */
export function useRevogar() {
  const qc = useQueryClient();
  const { user } = useSession();
  return useMutation({
    mutationFn: (vinculoId: string) => apiFetch<{ ok: true }>(`/app/care/links/${vinculoId}`, { method: 'DELETE' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: [CHAVE, user?.id ?? 'anon'] }),
  });
}
