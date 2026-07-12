'use client';
import { useEffect, useState, useRef } from 'react';
import Link from 'next/link';
import { motion } from 'framer-motion';
import { ArrowLeft, MapPin, Image as ImageIcon, Mic, FileText } from 'lucide-react';
import { formatTime, adminGet } from '@/lib/utils';
import { GlassPanel, GlassBadge, Avatar } from '@/components/ui';

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

interface Conv {
  id: string;
  whatsapp_jid: string;
  status: string;
  users?: { preferred_name?: string; full_name?: string; phone_e164?: string } | null;
}

export default function ConversationDetailPage({ params }: { params: { id: string } }) {
  const { id } = params;
  const [messages, setMessages] = useState<Message[]>([]);
  const [conv, setConv] = useState<Conv | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Auto-scroll SÓ quando o usuário já está no fim (como um app de chat). Se ele
  // rolou pra cima pra ler o histórico, o polling de 5s NÃO pode arrancá-lo de volta.
  const pinnedToBottom = useRef(true);
  // Chave da última msg (count + id) pra só rolar quando há msg NOVA — o polling cria
  // um array novo a cada 5s mesmo sem mudança, e isso disparava o scroll à toa.
  const lastMsgKey = useRef('');

  // Leitura via API (service role + token do login). Antes era Supabase anon
  // direto, que o RLS (is_staff) bloqueia. "Tempo real" via polling leve.
  async function load() {
    try {
      const data = await adminGet<{ conversation: Conv | null; messages: Message[] }>(`/admin/conversations/${id}`);
      setConv(data.conversation ?? null);
      setMessages(data.messages ?? []);
    } catch {
      /* falha transitória — mantém o estado anterior */
    }
  }

  useEffect(() => {
    // Troca de conversa: reseta o estado de scroll pra a nova abrir no fim.
    lastMsgKey.current = '';
    pinnedToBottom.current = true;
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // Atualiza "está no fim?" a cada rolagem do usuário. Tolerância de 100px pra contar
  // como "no fim" mesmo com um resquício de folga.
  function handleScroll() {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    pinnedToBottom.current = distanceFromBottom < 100;
  }

  useEffect(() => {
    const key = messages.length ? `${messages.length}:${messages[messages.length - 1]!.id}` : '';
    if (key === lastMsgKey.current) return; // nada novo → não rola (evita o yank do polling)
    const isInitial = lastMsgKey.current === '';
    lastMsgKey.current = key;
    // Abertura da conversa: salta pro fim (instantâneo). Msg nova: só rola se o usuário
    // estava no fim — se ele subiu pra ler, fica onde está.
    if (isInitial) {
      bottomRef.current?.scrollIntoView();
    } else if (pinnedToBottom.current) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages]);

  const displayName =
    conv?.users?.preferred_name ?? conv?.users?.full_name ?? conv?.users?.phone_e164 ?? conv?.whatsapp_jid.split('@')[0] ?? '…';

  return (
    <div className="flex flex-col h-[calc(100vh-3rem)]">
      {/* Header */}
      <GlassPanel className="flex items-center gap-3 px-4 py-3 shrink-0">
        <Link
          href="/conversations"
          className="flex h-8 w-8 items-center justify-center rounded-xl hover:bg-white/8 text-white/60 hover:text-white transition-colors"
          aria-label="Voltar"
        >
          <ArrowLeft size={16} />
        </Link>
        <Avatar name={displayName} size="md" />
        <div className="min-w-0 flex-1">
          <p className="text-white text-sm font-semibold truncate">{displayName}</p>
          <p className="text-white/40 text-[11px] font-mono">{conv?.whatsapp_jid ?? id.slice(0, 8) + '…'}</p>
        </div>
        {conv && (
          <GlassBadge tone={conv.status === 'active' ? 'live' : 'neutral'} dot>
            {conv.status}
          </GlassBadge>
        )}
      </GlassPanel>

      {/* Thread */}
      <div ref={scrollRef} onScroll={handleScroll} className="flex-1 overflow-y-auto px-4 py-4 space-y-2 mt-4">
        {messages.map((msg, idx) => {
          const isOut = msg.direction === 'out';
          const showAvatar = idx === 0 || messages[idx - 1]!.direction !== msg.direction;
          return (
            <motion.div
              key={msg.id}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
              className={`flex items-end gap-2 ${isOut ? 'justify-end' : 'justify-start'} group`}
            >
              {!isOut && (
                <div className={`shrink-0 ${showAvatar ? 'opacity-100' : 'opacity-0'}`}>
                  <Avatar name={displayName} size="sm" />
                </div>
              )}
              <MessageBubble msg={msg} isOut={isOut} />
            </motion.div>
          );
        })}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}

function MessageBubble({ msg, isOut }: { msg: Message; isOut: boolean }) {
  const bubbleClasses = isOut
    ? 'bg-accent/20 border border-accent/30 text-white'
    : 'bg-white/8 border border-white/12 text-white';

  if (msg.content_type === 'location') {
    return (
      <div className={`relative max-w-[70%] rounded-2xl px-3.5 py-2.5 backdrop-blur-glass ${bubbleClasses}`}>
        <div className="flex items-center gap-2">
          <MapPin size={14} className="text-emerald-300" />
          <span className="text-sm font-mono">
            {msg.location_lat?.toFixed(4)}, {msg.location_lng?.toFixed(4)}
          </span>
        </div>
        <p className="text-[10px] text-white/40 text-right mt-1">{formatTime(msg.created_at)}</p>
      </div>
    );
  }

  if (msg.content_type === 'image' || msg.content_type === 'audio' || msg.content_type === 'document') {
    const Icon = msg.content_type === 'image' ? ImageIcon : msg.content_type === 'audio' ? Mic : FileText;
    const label = msg.content_type === 'image' ? 'Imagem' : msg.content_type === 'audio' ? 'Áudio' : 'Documento';
    return (
      <div className={`relative max-w-[70%] rounded-2xl px-3.5 py-2.5 backdrop-blur-glass ${bubbleClasses}`}>
        <div className="flex items-center gap-2">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-white/10">
            <Icon size={14} className="text-white/80" />
          </div>
          <div>
            <p className="text-xs font-medium text-white/85">{label}</p>
            {msg.content && <p className="text-xs text-white/55 italic mt-0.5">"{msg.content.slice(0, 80)}"</p>}
          </div>
        </div>
        <p className="text-[10px] text-white/40 text-right mt-1">{formatTime(msg.created_at)}</p>
      </div>
    );
  }

  return (
    <div className={`relative max-w-[70%] rounded-2xl px-3.5 py-2 backdrop-blur-glass ${bubbleClasses}`}>
      <p className="text-sm whitespace-pre-wrap leading-relaxed">{msg.content}</p>
      <div className="flex items-center gap-2 mt-1 justify-end">
        {msg.llm_model && (
          <span className="text-[10px] text-white/35 hidden group-hover:inline font-mono">
            {msg.llm_model.split('/').at(-1)} · {msg.llm_latency_ms}ms
          </span>
        )}
        <span className="text-[10px] text-white/45">{formatTime(msg.created_at)}</span>
      </div>
    </div>
  );
}
