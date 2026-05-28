'use client';
import { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Activity, ChevronDown, ChevronRight, Filter, Radio } from 'lucide-react';
import {
  GlassPanel, GlassBadge, GlassInput, Tabs, SectionHeader, EmptyState, Skeleton,
  type BadgeTone,
} from '@/components/ui';
import { cn } from '@/lib/utils';

const API = process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001';

interface TimelineItem {
  source: 'audit' | 'event' | 'log';
  uid: string;
  ts: string;
  level: string;
  actor: string;
  title: string;
  detail: Record<string, unknown> | null;
  trace_id: string | null;
  user_id: string | null;
}

const SOURCE_TONE: Record<string, BadgeTone> = {
  audit: 'accent',
  event: 'info',
  log: 'neutral',
};

function levelTone(level: string): BadgeTone {
  if (level === 'critical' || level === 'error') return 'danger';
  if (level === 'warn') return 'warn';
  if (level === 'state') return 'accent';
  if (level === 'info') return 'info';
  return 'neutral';
}

const ACTOR_COLOR: Record<string, string> = {
  xarlote: 'text-accent-hi',
  agent_pharmacy: 'text-emerald-300',
  agent_clinic: 'text-emerald-300',
  system: 'text-white/50',
  llm: 'text-cyan-300',
  agent: 'text-amber-300',
  webhook: 'text-fuchsia-300',
  outbound: 'text-emerald-300',
  consultation: 'text-sky-300',
  'clinic-discovery': 'text-teal-300',
  red_flag: 'text-rose-300',
  tool: 'text-amber-300',
};

function fmtTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export default function AuditPage() {
  const [items, setItems] = useState<TimelineItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<string>('all');
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [live, setLive] = useState(true);
  const seenUids = useRef<Set<string>>(new Set());

  async function fetchTimeline(initial = false) {
    try {
      const res = await fetch(`${API}/admin/timeline?limit=150`);
      const data: TimelineItem[] = await res.json();
      if (!Array.isArray(data)) return;
      if (initial) {
        data.forEach((d) => seenUids.current.add(d.uid));
        setItems(data);
      } else {
        // Merge: novos no topo
        const novel = data.filter((d) => !seenUids.current.has(d.uid));
        novel.forEach((d) => seenUids.current.add(d.uid));
        if (novel.length > 0) {
          setItems((prev) => [...novel, ...prev].slice(0, 400));
        }
      }
    } catch { /* silencioso */ }
  }

  useEffect(() => {
    setLoading(true);
    fetchTimeline(true).finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!live) return;
    const tid = setInterval(() => fetchTimeline(false), 3000);
    return () => clearInterval(tid);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live]);

  const filtered = items.filter((it) => {
    // Filtro por categoria
    if (filter === 'decisions' && it.source === 'log') return false;
    if (filter === 'critical' && it.level !== 'critical' && it.level !== 'error' && it.level !== 'warn') return false;
    // Busca livre
    if (search) {
      const s = search.toLowerCase();
      const hit = it.title.toLowerCase().includes(s) ||
        it.actor.toLowerCase().includes(s) ||
        (it.trace_id ?? '').toLowerCase().includes(s) ||
        (it.user_id ?? '').toLowerCase().includes(s);
      if (!hit) return false;
    }
    return true;
  });

  function toggle(uid: string) {
    setExpanded((prev) => {
      const n = new Set(prev);
      if (n.has(uid)) n.delete(uid); else n.add(uid);
      return n;
    });
  }

  const counts = {
    all: items.length,
    decisions: items.filter((i) => i.source !== 'log').length,
    critical: items.filter((i) => ['critical', 'error', 'warn'].includes(i.level)).length,
  };

  return (
    <div className="space-y-6">
      <SectionHeader
        icon={Activity}
        title="Auditoria em tempo real"
        subtitle="Cada decisão e ação da Xarlote — audit + eventos + logs unificados"
        action={
          <button
            onClick={() => setLive((v) => !v)}
            className={cn(
              'flex items-center gap-1.5 rounded-full px-3 h-8 text-xs font-medium border transition-colors',
              live ? 'bg-emerald-400/15 text-emerald-300 border-emerald-400/30' : 'bg-white/5 text-white/50 border-white/10',
            )}
          >
            <Radio size={12} className={live ? 'animate-pulse' : ''} />
            {live ? 'Ao vivo' : 'Pausado'}
          </button>
        }
      />

      <GlassPanel className="p-4 space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <Tabs
            value={filter}
            onChange={setFilter}
            options={[
              { value: 'all', label: 'Tudo', count: counts.all },
              { value: 'decisions', label: 'Decisões', count: counts.decisions },
              { value: 'critical', label: '⚠️ Alertas', count: counts.critical },
            ]}
          />
          <div className="flex-1 min-w-[200px] relative">
            <Filter size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-white/40 pointer-events-none" />
            <GlassInput
              placeholder="Filtrar por ação, ator, trace, user…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9"
            />
          </div>
        </div>
      </GlassPanel>

      {loading && (
        <div className="space-y-2">
          {Array.from({ length: 10 }).map((_, i) => <Skeleton key={i} variant="card" />)}
        </div>
      )}

      {!loading && filtered.length === 0 && (
        <EmptyState
          icon={Activity}
          title="Nada por aqui ainda"
          hint="Conforme a Xarlote conversa e age, cada passo aparece aqui em tempo real."
        />
      )}

      <div className="space-y-1">
        <AnimatePresence initial={false}>
          {filtered.map((it) => {
            const open = expanded.has(it.uid);
            const hasDetail = it.detail && Object.keys(it.detail).length > 0;
            return (
              <motion.div
                key={it.uid}
                initial={{ opacity: 0, y: -6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.25 }}
              >
                <div
                  className={cn(
                    'glass glass-spec rounded-xl px-3 py-2 text-sm',
                    hasDetail && 'cursor-pointer hover:bg-white/[0.06]',
                    (it.level === 'critical' || it.level === 'error') && 'ring-1 ring-rose-400/30',
                  )}
                  onClick={() => hasDetail && toggle(it.uid)}
                >
                  <div className="flex items-center gap-2.5">
                    <span className="text-white/35 font-mono text-[11px] shrink-0 w-[58px]">{fmtTime(it.ts)}</span>
                    <GlassBadge tone={SOURCE_TONE[it.source]} size="xs" className="shrink-0 uppercase">{it.source}</GlassBadge>
                    <span className={cn('shrink-0 text-xs font-medium', ACTOR_COLOR[it.actor] ?? 'text-white/60')}>{it.actor}</span>
                    {(it.level === 'critical' || it.level === 'error' || it.level === 'warn') && (
                      <GlassBadge tone={levelTone(it.level)} size="xs" className="shrink-0">{it.level}</GlassBadge>
                    )}
                    <span className="flex-1 truncate text-white/80">{it.title}</span>
                    {hasDetail && (open ? <ChevronDown size={13} className="text-white/40 shrink-0" /> : <ChevronRight size={13} className="text-white/40 shrink-0" />)}
                  </div>

                  {open && hasDetail && (
                    <motion.pre
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: 'auto' }}
                      className="mt-2 pt-2 border-t border-white/10 text-[11px] text-white/70 font-mono overflow-x-auto whitespace-pre-wrap break-all"
                    >
                      {JSON.stringify(it.detail, null, 2)}
                      {it.trace_id && `\n\ntrace: ${it.trace_id}`}
                      {it.user_id && `\nuser: ${it.user_id}`}
                    </motion.pre>
                  )}
                </div>
              </motion.div>
            );
          })}
        </AnimatePresence>
      </div>
    </div>
  );
}
