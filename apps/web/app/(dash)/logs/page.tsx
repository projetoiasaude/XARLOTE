'use client';
import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { formatTime } from '@/lib/utils';

interface Log { id: number; level: string; category: string; message: string; metadata: Record<string, unknown>; trace_id: string | null; created_at: string; }

const LEVEL_COLORS: Record<string, string> = {
  error: 'text-red-400',
  warn:  'text-yellow-400',
  info:  'text-blue-400',
  debug: 'text-gray-500',
};

export default function LogsPage() {
  const [logs, setLogs] = useState<Log[]>([]);
  const [filter, setFilter] = useState<string>('all');

  useEffect(() => {
    supabase.from('system_logs').select('*').order('created_at', { ascending: false }).limit(200)
      .then(({ data }) => setLogs((data as Log[]) ?? []));
  }, []);

  useEffect(() => {
    const ch = supabase.channel('logs-live')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'system_logs' },
        (p) => setLogs((prev) => [p.new as Log, ...prev].slice(0, 300))
      ).subscribe();
    return () => { ch.unsubscribe(); };
  }, []);

  const visible = filter === 'all' ? logs : logs.filter((l) => l.level === filter);

  return (
    <div className="p-6 font-mono">
      <div className="flex items-center gap-3 mb-4">
        <h1 className="text-xl font-bold text-white font-sans">Logs em tempo real</h1>
        <div className="flex gap-1 ml-auto">
          {['all','info','warn','error'].map((l) => (
            <button key={l} onClick={() => setFilter(l)}
              className={`px-3 py-1 rounded text-xs font-sans ${filter === l ? 'bg-wa-bubble_in text-white' : 'text-gray-500 hover:text-white'}`}>
              {l}
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-0.5">
        {visible.map((log) => (
          <div key={log.id} className="flex items-start gap-2 text-xs hover:bg-wa-panel/50 px-2 py-0.5 rounded group">
            <span className="text-gray-600 shrink-0">{formatTime(log.created_at)}</span>
            <span className={`shrink-0 font-bold w-10 ${LEVEL_COLORS[log.level] ?? 'text-gray-400'}`}>{log.level.toUpperCase()}</span>
            <span className="text-gray-500 shrink-0 w-20 truncate">{log.category}</span>
            <span className="text-gray-300 flex-1 truncate">{log.message}</span>
            {log.trace_id && <span className="text-gray-600 text-[10px] shrink-0 hidden group-hover:inline">{log.trace_id.slice(0, 8)}</span>}
          </div>
        ))}
        {visible.length === 0 && <p className="text-gray-500 text-sm font-sans">Nenhum log. Execute o simulador para gerar logs.</p>}
      </div>
    </div>
  );
}
