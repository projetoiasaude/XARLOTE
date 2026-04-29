'use client';
import { useEffect, useRef, useState } from 'react';
import { X, Send } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { apiUrl } from '@/lib/utils';
import type { RealtimeChannel } from '@supabase/supabase-js';

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
 * O usuário escreve "como se fosse a farmácia" — o backend processa via
 * `processInboundSupplier` e a Xarlote-agente responde automaticamente.
 */
export function PharmacyChatDrawer({ open, conversationId, pharmacyName, onClose }: Props) {
  const [msgs, setMsgs] = useState<ChatMsg[]>([]);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Carrega histórico
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

  // Realtime: novas mensagens chegando
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
        }
      )
      .subscribe();
    return () => { ch.unsubscribe(); };
  }, [open, conversationId]);

  // Auto-scroll
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

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex">
      {/* Backdrop */}
      <div className="flex-1 bg-black/60 backdrop-blur-sm" onClick={onClose} />

      {/* Drawer */}
      <div className="w-full max-w-md bg-wa-bg border-l border-wa-border flex flex-col shadow-2xl">
        {/* Header */}
        <div className="px-4 py-3 border-b border-wa-border flex items-center justify-between bg-wa-panel">
          <div className="min-w-0">
            <p className="text-white text-sm font-semibold truncate">{pharmacyName}</p>
            <p className="text-xs text-gray-500">Simulação manual — você responde como a farmácia</p>
          </div>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-white p-1 rounded-md hover:bg-wa-bubble_in transition-colors"
            aria-label="Fechar chat"
          >
            <X size={20} />
          </button>
        </div>

        {/* Messages */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto p-3 space-y-2 bg-[#0b141a]">
          {msgs.length === 0 && (
            <p className="text-gray-500 text-sm text-center mt-8">
              Aguardando a Xarlote iniciar a conversa…
            </p>
          )}
          {msgs.map((m) => {
            // 'out' = Xarlote-agente para a farmácia (esquerda)
            // 'in' = farmácia respondendo (direita, pq nesta tela "você é a farmácia")
            const fromPharmacy = m.direction === 'in';
            return (
              <div
                key={m.id}
                className={`flex ${fromPharmacy ? 'justify-end' : 'justify-start'}`}
              >
                <div
                  className={`max-w-[85%] px-3 py-2 rounded-lg text-sm whitespace-pre-wrap break-words ${
                    fromPharmacy
                      ? 'bg-wa-bubble_out text-white rounded-br-sm'
                      : 'bg-wa-bubble_in text-white rounded-bl-sm'
                  }`}
                >
                  {!fromPharmacy && (
                    <p className="text-[10px] text-brand-400 font-semibold mb-0.5">Xarlote (agente)</p>
                  )}
                  <p>{m.content}</p>
                </div>
              </div>
            );
          })}
        </div>

        {/* Composer */}
        <div className="p-3 border-t border-wa-border bg-wa-panel">
          <div className="flex gap-2">
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
              className="flex-1 bg-wa-bubble_in text-white text-sm rounded-lg px-3 py-2 resize-none focus:outline-none focus:ring-1 focus:ring-brand-500"
              disabled={sending || !conversationId}
            />
            <button
              onClick={handleSend}
              disabled={!text.trim() || sending || !conversationId}
              className="bg-brand-500 hover:bg-brand-600 disabled:opacity-40 disabled:cursor-not-allowed text-white p-2.5 rounded-full transition-colors self-end"
              aria-label="Enviar"
            >
              <Send size={18} />
            </button>
          </div>
          <p className="text-[10px] text-gray-500 mt-2">
            Enter envia · Shift+Enter pula linha
          </p>
        </div>
      </div>
    </div>
  );
}
