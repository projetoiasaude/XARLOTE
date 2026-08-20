/**
 * O chat inteiro atrás de um hook.
 *
 * Junta três fontes que discordam entre si e precisam virar UMA lista:
 *   · as páginas do servidor (React Query, keyset, cache em disco),
 *   · os envios locais ainda não confirmados,
 *   · os eventos do SSE.
 *
 * A conciliação vive em `./merge.ts` e `./resync.ts`, que são puros e testados. Aqui
 * fica só o que inevitavelmente tem estado: a fila de pendentes, o resync e o polling
 * de reserva.
 *
 * ## O resync mudou de mecânica (e o comentário passou a ser verdade)
 *
 * Antes: `invalidateQueries`, que numa infinite query refaz TODAS as páginas carregadas
 * — a cada evento do SSE e a cada 5s no modo degradado. Ver o cabeçalho de `resync.ts`
 * pro fonte que prova isso e pro motivo de `maxPages` ser a receita errada.
 *
 * Agora: uma requisição da PRIMEIRA página, fundida no cache por
 * `fundirPrimeiraPagina`, que nunca troca a página 0 — fundir é o que preserva a ponte
 * pra página 1 e a bolha que o evento acabou de inserir. Dez requisições sequenciais
 * viraram uma; e as bolhas novas aparecem antes dela, pelo próprio evento.
 *
 * Um resync que chega com outro em voo é ADIADO, nunca descartado: a resposta em voo é
 * mais velha que o evento que disparou o segundo pedido, e fora do modo degradado não há
 * polling pra tentar de novo depois.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as Crypto from 'expo-crypto';
import { useInfiniteQuery, useQueryClient, type InfiniteData } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api/client';
import { ApiError } from '@/lib/api/errors';
import { useSession } from '@/lib/auth/session';
import { POLL_FALLBACK_MS, useAppStream, type StreamEvent } from '@/lib/stream';
import { publicarXarloteDigitando } from '@/components/xarlote/typing-signal';
import {
  dropConfirmed,
  expirePending,
  mergeMessages,
  type ChatItem,
  type PendingMessage,
} from './merge';
import { fundirPrimeiraPagina, inserirDoEvento, type PaginaChat } from './resync';

const PAGE = 30;
/**
 * Coalescência do resync.
 *
 * O worker insere a resposta da Xarlote em mais de uma linha às vezes (texto + áudio),
 * e cada linha vira um evento. Sem esta janela, uma resposta com duas partes disparava
 * duas buscas idênticas em sequência. 700ms é curto o bastante pra ninguém perceber e
 * longo o bastante pra pegar a rajada.
 */
const JANELA_RESYNC_MS = 700;

type CacheChat = InfiniteData<PaginaChat, string | null>;

export interface UseChatResult {
  items: ChatItem[];
  carregando: boolean;
  /**
   * A leitura FALHOU e não há nada em cache pra desenhar.
   *
   * Existe porque `carregando` (o `isLoading` do React Query v5) é `isPending &&
   * isFetching` — ou seja, ele fica FALSO no instante em que a primeira busca falha. Sem
   * este sinal, a tela caía no estado vazio e dizia "nossa conversa começa aqui" pra
   * quem tem um ano de histórico e está sem rede. Falha não é ausência.
   */
  erroDeLeitura: boolean;
  /** O erro cru — é o que deixa o `LoadFailure` distinguir rede de servidor. */
  falha: unknown;
  /** Tentar de novo depois de uma falha de leitura. */
  recarregar: () => void;
  /** Uma tentativa de recarregar está em curso (o botão gira). */
  recarregando: boolean;
  /** A Xarlote está digitando (ou o turno está em voo). */
  xarloteDigitando: boolean;
  /** SSE desistiu — a tela avisa que está atualizando de tempos em tempos. */
  degradado: boolean;
  temMais: boolean;
  carregarMais: () => void;
  /** `mediaId` vem de `POST /app/media`; texto pode ser vazio quando há mídia. */
  enviar: (texto: string, mediaId?: string) => void;
  /** Reenvia uma pendente que falhou, com clientId NOVO. */
  reenviar: (clientId: string) => void;
  erro: string | null;
  /** O paciente fechou o aviso de erro. */
  limparErro: () => void;
}

export function useChat(): UseChatResult {
  const { user } = useSession();
  const qc = useQueryClient();
  const [pending, setPending] = useState<PendingMessage[]>([]);
  const [erro, setErro] = useState<string | null>(null);
  const [digitando, setDigitando] = useState(false);
  const digitandoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /**
   * `clientId` → `mediaId` do que ESTE aparelho subiu nesta sessão.
   *
   * É o que permite a foto continuar na tela depois de a bolha otimista ser substituída
   * pela linha canônica do servidor — que ainda não devolve `mediaId`. Sem este mapa, a
   * imagem apareceria por três segundos e viraria "Foto enviada".
   */
  const [midias, setMidias] = useState<ReadonlyMap<string, string>>(() => new Map());

  const chave = useMemo(() => ['chat', user?.id ?? 'anon'] as const, [user?.id]);

  const buscarPagina = useCallback(
    (cursor: string | null) =>
      apiFetch<PaginaChat>(
        `/app/messages?limit=${PAGE}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
      ),
    [],
  );

  const q = useInfiniteQuery({
    queryKey: chave,
    enabled: user !== null,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => buscarPagina(pageParam),
    getNextPageParam: (ultima) => ultima.nextCursor,
  });

  // As páginas vêm da mais nova pra mais antiga; o merge reordena, então achatar
  // sem cerimônia é suficiente.
  const servidor = useMemo(
    () => (q.data?.pages ?? []).flatMap((p) => p.messages),
    [q.data],
  );

  // ── Resync: UMA página, fundida ─────────────────────────────────────────────
  const resyncTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const emVoo = useRef(false);
  /**
   * Pedido que chegou com outro em voo: ADIADO, nunca descartado.
   *
   * Descartar parecia inofensivo ("a próxima reconexão tenta de novo") e não era: fora
   * do modo degradado não existe polling nenhum, então o pedido jogado fora era o
   * ÚLTIMO. E o que ele traria é justamente a linha que o evento acabou de anunciar —
   * a busca em voo foi calculada antes dela existir.
   */
  const pedidoPendente = useRef(false);

  const resyncAgora = useCallback(async () => {
    if (emVoo.current) {
      pedidoPendente.current = true;
      return;
    }

    /** Uma ida ao servidor. `return` aqui encerra a PASSADA, não o resync. */
    const umaPassada = async () => {
      try {
        const fresca = await buscarPagina(null);
        const atual = qc.getQueryData<CacheChat>(chave);
        const fusao = fundirPrimeiraPagina(fresca, atual?.pages ?? []);

        if (fusao.tipo === 'inalterado') return;
        if (fusao.tipo === 'recomecar') {
          // Lacuna entre o que voltou e o que estava em cache (ficou fora por mais de uma
          // página, ou o histórico foi apagado). Recomeçar do zero é honesto; costurar
          // duas metades que não se encontram desenharia um buraco silencioso.
          qc.setQueryData<CacheChat>(chave, { pages: [fresca], pageParams: [null] });
          return;
        }
        qc.setQueryData<CacheChat>(chave, {
          pages: fusao.paginas,
          pageParams: (atual?.pageParams ?? [null]).slice(0, fusao.paginas.length),
        });
      } catch {
        // Resync é oportunista: falhar aqui não é erro pro paciente. A próxima
        // reconexão, o próximo evento ou o polling tentam de novo. O que NÃO pode
        // acontecer é uma falha de rede virar mensagem de erro sobre algo que ele
        // nem pediu.
      }
    };

    emVoo.current = true;
    try {
      // Repete enquanto tiver pedido adiado. Zerar a bandeira ANTES da busca é o que
      // faz o evento que chegar durante ela contar: a resposta em voo foi calculada
      // antes daquela linha existir, então uma passada a mais é obrigatória.
      do {
        pedidoPendente.current = false;
        await umaPassada();
      } while (pedidoPendente.current);
    } finally {
      emVoo.current = false;
    }
  }, [buscarPagina, qc, chave]);

  const resync = useCallback(() => {
    if (resyncTimer.current) clearTimeout(resyncTimer.current);
    resyncTimer.current = setTimeout(() => void resyncAgora(), JANELA_RESYNC_MS);
  }, [resyncAgora]);

  const aoReceber = useCallback(
    (ev: StreamEvent) => {
      if (ev.type === 'typing') return; // eco do próprio aparelho; ignora
      if (ev.type !== 'message') return;

      // Chegou resposta da Xarlote → ela parou de digitar.
      if (ev.direction === 'out') setDigitando(false);
      // Confirmou uma pendente → tira da fila local.
      if (ev.clientId) setPending((p) => dropConfirmed(p, [ev.clientId!]));

      /**
       * A bolha entra AGORA, pelo evento, e não depois da requisição.
       *
       * O envelope não é a linha canônica (não traz `sender_role` nem mídia), mas traz
       * id, direção, tipo, texto e instante — o suficiente pra a resposta aparecer sem
       * esperar a rede. O resync canônico vem em seguida e o merge, que deduplica por
       * id, troca uma pela outra sem piscar.
       */
      if (ev.id && ev.direction) {
        const atual = qc.getQueryData<CacheChat>(chave);
        const primeira = atual?.pages[0];
        if (primeira) {
          const nova = inserirDoEvento(primeira, {
            id: ev.id,
            direction: ev.direction,
            ...(ev.contentType !== undefined ? { contentType: ev.contentType } : {}),
            ...(ev.text !== undefined ? { text: ev.text } : {}),
            // O `clientId` ATRAVESSA: é ele que liga a linha do evento ao `mediaId` que
            // este aparelho subiu. Sem ele a foto recém-enviada vira "Foto enviada" no
            // mesmo quadro em que a bolha otimista sai.
            ...(ev.clientId ? { clientId: ev.clientId } : {}),
            at: ev.at,
          });
          if (nova) {
            qc.setQueryData<CacheChat>(chave, {
              ...atual!,
              pages: [nova, ...atual!.pages.slice(1)],
            });
          }
        }
      }

      resync();
    },
    [resync, qc, chave],
  );

  const { degraded } = useAppStream({
    enabled: user !== null,
    onEvent: aoReceber,
    onResync: resync,
  });

  // Polling de reserva: só quando o SSE desistiu. Nunca os dois juntos.
  useEffect(() => {
    if (!degraded || user === null) return;
    const id = setInterval(() => void resyncAgora(), POLL_FALLBACK_MS);
    return () => clearInterval(id);
  }, [degraded, user, resyncAgora]);

  // Vigia de pendentes: o envio é assíncrono e ninguém avisa se o worker cair.
  useEffect(() => {
    if (pending.length === 0) return;
    const id = setInterval(() => setPending((p) => expirePending(p, Date.now())), 5_000);
    return () => clearInterval(id);
  }, [pending.length]);

  /**
   * O orb precisa saber, e ele mora fora desta árvore.
   *
   * Ver `components/xarlote/typing-signal.ts`. A limpeza no desmonte não é zelo: sem
   * ela, um logout no meio de um turno deixaria o orb em modo `thinking` pra sempre.
   */
  useEffect(() => {
    publicarXarloteDigitando(digitando);
  }, [digitando]);

  useEffect(
    () => () => {
      publicarXarloteDigitando(false);
      if (digitandoTimer.current) clearTimeout(digitandoTimer.current);
      if (resyncTimer.current) clearTimeout(resyncTimer.current);
    },
    [],
  );

  const despachar = useCallback(
    async (texto: string, clientId: string, mediaId?: string) => {
      try {
        await apiFetch('/app/messages', {
          method: 'POST',
          body: {
            clientId,
            // Foto de exame costuma vir SEM legenda. O servidor exige texto OU mídia,
            // e omitir a chave vazia é o que faz o schema aceitar.
            ...(texto ? { text: texto } : {}),
            ...(mediaId ? { mediaId } : {}),
            sentAtMs: Date.now(),
          },
        });
        // 202 só diz que entrou na fila. A bolha segue "enviando…" até o eco do SSE
        // (ou o resync) trazer a linha do banco — é o único sinal de que a Xarlote
        // realmente recebeu.
        setDigitando(true);
        if (digitandoTimer.current) clearTimeout(digitandoTimer.current);
        // Rede de segurança: se a resposta não vier, para de mostrar "digitando".
        digitandoTimer.current = setTimeout(() => setDigitando(false), 60_000);
      } catch (err) {
        const f = err instanceof ApiError ? err.failure : null;
        // 428 = falta consentimento. A guarda de rota leva pra tela de termos assim
        // que o /app/me confirmar; aqui só não marcamos falha de rede.
        if (f?.kind === 'consent_required') {
          setErro('Preciso do seu aceite dos termos de saúde pra continuar.');
        } else {
          setErro(f?.message ?? 'Não consegui enviar agora.');
        }
        setPending((p) => p.map((x) => (x.clientId === clientId ? { ...x, status: 'failed' } : x)));
      }
    },
    [],
  );

  const enviar = useCallback(
    (texto: string, mediaId?: string) => {
      const t = texto.trim();
      // Sem texto E sem mídia não é mensagem. Com mídia, texto vazio é legítimo.
      if (!t && !mediaId) return;
      setErro(null);
      // `randomUUID` do expo-crypto, não `Math.random`: este id é a chave de
      // idempotência no banco e na fila — colisão aqui é mensagem de um paciente
      // sobrescrevendo a de outro.
      const clientId = Crypto.randomUUID();
      if (mediaId) {
        setMidias((m) => new Map(m).set(clientId, mediaId));
      }
      setPending((p) => [
        ...p,
        {
          clientId,
          // A bolha de mídia já mostra a foto; texto vazio ali é legítimo e o placeholder
          // "📎 enviando…" só cobriria a imagem com uma frase.
          text: t,
          createdAt: new Date().toISOString(),
          status: 'pending',
          ...(mediaId ? { mediaId } : {}),
        },
      ]);
      void despachar(t, clientId, mediaId);
    },
    [despachar],
  );

  /**
   * `pending` num ref, e não na lista de dependências.
   *
   * `reenviar` desce até o `renderItem` da FlashList. Quando ele dependia de `pending`,
   * ganhava identidade nova a cada envio e a cada confirmação — o `renderItem` mudava, e
   * o `memo` de TODO `Bubble` visível deixava de segurar. O memo estava ali de propósito
   * e não segurava nada.
   */
  const pendingRef = useRef(pending);
  pendingRef.current = pending;

  const reenviar = useCallback(
    (clientId: string) => {
      const alvo = pendingRef.current.find((p) => p.clientId === clientId);
      if (!alvo) return;
      setErro(null);
      // clientId NOVO de propósito: o antigo pode ter chegado ao servidor (só a
      // resposta se perdeu). Reusá-lo seria recusado pela idempotência e a tentativa
      // morreria em silêncio — a bolha ficaria falhada pra sempre.
      const novo = Crypto.randomUUID();
      // A mídia acompanha a nova tentativa: o arquivo JÁ está no bucket, subir de novo
      // seria pagar os megabytes duas vezes por uma falha que foi da mensagem.
      if (alvo.mediaId) {
        setMidias((m) => new Map(m).set(novo, alvo.mediaId!));
      }
      setPending((p) => [
        ...p.filter((x) => x.clientId !== clientId),
        {
          clientId: novo,
          text: alvo.text,
          createdAt: new Date().toISOString(),
          status: 'pending',
          ...(alvo.mediaId ? { mediaId: alvo.mediaId } : {}),
        },
      ]);
      void despachar(alvo.text, novo, alvo.mediaId);
    },
    [despachar],
  );

  const items = useMemo(() => mergeMessages(servidor, pending, midias), [servidor, pending, midias]);
  const limparErro = useCallback(() => setErro(null), []);

  const carregarMais = useCallback(() => {
    if (q.hasNextPage && !q.isFetchingNextPage) void q.fetchNextPage();
  }, [q.hasNextPage, q.isFetchingNextPage, q.fetchNextPage]);

  // `q.refetch` e não `q`: depender do objeto da query daria identidade nova a cada
  // render e o botão de "tentar de novo" remontaria junto (mesma regra do `mutate`).
  const recarregar = useCallback(() => {
    void q.refetch();
  }, [q.refetch]);

  return {
    items,
    carregando: q.isLoading,
    // `!q.data` importa: com algo em cache (do disco, de antes), desenhar a conversa
    // velha é melhor que uma tela de erro — a falha só é a tela quando não há nada.
    erroDeLeitura: q.isError && !q.data,
    falha: q.error,
    recarregar,
    recarregando: q.isRefetching,
    xarloteDigitando: digitando,
    degradado: degraded,
    temMais: q.hasNextPage,
    carregarMais,
    enviar,
    reenviar,
    erro,
    limparErro,
  };
}
