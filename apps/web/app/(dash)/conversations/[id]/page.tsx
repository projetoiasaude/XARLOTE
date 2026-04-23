'use client';
import { useEffect, useState, useRef } from 'react';
import { supabase } from '@/lib/supabase';
import { formatTime, timeAgo } from '@/lib/utils';
import { MapPin } from 'lucide-react';

interface Message {
  id: string;
  direction: 'in' | 'out';
  sender_role: string;
  content_type: string;
  content: string | null;
  location_lat?: number | null;
  location_lng?: number | null;
  llm_model?: string | null;
  llm_latency_ms?: number | null;
  created_at: string;
  trace_id?: string | null;
}

export default function ConversationDetailPage({ params }: { params: { id: string } }) {
  const { id } = params;
  const [messages, setMessages] = useState<Message[]>([]);
  const [conv, setConv] = useState<Record<string, unknown> | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    supabase.from('conversations').select('*').eq('id', id).single().then(({ data }) => setConv(data));
    supabase.from('messages').select('*').eq('conversation_id', id).order('created_at').limit(100)
      .then(({ data }) => setMessages((data as Message[]) ?? []));
  }, [id]);

  useEffect(() => {
    const ch = supabase.channel(`conv-detail-${id}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages', filter: `conversation_id=eq.${id}` },
        (p) => setMessages((prev) => [...prev, p.new as Message])
      ).subscribe();
    return () => { ch.unsubscribe(); };
  }, [id]);

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages]);

  return (
    <div className="flex flex-col h-screen">
      <div className="bg-wa-panel border-b border-wa-border px-4 py-3 shrink-0">
        <p className="text-white font-medium text-sm">Conversa: {id.slice(0, 8)}…</p>
        {conv && <p className="text-xs text-gray-400">{String(conv['whatsapp_jid'] ?? '')} · {String(conv['status'] ?? '')}</p>}
      </div>

      <div className="flex-1 overflow-y-auto scrollbar-thin px-4 py-3 space-y-1 bg-wa-bg">
        {messages.map((msg) => {
          const isOut = msg.direction === 'out';
          if (msg.content_type === 'location') return (
            <div key={msg.id} className={`flex ${isOut ? 'justify-end' : 'justify-start'}`}>
              <div className="bg-wa-bubble_in rounded-xl px-3 py-2">
                <div className="flex items-center gap-2">
                  <MapPin size={14} className="text-green-400" />
                  <span className="text-sm text-white">{msg.location_lat?.toFixed(4)}, {msg.location_lng?.toFixed(4)}</span>
                </div>
                <p className="text-xs text-gray-400 text-right mt-0.5">{formatTime(msg.created_at)}</p>
              </div>
            </div>
          );
          return (
            <div key={msg.id} className={`flex ${isOut ? 'justify-end' : 'justify-start'} group`}>
              <div className={`rounded-2xl px-3 py-2 max-w-[70%] break-words ${isOut ? 'bg-wa-bubble_out' : 'bg-wa-bubble_in'}`}>
                <p className="text-sm text-white whitespace-pre-wrap">{msg.content}</p>
                <div className="flex items-center gap-2 mt-0.5 justify-end">
                  {msg.llm_model && <span className="text-[10px] text-gray-500 hidden group-hover:inline">{msg.llm_model} · {msg.llm_latency_ms}ms</span>}
                  <span className="text-[10px] text-gray-400">{formatTime(msg.created_at)}</span>
                </div>
              </div>
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
