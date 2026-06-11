'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { supabase } from '@/lib/supabase';
import { sendAppMessage } from './api';
import { useXarloteApp } from './app-context';
import type { XarMessage } from './types';

const TYPING_TIMEOUT_MS = 75_000;
const PAGE = 200;

/**
 * O coração do espelho: carrega a conversa canônica (a MESMA do WhatsApp),
 * assina INSERTs via Supabase Realtime e envia mensagens pelo pipeline real.
 * Envio é otimista — a bolha nasce `pending` e é confirmada pelo eco do realtime.
 */
export function useXarloteChat() {
  const { phone, overview, setTyping } = useXarloteApp();
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<XarMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const typingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const channelRef = useRef<RealtimeChannel | null>(null);

  const stopTyping = useCallback(() => {
    if (typingTimer.current) clearTimeout(typingTimer.current);
    typingTimer.current = null;
    setTyping(false);
  }, [setTyping]);

  const startTyping = useCallback(() => {
    setTyping(true);
    if (typingTimer.current) clearTimeout(typingTimer.current);
    typingTimer.current = setTimeout(() => setTyping(false), TYPING_TIMEOUT_MS);
  }, [setTyping]);

  // ── Descobre a conversa (overview → fallback: query direta por JID) ─────────
  useEffect(() => {
    if (!phone) return;
    if (overview?.conversationId) {
      setConversationId((cur) => cur ?? overview.conversationId);
      return;
    }
    if (conversationId) return;
    let cancelled = false;
    // Variantes do 9º dígito BR: o WhatsApp às vezes registra sem o 9 — tenta
    // os dois jids (senão usuário real vê "conversa vazia" até o overview chegar).
    const digits = phone.replace('+', '');
    const jids = [`${digits}@s.whatsapp.net`];
    const br = /^55(\d{2})(\d+)$/.exec(digits);
    if (br) {
      const [, ddd, sub] = br;
      if (sub!.length === 9 && sub!.startsWith('9')) jids.push(`55${ddd}${sub!.slice(1)}@s.whatsapp.net`);
      else if (sub!.length === 8) jids.push(`55${ddd}9${sub}@s.whatsapp.net`);
    }
    void supabase
      .from('conversations')
      .select('id')
      .eq('whatsapp_instance', 'sara')
      .in('whatsapp_jid', jids)
      .order('last_message_at', { ascending: false })
      .limit(1)
      .maybeSingle()
      .then(({ data }) => {
        if (!cancelled && data?.id) setConversationId(data.id);
        else if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [phone, overview?.conversationId, conversationId]);

  // ── Carrega histórico + assina realtime ─────────────────────────────────────
  const loadMessages = useCallback(async (convId: string) => {
    const { data } = await supabase
      .from('messages')
      .select('id, conversation_id, direction, sender_role, content_type, content, transcript, location_lat, location_lng, created_at')
      .eq('conversation_id', convId)
      .order('created_at', { ascending: false })
      .limit(PAGE);
    const server = ((data ?? []) as XarMessage[]).reverse();
    const cutoff = Date.now() - 10 * 60_000;
    setMessages((prev) => {
      // Mantém otimistas (pending) E falhadas (failed — senão o botão de retry
      // some num reload). Eco só casa com mensagem RECENTE — texto idêntico no
      // histórico antigo não pode "engolir" a bolha que está sendo enviada.
      const local = prev.filter(
        (m) =>
          (m.pending || m.failed) &&
          !server.some(
            (s) =>
              s.direction === 'in' &&
              s.content === m.content &&
              new Date(s.created_at).getTime() > cutoff,
          ),
      );
      return [...server, ...local];
    });
    // Resposta pode ter chegado por aqui (não pelo realtime — ex: onboarding de
    // usuário novo, websocket caído) — destrava o "digitando…".
    const last = server[server.length - 1];
    if (last?.direction === 'out') stopTyping();
    setLoading(false);
  }, [stopTyping]);

  useEffect(() => {
    if (!conversationId) return;
    void loadMessages(conversationId);

    const ch = supabase
      .channel(`xar-app-conv-${conversationId}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'messages', filter: `conversation_id=eq.${conversationId}` },
        (payload) => {
          const incoming = payload.new as XarMessage;
          setMessages((prev) => {
            if (prev.some((m) => m.id === incoming.id)) return prev;
            if (incoming.direction === 'in') {
              // eco da nossa bolha otimista? substitui no lugar
              const idx = prev.findIndex((m) => m.pending && m.content === incoming.content);
              if (idx >= 0) {
                const next = [...prev];
                next[idx] = incoming;
                return next;
              }
            }
            return [...prev, incoming];
          });
          if (incoming.direction === 'out') stopTyping();
        },
      )
      .subscribe();
    channelRef.current = ch;
    return () => {
      void ch.unsubscribe();
      channelRef.current = null;
    };
  }, [conversationId, loadMessages, stopTyping]);

  // ── Recupera eventos perdidos: celular bloqueado/aba em background derruba o
  //    websocket e o realtime perde INSERTs — ao voltar, recarrega do banco. ──
  useEffect(() => {
    if (!conversationId) return;
    const onVisible = () => {
      if (document.visibilityState === 'visible') void loadMessages(conversationId);
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [conversationId, loadMessages]);

  // ── Envio (otimista, pipeline real) ─────────────────────────────────────────
  const send = useCallback(
    async (text: string) => {
      if (!phone || !text.trim()) return;
      const body = text.trim();
      const tempId = `tmp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      setMessages((prev) => [
        ...prev,
        {
          id: tempId,
          direction: 'in',
          sender_role: 'user',
          content_type: 'text',
          content: body,
          created_at: new Date().toISOString(),
          pending: true,
        },
      ]);
      startTyping();
      try {
        const res = await sendAppMessage(phone, body);
        if (res.conversationId && !conversationId) {
          // primeira mensagem de um usuário novo — agora existe conversa
          setConversationId(res.conversationId);
        } else if (res.conversationId) {
          // garante consistência caso o realtime tenha perdido algo no caminho
          void loadMessages(res.conversationId);
        }
      } catch {
        // O POST pode falhar DEPOIS da mensagem já ter sido persistida (timeout
        // na resposta da LLM, rede). Recarrega antes de marcar como falha — se
        // ela está no servidor, o eco substitui a bolha e o retry (que geraria
        // DUPLICATA na conversa real do WhatsApp) nem aparece.
        if (conversationId) await loadMessages(conversationId).catch(() => {});
        stopTyping();
        setMessages((prev) =>
          prev.map((m) => (m.id === tempId && m.pending ? { ...m, pending: false, failed: true } : m)),
        );
      }
    },
    [phone, conversationId, startTyping, stopTyping, loadMessages],
  );

  const retry = useCallback(
    (failedId: string) => {
      const msg = messages.find((m) => m.id === failedId);
      if (!msg?.content) return;
      setMessages((prev) => prev.filter((m) => m.id !== failedId));
      void send(msg.content);
    },
    [messages, send],
  );

  useEffect(() => () => stopTyping(), [stopTyping]);

  return { messages, loading, conversationId, send, retry };
}
