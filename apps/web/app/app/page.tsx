'use client';
import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { AnimatePresence, motion } from 'framer-motion';
import { ArrowDown, Phone } from 'lucide-react';
import { dayLabel } from '@/lib/xarlote/format';
import { useXarloteApp } from '@/lib/xarlote/app-context';
import { useXarloteChat } from '@/lib/xarlote/use-chat';
import { XarloteLogo } from '@/components/xarlote/XarloteLogo';
import { LiquidCore } from '@/components/xarlote/LiquidCore';
import { MessageBubble } from '@/components/xarlote/chat/MessageBubble';
import { TypingIndicator } from '@/components/xarlote/chat/TypingIndicator';
import { Composer } from '@/components/xarlote/chat/Composer';
import { Skeleton } from '@/components/ui';
import type { XarMessage } from '@/lib/xarlote/types';

const SUGGESTIONS = ['Oi, Xarlote! 👋', 'Preciso comprar um remédio', 'O que você consegue fazer?'];

function groupByDay(messages: XarMessage[]): Array<{ day: string; items: XarMessage[] }> {
  const groups: Array<{ day: string; items: XarMessage[] }> = [];
  for (const m of messages) {
    const day = dayLabel(m.created_at);
    const last = groups[groups.length - 1];
    if (last && last.day === day) last.items.push(m);
    else groups.push({ day, items: [m] });
  }
  return groups;
}

function ChatScreen() {
  const router = useRouter();
  const params = useSearchParams();
  const [draft, setDraft] = useState<string | undefined>(undefined);
  const { typing, overview } = useXarloteApp();
  const { messages, loading, send, retry } = useXarloteChat();

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const [nearBottom, setNearBottom] = useState(true);
  const [unseen, setUnseen] = useState(false);

  // Consome o ?draft= UMA vez e limpa da URL — senão um reload/restauração do
  // PWA repõe no composer um texto que já foi enviado.
  useEffect(() => {
    const d = params.get('draft');
    if (d) {
      setDraft(d);
      router.replace('/app', { scroll: false });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);

  const groups = useMemo(() => groupByDay(messages), [messages]);
  const firstName = overview?.user.preferred_name?.split(' ')[0];

  // Auto-scroll inteligente: gruda no fim só se você já estava no fim.
  // `unseen` só liga com mensagem NOVA (length) — não com "digitando…".
  const prevCount = useRef(0);
  useEffect(() => {
    const grew = messages.length > prevCount.current;
    prevCount.current = messages.length;
    if (nearBottom) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
      setUnseen(false);
    } else if (grew) {
      setUnseen(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages.length, typing]);

  function onScroll() {
    const el = scrollRef.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 140;
    setNearBottom(near);
    if (near) setUnseen(false);
  }

  return (
    <main className="flex h-dvh flex-col">
      {/* Header de presença */}
      <header className="z-20 px-3 pt-safe">
        <div className="glass glass-spec mt-3 flex items-center gap-3 rounded-3xl px-4 py-2.5">
          <div className="relative">
            <LiquidCore size={40} mode={typing ? 'thinking' : 'idle'} />
            <span className="absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-[#0a0a22] bg-emerald-400" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-[15px] font-semibold leading-tight">Xarlote</p>
            <AnimatePresence mode="wait" initial={false}>
              <motion.p
                key={typing ? 'typing' : 'idle'}
                initial={{ opacity: 0, y: 3 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -3 }}
                className="truncate text-xs text-white/50"
              >
                {typing ? (
                  <span className="text-accent-hi">digitando…</span>
                ) : (
                  'sua agente de saúde · sempre por perto'
                )}
              </motion.p>
            </AnimatePresence>
          </div>
          <a
            href="tel:192"
            aria-label="Emergência — ligar 192 (SAMU)"
            className="flex items-center gap-1.5 rounded-full border border-rose-400/30 bg-rose-500/15 px-2.5 py-1 text-[11px] font-semibold text-rose-200 transition-colors hover:bg-rose-500/25"
          >
            <Phone size={11} /> 192
          </a>
        </div>
      </header>

      {/* Thread */}
      <div ref={scrollRef} onScroll={onScroll} className="flex-1 overflow-y-auto px-4 py-4 no-scrollbar">
        {loading ? (
          <div className="space-y-3 pt-4">
            <Skeleton variant="card" className="h-12 w-2/3" />
            <Skeleton variant="card" className="ml-auto h-12 w-1/2" />
            <Skeleton variant="card" className="h-16 w-3/4" />
          </div>
        ) : messages.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center text-center">
            <XarloteLogo size={170} />
            <p className="mt-4 text-base font-semibold">
              {firstName ? `Oi, ${firstName}!` : 'Oi! Eu sou a Xarlote.'}
            </p>
            <p className="mt-1 max-w-[260px] text-sm text-white/50">
              Pode falar comigo como fala no WhatsApp — é a mesma conversa, nos dois lugares.
            </p>
            <div className="mt-5 flex flex-wrap justify-center gap-2">
              {SUGGESTIONS.map((s, i) => (
                <motion.button
                  key={s}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.15 + i * 0.08, type: 'spring', stiffness: 320, damping: 24 }}
                  whileTap={{ scale: 0.95 }}
                  onClick={() => void send(s)}
                  className="glass rounded-full px-3.5 py-1.5 text-xs text-white/80 transition-colors hover:bg-white/10"
                >
                  {s}
                </motion.button>
              ))}
            </div>
          </div>
        ) : (
          <div className="space-y-2.5">
            {groups.map((g) => (
              <div key={g.day} className="space-y-2.5">
                <div className="sticky top-1 z-10 flex justify-center">
                  <span className="rounded-full bg-[#0b0b28]/70 px-3 py-1 text-[10px] font-medium uppercase tracking-wider text-white/45 backdrop-blur-sm">
                    {g.day}
                  </span>
                </div>
                {g.items.map((m) => (
                  <MessageBubble key={m.id} msg={m} onRetry={retry} />
                ))}
              </div>
            ))}
            <AnimatePresence>{typing && <TypingIndicator />}</AnimatePresence>
            <div ref={bottomRef} className="h-1" />
          </div>
        )}
      </div>

      {/* chip “novas mensagens” */}
      <AnimatePresence>
        {unseen && !nearBottom && (
          <motion.button
            initial={{ opacity: 0, y: 10, scale: 0.9 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 10, scale: 0.9 }}
            onClick={() => bottomRef.current?.scrollIntoView({ behavior: 'smooth' })}
            className="absolute bottom-28 left-1/2 z-30 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-accent/40 bg-accent/85 px-3.5 py-1.5 text-xs font-semibold text-white shadow-glow-accent"
          >
            <ArrowDown size={13} /> novas mensagens
          </motion.button>
        )}
      </AnimatePresence>

      {/* Composer (deixa espaço pro orb à direita) */}
      <div className="relative z-20 pr-[84px] sm:pr-[88px]">
        <Composer onSend={(t) => void send(t)} draft={draft} />
      </div>
    </main>
  );
}

export default function ChatPage() {
  return (
    <Suspense fallback={null}>
      <ChatScreen />
    </Suspense>
  );
}
