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
    const jid = `${phone.replace('+', '')}@s.whatsapp.net`;
    void supabase
      .from('conversations')
      .select('id')
      .eq('whatsapp_instance', 'sara')
      .eq('whatsapp_jid', jid)
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
    setMessages((prev) => {
      const stillPending = prev.filter(
        (m) => m.pending && !server.some((s) => s.direction === 'in' && s.content === m.content),
      );
      return [...server, ...stillPending];
    });
    setLoading(false);
  }, []);

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
        stopTyping();
        setMessages((prev) =>
          prev.map((m) => (m.id === tempId ? { ...m, pending: false, failed: true } : m)),
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
