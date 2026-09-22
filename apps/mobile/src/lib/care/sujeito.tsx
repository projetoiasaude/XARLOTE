/**
 * De quem é a bolsa que está aberta na tela.
 *
 * O app inteiro era de uma pessoa só: o JWT dizia quem era, e todas as telas liam o
 * próprio registro. Com o cuidado compartilhado, a mesma tela de Saúde, Lembretes ou
 * Exames pode estar mostrando o registro da mãe.
 *
 * ─── DUAS DECISÕES QUE EVITAM O PIOR ERRO DE UI ───────────────────────────────
 * O pior erro aqui não é técnico, é de leitura: alguém olhar o exame da mãe achando que é
 * o dele, ou registrar uma dose no prontuário errado por não ter percebido a troca.
 *
 * 1. **NÃO persiste.** A pessoa escolhida vive só em memória, e todo arranque do app volta
 *    pra você mesmo. Um seletor que "lembra" faria alguém abrir o app dias depois já
 *    dentro do registro de outra pessoa, sem ter escolhido isso naquele momento.
 * 2. **O nome vai na moldura**, em todas as telas, não só na que trocou. Ver
 *    `components/xarlote/Screen.tsx`.
 *
 * A troca também não precisa de invalidação manual de cache: as chaves do React Query
 * carregam o id do sujeito, então cada pessoa tem o seu e voltar é instantâneo.
 */
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { useSession } from '@/lib/auth/session';
import { comSujeito } from './rotas';

export interface PessoaCuidada {
  id: string;
  nome: string | null;
  relation: string;
  tipo: 'vinculo' | 'dependente';
}

interface SujeitoCtx {
  /** `null` = eu mesmo. */
  pessoa: PessoaCuidada | null;
  /** O id que vai no `?subject=` — `null` quando é o próprio (o parâmetro nem é enviado). */
  subjectId: string | null;
  /** `true` quando a tela NÃO está mostrando o registro de quem está logado. */
  cuidandoDeOutro: boolean;
  trocarPara: (p: PessoaCuidada | null) => void;
  voltarParaMim: () => void;
}

const Ctx = createContext<SujeitoCtx | null>(null);

export function SujeitoProvider({ children }: { children: ReactNode }) {
  const [pessoa, setPessoa] = useState<PessoaCuidada | null>(null);

  const trocarPara = useCallback((p: PessoaCuidada | null) => setPessoa(p), []);
  const voltarParaMim = useCallback(() => setPessoa(null), []);

  const valor = useMemo<SujeitoCtx>(
    () => ({
      pessoa,
      subjectId: pessoa?.id ?? null,
      cuidandoDeOutro: pessoa !== null,
      trocarPara,
      voltarParaMim,
    }),
    [pessoa, trocarPara, voltarParaMim],
  );

  return <Ctx.Provider value={valor}>{children}</Ctx.Provider>;
}

export function useSujeito(): SujeitoCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error('useSujeito fora do SujeitoProvider');
  return c;
}

/**
 * 🤝 `doProprio` — "esta chamada é MINHA, mesmo com a bolsa de outra pessoa aberta".
 *
 * Existe por causa do chat. A conversa é sempre a de quem está logado (o `POST
 * /app/messages` não tem sujeito, e o histórico é o do JWT), e o `HojeCard` mora dentro
 * dela: sem esta saída, ele mostrava a dose da mãe numa tela SEM o chip da moldura
 * (`app/(main)/index.tsx` não usa `Screen`), e o "Já tomei" dali parecia do próprio.
 *
 * Fora esse caso, todo dado de tela segue o sujeito escolhido.
 */
function sujeitoEfetivo(subjectId: string | null, doProprio: boolean): string | null {
  return doProprio ? null : subjectId;
}

/**
 * A rota com o sujeito dentro, quando houver. Uma função só, que decide entre `?` e `&`
 * olhando a rota — ver `./rotas.ts` pra saber qual logout isso evita.
 */
export function useComSujeito(doProprio = false): (rota: string) => string {
  const { subjectId } = useSujeito();
  const alvo = sujeitoEfetivo(subjectId, doProprio);
  return useCallback((rota: string) => comSujeito(rota, alvo), [alvo]);
}

/**
 * A chave de cache. Duas pessoas nunca compartilham cache — é o que impede a tela de
 * mostrar o exame de uma enquanto o cabeçalho diz o nome da outra.
 */
export function useChaveDoSujeito(doProprio = false): string {
  const { subjectId } = useSujeito();
  const { user } = useSession();
  return `${user?.id ?? 'anon'}:${sujeitoEfetivo(subjectId, doProprio) ?? 'eu'}`;
}
