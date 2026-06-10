'use client';
import { motion, useReducedMotion } from 'framer-motion';
import { AlertCircle, Clock3, FileText, ImageIcon, MapPin, Mic } from 'lucide-react';
import { cn, formatTime } from '@/lib/utils';
import type { XarMessage } from '@/lib/xarlote/types';

interface Props {
  msg: XarMessage;
  onRetry?: (id: string) => void;
}

function Body({ msg }: { msg: XarMessage }) {
  const text = msg.content ?? '';
  switch (msg.content_type) {
    case 'audio':
      return (
        <span className="flex items-start gap-2">
          <Mic size={14} className="mt-0.5 shrink-0 opacity-70" />
          <span className="whitespace-pre-wrap break-words">
            {msg.transcript ? msg.transcript : 'Mensagem de voz'}
          </span>
        </span>
      );
    case 'image':
      return (
        <span className="flex items-start gap-2">
          <ImageIcon size={14} className="mt-0.5 shrink-0 opacity-70" />
          <span className="whitespace-pre-wrap break-words">{msg.transcript || text || 'Foto'}</span>
        </span>
      );
    case 'document':
      return (
        <span className="flex items-start gap-2">
          <FileText size={14} className="mt-0.5 shrink-0 opacity-70" />
          <span className="break-words">{text || 'Documento'}</span>
        </span>
      );
    case 'location':
      return (
        <span className="flex items-start gap-2">
          <MapPin size={14} className="mt-0.5 shrink-0 opacity-70" />
          <span>
            Localização compartilhada
            {msg.location_lat != null && msg.location_lng != null && (
              <span className="block text-[11px] opacity-60">
                {msg.location_lat.toFixed(4)}, {msg.location_lng.toFixed(4)}
              </span>
            )}
          </span>
        </span>
      );
    default:
      return <span className="whitespace-pre-wrap break-words">{text}</span>;
  }
}

/** Bolha de vidro. `in` = você (direita, tint accent) · `out` = Xarlote (esquerda). */
export function MessageBubble({ msg, onRetry }: Props) {
  const reduced = useReducedMotion();
  const mine = msg.direction === 'in';

  return (
    <motion.div
      initial={reduced ? { opacity: 0 } : { opacity: 0, y: 10, scale: 0.96 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ type: 'spring', stiffness: 360, damping: 28 }}
      className={cn('flex w-full', mine ? 'justify-end' : 'justify-start')}
    >
      <div
        onClick={msg.failed && onRetry ? () => onRetry(msg.id) : undefined}
        className={cn(
          'relative max-w-[80%] rounded-3xl border px-4 py-2.5 text-[15px] leading-snug shadow-glass',
          mine
            ? 'rounded-br-lg border-accent/35 bg-accent/25 text-white backdrop-blur-glass'
            : 'glass glass-spec rounded-bl-lg text-white/95',
          msg.pending && 'opacity-70',
          msg.failed && 'cursor-pointer border-rose-400/60 bg-rose-500/15',
        )}
      >
        <Body msg={msg} />
        <span className={cn('mt-1 flex items-center justify-end gap-1 text-[10px]', mine ? 'text-white/55' : 'text-white/40')}>
          {msg.failed ? (
            <span className="flex items-center gap-1 font-medium text-rose-300">
              <AlertCircle size={11} /> não enviou — toque pra tentar de novo
            </span>
          ) : (
            <>
              {formatTime(msg.created_at)}
              {msg.pending && <Clock3 size={10} className="opacity-70" />}
            </>
          )}
        </span>
      </div>
    </motion.div>
  );
}
