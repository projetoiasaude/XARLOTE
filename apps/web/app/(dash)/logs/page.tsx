'use client';
import { useEffect, useRef, useState } from 'react';

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

const LEVEL_COLORS: Record<string, string> = {
  error: 'text-red-400 bg-red-950/30',
  warn:  'text-yellow-400 bg-yellow-950/20',
  info:  'text-blue-400',
  debug: 'text-gray-500',
};

const LEVEL_BADGE: Record<string, string> = {
  error: 'bg-red-500/20 text-red-400 border border-red-500/30',
  warn:  'bg-yellow-500/20 text-yellow-400 border border-yellow-500/30',
  info:  'bg-blue-500/20 text-blue-400 border border-blue-500/30',
  debug: 'bg-gray-500/20 text-gray-400 border border-gray-500/30',
};

const CATEGORY_COLORS: Record<string, string> = {
  webhook:  'text-purple-400',
  llm:      'text-cyan-400',
  tool:     'text-orange-400',
  outbound: 'text-green-400',
  order:    'text-yellow-400',
  places:   'text-pink-400',
  geocoding:'text-teal-400',
  lgpd:     'text-gray-400',
  error:    'text-red-400',
};

function formatTime(iso: string) {
  const d = new Date(iso);
  return d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export default function LogsPage() {
  const [logs, setLogs] = useState<Log[]>([]);
  const [filter, setFilter] = useState<string>('all');
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [autoScroll, setAutoScroll] = useState(true);
  const latestId = useRef(0);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Initial load
  useEffect(() => {
    fetch(`${API}/admin/logs?limit=200`)
      .then((r) => r.json())
      .then((data: Log[]) => {
        setLogs(data);
        if (data[0]) latestId.current = data[0].id;
      })
      .catch(() => {});
  }, []);

  // Polling every 2s for new logs
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

  // Auto-scroll to bottom when new logs arrive
  useEffect(() => {
    if (autoScroll && bottomRef.current) {
      bottomRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [logs, autoScroll]);

  const visible = filter === 'all' ? logs : logs.filter((l) => l.level === filter);

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
    <div className="flex flex-col h-full p-4">
      {/* Header */}
      <div className="flex items-center gap-3 mb-3 shrink-0">
        <h1 className="text-lg font-semibold text-white">Logs em tempo real</h1>
        <span className="flex items-center gap-1 text-xs text-green-400">
          <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse inline-block" />
          live
        </span>
        <div className="flex gap-1 ml-auto items-center">
          <button
            onClick={() => setAutoScroll((v) => !v)}
            className={`px-2 py-1 rounded text-xs mr-2 ${autoScroll ? 'bg-green-500/20 text-green-400' : 'text-gray-500 hover:text-white'}`}
          >
            {autoScroll ? '↓ auto' : '↓ manual'}
          </button>
          {(['all', 'info', 'warn', 'error'] as const).map((l) => (
            <button
              key={l}
              onClick={() => setFilter(l)}
              className={`px-3 py-1 rounded text-xs font-sans ${filter === l ? 'bg-wa-bubble_in text-white' : 'text-gray-500 hover:text-white'}`}
            >
              {l}
            </button>
          ))}
        </div>
      </div>

      {/* Log list — newest on top */}
      <div className="flex-1 overflow-y-auto space-y-0.5 font-mono text-xs">
        {visible.length === 0 && (
          <p className="text-gray-500 font-sans text-sm p-2">
            Nenhum log ainda. Execute o simulador para gerar logs.
          </p>
        )}
        {visible.map((log) => (
          <div
            key={log.id}
            className={`rounded px-2 py-1 cursor-pointer ${LEVEL_COLORS[log.level] ?? ''} hover:brightness-125 transition-all`}
            onClick={() => hasMetadata(log) && toggleExpand(log.id)}
          >
            <div className="flex items-start gap-2">
              <span className="text-gray-600 shrink-0 w-20">{formatTime(log.created_at)}</span>
              <span className={`shrink-0 px-1.5 py-0.5 rounded text-[10px] font-bold uppercase ${LEVEL_BADGE[log.level] ?? ''}`}>
                {log.level}
              </span>
              <span className={`shrink-0 w-20 truncate font-medium ${CATEGORY_COLORS[log.category] ?? 'text-gray-400'}`}>
                {log.category}
              </span>
              <span className="text-gray-200 flex-1 leading-relaxed break-words whitespace-pre-wrap">
                {log.message}
              </span>
              {hasMetadata(log) && (
                <span className="text-gray-600 shrink-0 text-[10px] select-none">
                  {expanded.has(log.id) ? '▲' : '▼'}
                </span>
              )}
            </div>
            {expanded.has(log.id) && hasMetadata(log) && (
              <pre className="mt-1 ml-[10.5rem] text-[11px] text-gray-400 bg-black/30 rounded p-2 overflow-x-auto whitespace-pre-wrap break-all">
                {JSON.stringify(log.metadata, null, 2)}
              </pre>
            )}
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
