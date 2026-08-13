/**
 * O chat inteiro atrás de um hook.
 *
 * Junta três fontes que discordam entre si e precisam virar UMA lista:
 *   · as páginas do servidor (React Query, keyset, cache em disco),
 *   · os envios locais ainda não confirmados,
 *   · os eventos do SSE.
 *
 * A conciliação vive em `./merge.ts`, que é puro e testado. Aqui fica só o que
 * inevitavelmente tem estado: a fila de pendentes, o resync e o polling de reserva.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as Crypto from 'expo-crypto';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api/client';
import { ApiError } from '@/lib/api/errors';
import { useSession } from '@/lib/auth/session';
import { POLL_FALLBACK_MS, useAppStream, type StreamEvent } from '@/lib/stream';
import {
  dropConfirmed,
  expirePending,
  mergeMessages,
  type ChatItem,
  type PendingMessage,
  type ServerMessage,
} from './merge';

interface Pagina {
  conversationId: string | null;
  messages: ServerMessage[];
  nextCursor: string | null;
}

const PAGE = 30;

export interface UseChatResult {
  items: ChatItem[];
  carregando: boolean;
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
}

export function useChat(): UseChatResult {
  const { user } = useSession();
  const qc = useQueryClient();
  const [pending, setPending] = useState<PendingMessage[]>([]);
  const [erro, setErro] = useState<string | null>(null);
  const [digitando, setDigitando] = useState(false);
  const digitandoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const chave = useMemo(() => ['chat', user?.id ?? 'anon'] as const, [user?.id]);

  const q = useInfiniteQuery({
    queryKey: chave,
    enabled: user !== null,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      apiFetch<Pagina>(
        `/app/messages?limit=${PAGE}${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ''}`,
      ),
    getNextPageParam: (ultima) => ultima.nextCursor,
  });

  // As páginas vêm da mais nova pra mais antiga; o merge reordena, então achatar
  // sem cerimônia é suficiente.
  const servidor = useMemo(
    () => (q.data?.pages ?? []).flatMap((p) => p.messages),
    [q.data],
  );

  const resync = useCallback(() => {
    // Invalida só a PRIMEIRA página: o histórico antigo não muda, e refazer todas as
    // páginas a cada reconexão puxaria a conversa inteira num túnel de metrô.
    void qc.invalidateQueries({ queryKey: chave, refetchType: 'active' });
  }, [qc, chave]);

  const aoReceber = useCallback(
    (ev: StreamEvent) => {
      if (ev.type === 'typing') return; // eco do próprio aparelho; ignora
      if (ev.type === 'message') {
        // Chegou resposta da Xarlote → ela parou de digitar.
        if (ev.direction === 'out') setDigitando(false);
        // Confirmou uma pendente → tira da fila local.
        if (ev.clientId) setPending((p) => dropConfirmed(p, [ev.clientId!]));
        // O evento traz o essencial, mas o refetch é que trás a linha canônica (com
        // media, sender_role etc). Como o merge deduplica por id, não há duplicata.
        resync();
      }
    },
    [resync],
  );

  const { degraded } = useAppStream({
    enabled: user !== null,
    onEvent: aoReceber,
    onResync: resync,
  });

  // Polling de reserva: só quando o SSE desistiu. Nunca os dois juntos.
  useEffect(() => {
    if (!degraded || user === null) return;
    const id = setInterval(resync, POLL_FALLBACK_MS);
    return () => clearInterval(id);
  }, [degraded, user, resync]);

  // Vigia de pendentes: o envio é assíncrono e ninguém avisa se o worker cair.
  useEffect(() => {
    if (pending.length === 0) return;
    const id = setInterval(() => setPending((p) => expirePending(p, Date.now())), 5_000);
    return () => clearInterval(id);
  }, [pending.length]);

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
      setPending((p) => [
        ...p,
        {
          clientId,
          // A bolha otimista de uma mídia sem legenda precisa dizer ALGUMA coisa,
          // senão aparece um balão vazio enquanto o servidor processa.
          text: t || (mediaId ? '📎 enviando…' : ''),
          createdAt: new Date().toISOString(),
          status: 'pending',
        },
      ]);
      void despachar(t, clientId, mediaId);
    },
    [despachar],
  );

  const reenviar = useCallback(
    (clientId: string) => {
      const alvo = pending.find((p) => p.clientId === clientId);
      if (!alvo) return;
      setErro(null);
      // clientId NOVO de propósito: o antigo pode ter chegado ao servidor (só a
      // resposta se perdeu). Reusá-lo seria recusado pela idempotência e a tentativa
      // morreria em silêncio — a bolha ficaria falhada pra sempre.
      const novo = Crypto.randomUUID();
      setPending((p) => [
        ...p.filter((x) => x.clientId !== clientId),
        { clientId: novo, text: alvo.text, createdAt: new Date().toISOString(), status: 'pending' },
      ]);
      void despachar(alvo.text, novo);
    },
    [pending, despachar],
  );

  const items = useMemo(() => mergeMessages(servidor, pending), [servidor, pending]);

  return {
    items,
    carregando: q.isLoading,
    xarloteDigitando: digitando,
    degradado: degraded,
    temMais: q.hasNextPage,
    carregarMais: () => {
      if (q.hasNextPage && !q.isFetchingNextPage) void q.fetchNextPage();
    },
    enviar,
    reenviar,
    erro,
  };
}
