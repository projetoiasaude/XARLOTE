'use client';
import { useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { X, Send } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { apiUrl } from '@/lib/utils';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { Drawer, GlassBadge, GlassButton, Avatar } from '@/components/ui';

interface ChatMsg {
  id: string;
  direction: 'in' | 'out';
  sender_role: string;
  content: string | null;
  created_at: string;
}

interface Props {
  open: boolean;
  conversationId: string | null;
  pharmacyName: string;
  onClose: () => void;
}

/**
 * Drawer lateral pra simular o lado da farmácia em modo de teste.
 * Mensagens 'out' (Xarlote-agente → farmácia) ficam à esquerda.
 * Mensagens 'in' (farmácia → Xarlote-agente) ficam à direita.
 */
export function PharmacyChatDrawer({ open, conversationId, pharmacyName, onClose }: Props) {
  const [msgs, setMsgs] = useState<ChatMsg[]>([]);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open || !conversationId) return;
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from('messages')
        .select('id, direction, sender_role, content, created_at')
        .eq('conversation_id', conversationId)
        .order('created_at', { ascending: true });
      if (!cancelled) setMsgs((data as ChatMsg[]) ?? []);
    })();
    return () => { cancelled = true; };
  }, [open, conversationId]);

  useEffect(() => {
    if (!open || !conversationId) return;
    const ch: RealtimeChannel = supabase
      .channel(`pharmacy-chat-${conversationId}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'messages', filter: `conversation_id=eq.${conversationId}` },
        (payload) => {
          const m = payload.new as ChatMsg;
          setMsgs((prev) => (prev.find((x) => x.id === m.id) ? prev : [...prev, m]));
        },
      )
      .subscribe();
    return () => { ch.unsubscribe(); };
  }, [open, conversationId]);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [msgs]);

  async function handleSend() {
    if (!text.trim() || !conversationId || sending) return;
    setSending(true);
    try {
      const res = await fetch(apiUrl('/api/simulate/pharmacy-reply'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversationId, text: text.trim() }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setText('');
    } catch (err) {
      console.error('[PharmacyChatDrawer] send failed', err);
      alert('Falha ao enviar mensagem. Veja o console.');
    } finally {
      setSending(false);
    }
  }

  return (
    <Drawer open={open} onClose={onClose} side="right" width="w-full max-w-md">
      {/* Header */}
      <div className="px-4 py-4 border-b border-white/8 flex items-center gap-3 shrink-0">
        <Avatar name={pharmacyName} size="md" />
        <div className="min-w-0 flex-1">
          <p className="text-white text-sm font-semibold truncate">{pharmacyName}</p>
          <p className="text-xs text-white/45">Simulação manual · você responde como a farmácia</p>
        </div>
        <button
          onClick={onClose}
          className="flex h-8 w-8 items-center justify-center rounded-xl text-white/55 hover:text-white hover:bg-white/8 transition-colors"
          aria-label="Fechar"
        >
          <X size={16} />
        </button>
      </div>

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-2">
        {msgs.length === 0 && (
          <p className="text-white/40 text-sm text-center mt-8">
            Aguardando a Xarlote iniciar a conversa…
          </p>
        )}
        {msgs.map((m) => {
          const fromPharmacy = m.direction === 'in';
          return (
            <motion.div
              key={m.id}
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.2 }}
              className={`flex ${fromPharmacy ? 'justify-end' : 'justify-start'}`}
            >
              <div
                className={`relative max-w-[85%] px-3.5 py-2 rounded-2xl text-sm whitespace-pre-wrap break-words backdrop-blur-glass ${
                  fromPharmacy
                    ? 'bg-accent/20 border border-accent/30 text-white'
                    : 'bg-white/8 border border-white/12 text-white'
                }`}
              >
                {!fromPharmacy && (
                  <div className="mb-1">
                    <GlassBadge tone="accent" size="xs">Xarlote (agente)</GlassBadge>
                  </div>
                )}
                <p className="leading-relaxed">{m.content}</p>
              </div>
            </motion.div>
          );
        })}
      </div>

      {/* Composer */}
      <div className="p-3 border-t border-white/8 shrink-0">
        <div className="flex gap-2 items-end">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleSend();
              }
            }}
            placeholder="Resposta da farmácia (ex.: 'Temos sim! Dipirona 500mg, 20cp R$ 8,90 + frete R$ 5')"
            rows={2}
            className="flex-1 bg-white/[0.05] border border-white/10 rounded-xl px-3 py-2 text-sm text-white placeholder:text-white/30 resize-none focus:outline-none focus:bg-white/[0.07] focus:border-accent/60 focus:ring-2 focus:ring-accent/20 transition-colors"
            disabled={sending || !conversationId}
          />
          <GlassButton
            variant="primary"
            size="md"
            iconOnly
            onClick={handleSend}
            disabled={!text.trim() || sending || !conversationId}
            aria-label="Enviar"
          >
            <Send size={16} />
          </GlassButton>
        </div>
        <p className="text-[10px] text-white/35 mt-2">Enter envia · Shift+Enter pula linha</p>
      </div>
    </Drawer>
  );
}
