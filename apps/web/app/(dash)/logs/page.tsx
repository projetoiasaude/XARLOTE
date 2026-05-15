'use client';
import { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Activity, ChevronDown } from 'lucide-react';
import {
  GlassPanel, GlassButton, GlassBadge, StatusPing, Tabs, SectionHeader,
  type BadgeTone,
} from '@/components/ui';
import { cn } from '@/lib/utils';

const API = process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001';

interface Log {
  id: number;
  level: string;
  category: string;
  message: string;
  metadata: Record<string, unknown>;
  trace_id: string | null;
  created_at: string;
}

const LEVEL_TONE: Record<string, BadgeTone> = {
  error: 'danger',
  warn: 'warn',
  info: 'info',
  debug: 'neutral',
};

const CATEGORY_COLOR: Record<string, string> = {
  webhook: 'text-fuchsia-300',
  llm: 'text-cyan-300',
  tool: 'text-amber-300',
  outbound: 'text-emerald-300',
  order: 'text-yellow-300',
  places: 'text-rose-300',
  geocoding: 'text-teal-300',
  lgpd: 'text-white/60',
  enrichment: 'text-purple-300',
  transcription: 'text-blue-300',
  vision: 'text-violet-300',
  consent: 'text-emerald-300',
  memory: 'text-pink-300',
  error: 'text-rose-300',
};

function formatTime(iso: string) {
  return new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export default function LogsPage() {
  const [logs, setLogs] = useState<Log[]>([]);
  const [filter, setFilter] = useState<string>('all');
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [autoScroll, setAutoScroll] = useState(true);
  const latestId = useRef(0);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch(`${API}/admin/logs?limit=200`)
      .then((r) => r.json())
      .then((data: Log[]) => {
        setLogs(data);
        if (data[0]) latestId.current = data[0].id;
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    const interval = setInterval(async () => {
      try {
        const res = await fetch(`${API}/admin/logs?limit=50`);
        const data: Log[] = await res.json();
        const newLogs = data.filter((l) => l.id > latestId.current);
        if (newLogs.length > 0) {
          latestId.current = newLogs[0]!.id;
          setLogs((prev) => [...newLogs, ...prev].slice(0, 500));
        }
      } catch { /* ignore */ }
    }, 2000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (autoScroll && bottomRef.current) {
      bottomRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [logs, autoScroll]);

  const visible = filter === 'all' ? logs : logs.filter((l) => l.level === filter);
  const countByLevel = (level: string) => logs.filter((l) => l.level === level).length;

  function toggleExpand(id: number) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const hasMetadata = (log: Log) => log.metadata && Object.keys(log.metadata).length > 0;

  return (
    <div className="flex flex-col h-[calc(100vh-3rem)] space-y-4">
      <SectionHeader
        icon={Activity}
        title="Logs em tempo real"
        subtitle="Auto-refresh a cada 2 segundos"
        size="lg"
        action={
          <div className="flex items-center gap-2">
            <GlassBadge tone="live" dot>live</GlassBadge>
            <Tabs
              id="log-level"
              value={filter}
              onChange={setFilter}
              size="sm"
              options={[
                { value: 'all', label: 'Todos', count: logs.length },
                { value: 'info', label: 'Info', count: countByLevel('info') },
                { value: 'warn', label: 'Warn', count: countByLevel('warn') },
                { value: 'error', label: 'Error', count: countByLevel('error') },
              ]}
            />
            <GlassButton
              variant={autoScroll ? 'primary' : 'secondary'}
              size="sm"
              onClick={() => setAutoScroll((v) => !v)}
            >
              {autoScroll ? '↓ auto' : '↓ manual'}
            </GlassButton>
          </div>
        }
      />

      <GlassPanel className="flex-1 overflow-hidden flex flex-col">
        <div className="flex-1 overflow-y-auto px-1 py-1">
          {visible.length === 0 ? (
            <p className="text-white/40 font-sans text-sm p-6 text-center">
              Nenhum log ainda. Execute o simulador para gerar logs.
            </p>
          ) : (
            <div className="space-y-px font-mono text-xs">
              {visible.map((log) => {
                const isExpanded = expanded.has(log.id);
                return (
                  <div
                    key={log.id}
                    onClick={() => hasMetadata(log) && toggleExpand(log.id)}
                    className={cn(
                      'rounded-lg px-2.5 py-1.5 hover:bg-white/[0.04] transition-colors',
                      hasMetadata(log) && 'cursor-pointer',
                    )}
                  >
                    <div className="flex items-start gap-2">
                      <StatusPing tone={LEVEL_TONE[log.level] === 'danger' ? 'danger' : LEVEL_TONE[log.level] === 'warn' ? 'warn' : LEVEL_TONE[log.level] === 'info' ? 'accent' : 'neutral'} pulse={false} className="mt-1.5" />
                      <span className="text-white/35 shrink-0 w-16 tabular-nums">{formatTime(log.created_at)}</span>
                      <span className={cn('shrink-0 w-20 truncate font-medium', CATEGORY_COLOR[log.category] ?? 'text-white/60')}>
                        {log.category}
                      </span>
                      <span className="text-white/85 flex-1 leading-relaxed break-words whitespace-pre-wrap">
                        {log.message}
                      </span>
                      {hasMetadata(log) && (
                        <ChevronDown
                          size={12}
                          className={cn(
                            'text-white/35 shrink-0 mt-0.5 transition-transform',
                            isExpanded && 'rotate-180',
                          )}
                        />
                      )}
                    </div>
                    <AnimatePresence>
                      {isExpanded && hasMetadata(log) && (
                        <motion.pre
                          initial={{ height: 0, opacity: 0 }}
                          animate={{ height: 'auto', opacity: 1 }}
                          exit={{ height: 0, opacity: 0 }}
                          transition={{ duration: 0.18 }}
                          className="mt-1 ml-[7.25rem] text-[11px] text-white/55 bg-black/30 rounded-lg p-2 overflow-x-auto whitespace-pre-wrap break-all border border-white/5"
                        >
                          {JSON.stringify(log.metadata, null, 2)}
                        </motion.pre>
                      )}
                    </AnimatePresence>
                  </div>
                );
              })}
              <div ref={bottomRef} />
            </div>
          )}
        </div>
      </GlassPanel>
    </div>
  );
}
