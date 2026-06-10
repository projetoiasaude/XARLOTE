'use client';
import { useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { SendHorizonal } from 'lucide-react';
import { cn } from '@/lib/utils';

interface Props {
  onSend: (text: string) => void;
  /** rascunho inicial (deep-link das outras telas: ?draft=) */
  draft?: string;
  disabled?: boolean;
}

export function Composer({ onSend, draft, disabled }: Props) {
  const [text, setText] = useState('');
  const ref = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (draft) {
      setText(draft);
      ref.current?.focus();
    }
  }, [draft]);

  function autoresize() {
    const el = ref.current;
    if (!el) return;
    el.style.height = '0px';
    el.style.height = `${Math.min(el.scrollHeight, 110)}px`;
  }

  function submit() {
    const body = text.trim();
    if (!body || disabled) return;
    navigator.vibrate?.(4);
    onSend(body);
    setText('');
    requestAnimationFrame(() => {
      autoresize();
      ref.current?.focus();
    });
  }

  const hasText = text.trim().length > 0;

  return (
    <div className="px-3 pb-safe">
      <div className="glass glass-spec mb-3 flex items-end gap-2 rounded-[28px] p-2 pl-4">
        <textarea
          ref={ref}
          rows={1}
          value={text}
          disabled={disabled}
          placeholder="Fala com a Xarlote…"
          onChange={(e) => {
            setText(e.target.value);
            autoresize();
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          className={cn(
            'max-h-[110px] min-h-[36px] flex-1 resize-none bg-transparent py-1.5 text-[15px] text-white',
            'placeholder:text-white/35 focus:outline-none disabled:opacity-50',
          )}
        />
        <motion.button
          onClick={submit}
          disabled={!hasText || disabled}
          aria-label="Enviar mensagem"
          initial={false}
          animate={
            hasText
              ? { scale: 1, rotate: 0, backgroundColor: 'rgba(124,135,255,0.9)' }
              : { scale: 0.92, rotate: -8, backgroundColor: 'rgba(255,255,255,0.08)' }
          }
          whileTap={{ scale: 0.82 }}
          transition={{ type: 'spring', stiffness: 420, damping: 22 }}
          className={cn(
            'flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-white/15',
            hasText ? 'text-white shadow-glow-accent' : 'text-white/40',
            'focus:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed',
          )}
        >
          <SendHorizonal size={17} />
        </motion.button>
      </div>
    </div>
  );
}
