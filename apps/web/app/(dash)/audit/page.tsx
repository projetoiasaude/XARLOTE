'use client';
import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { Shield, ChevronDown, ChevronRight, Filter } from 'lucide-react';
import {
  GlassCard, GlassPanel, GlassBadge, GlassInput, Tabs, SectionHeader, EmptyState, Skeleton,
  type BadgeTone,
} from '@/components/ui';
import { cn } from '@/lib/utils';

const API = process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001';

interface AuditRow {
  id: string;
  occurred_at: string;
  actor_type: string;
  actor_id: string | null;
  action: string;
  user_id: string | null;
  conversation_id: string | null;
  target_table: string | null;
  target_id: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  reason: string | null;
  metadata: Record<string, unknown> | null;
  trace_id: string | null;
}

const ACTOR_TONE: Record<string, BadgeTone> = {
  xarlote: 'info',
  agent_pharmacy: 'success',
  agent_clinic: 'success',
  system: 'neutral',
  admin: 'warn',
  user: 'info',
  webhook: 'neutral',
};

function actionTone(action: string): BadgeTone {
  if (action.includes('failed') || action.includes('cancelled') || action.includes('error')) return 'danger';
  if (action.includes('red_flag') || action.includes('alert')) return 'danger';
  if (action.includes('success') || action.includes('confirmed') || action.includes('completed')) return 'success';
  if (action.includes('warn') || action.includes('dropped')) return 'warn';
  return 'info';
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const isToday = d.toDateString() === today.toDateString();
  if (isToday) return d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  return d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

export default function AuditPage() {
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterAction, setFilterAction] = useState<string>('all');
  const [searchTerm, setSearchTerm] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  useEffect(() => {
    setLoading(true);
    const url = new URL(`${API}/admin/audit`);
    url.searchParams.set('limit', '200');
    if (filterAction !== 'all') url.searchParams.set('action', filterAction);

    fetch(url.toString())
      .then((r) => r.json())
      .then((data: AuditRow[]) => setRows(Array.isArray(data) ? data : []))
      .catch(() => setRows([]))
      .finally(() => setLoading(false));
  }, [filterAction]);

  // Auto-refresh 5s
  useEffect(() => {
    const tid = setInterval(() => {
      const url = new URL(`${API}/admin/audit`);
      url.searchParams.set('limit', '50');
      if (filterAction !== 'all') url.searchParams.set('action', filterAction);
      fetch(url.toString())
        .then((r) => r.json())
        .then((fresh: AuditRow[]) => {
          if (!Array.isArray(fresh)) return;
          setRows((prev) => {
            const seen = new Set(prev.map((r) => r.id));
            const novel = fresh.filter((r) => !seen.has(r.id));
            return [...novel, ...prev].slice(0, 500);
          });
        })
        .catch(() => {});
    }, 5_000);
    return () => clearInterval(tid);
  }, [filterAction]);

  const filtered = rows.filter((r) => {
    if (!searchTerm) return true;
    const s = searchTerm.toLowerCase();
    return (
      r.action.toLowerCase().includes(s) ||
      r.actor_type.toLowerCase().includes(s) ||
      (r.reason ?? '').toLowerCase().includes(s) ||
      (r.user_id ?? '').toLowerCase().includes(s) ||
      (r.trace_id ?? '').toLowerCase().includes(s)
    );
  });

  function toggleExpand(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const counts = {
    all: rows.length,
    'red_flag.detected': rows.filter((r) => r.action === 'red_flag.detected').length,
    'tool.failed': rows.filter((r) => r.action === 'tool.failed').length,
    'order': rows.filter((r) => r.action.startsWith('order')).length,
    'consultation': rows.filter((r) => r.action.startsWith('consultation')).length,
  };

  return (
    <div className="space-y-6">
      <SectionHeader
        icon={Shield}
        title="Auditoria"
        subtitle={`${rows.length} eventos rastreados — auto-refresh 5s`}
      />

      <GlassPanel className="p-4 space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          <Tabs
            value={filterAction}
            onChange={setFilterAction}
            options={[
              { value: 'all', label: `Tudo (${counts.all})` },
              { value: 'red_flag.detected', label: `🚨 Red flags (${counts['red_flag.detected']})` },
              { value: 'tool.failed', label: `Falhas tool (${counts['tool.failed']})` },
            ]}
          />
          <div className="flex-1 min-w-[200px] relative">
            <Filter size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-white/40 pointer-events-none" />
            <GlassInput
              placeholder="Filtrar por ação, ator, motivo, user, trace…"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="pl-9"
            />
          </div>
        </div>
      </GlassPanel>

      {loading && (
        <div className="space-y-2">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} variant="card" />
          ))}
        </div>
      )}

      {!loading && filtered.length === 0 && (
        <EmptyState
          icon={Shield}
          title="Nenhum evento auditado ainda"
          hint="Eventos aparecem aqui em tempo real conforme acontecem no sistema."
        />
      )}

      <motion.div
        initial="hidden"
        animate="visible"
        variants={{ visible: { transition: { staggerChildren: 0.02 } } }}
        className="space-y-1.5"
      >
        {filtered.map((row) => {
          const isOpen = expanded.has(row.id);
          return (
            <motion.div
              key={row.id}
              variants={{ hidden: { opacity: 0, y: 4 }, visible: { opacity: 1, y: 0 } }}
            >
              <GlassCard
                variant="lo"
                className={cn('p-3 cursor-pointer transition-all', isOpen && 'ring-1 ring-white/15')}
                onClick={() => toggleExpand(row.id)}
              >
                <div className="flex items-center gap-3 text-sm">
                  <span className="text-white/40 font-mono text-xs shrink-0 w-16">{formatTime(row.occurred_at)}</span>
                  <GlassBadge tone={ACTOR_TONE[row.actor_type] ?? 'neutral'} className="shrink-0">
                    {row.actor_type}
                  </GlassBadge>
                  <GlassBadge tone={actionTone(row.action)} className="shrink-0">
                    {row.action}
                  </GlassBadge>
                  <span className="text-white/70 flex-1 truncate">{row.reason ?? row.target_table ?? '—'}</span>
                  {row.user_id && (
                    <span className="text-white/30 font-mono text-[10px] shrink-0">u:{row.user_id.slice(0, 6)}</span>
                  )}
                  {isOpen ? <ChevronDown size={14} className="text-white/40" /> : <ChevronRight size={14} className="text-white/40" />}
                </div>

                {isOpen && (
                  <motion.div
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: 'auto' }}
                    transition={{ duration: 0.2 }}
                    className="mt-3 pt-3 border-t border-white/10 grid gap-2 text-xs font-mono"
                  >
                    <Row k="action" v={row.action} />
                    <Row k="actor" v={`${row.actor_type}${row.actor_id ? ` (${row.actor_id})` : ''}`} />
                    {row.target_table && <Row k="target" v={`${row.target_table}/${row.target_id ?? '—'}`} />}
                    {row.conversation_id && <Row k="conv" v={row.conversation_id} />}
                    {row.trace_id && <Row k="trace" v={row.trace_id} />}
                    {row.reason && <Row k="reason" v={row.reason} />}
                    {row.before && Object.keys(row.before).length > 0 && (
                      <Row k="before" v={<JsonBlock data={row.before} />} />
                    )}
                    {row.after && Object.keys(row.after).length > 0 && (
                      <Row k="after" v={<JsonBlock data={row.after} />} />
                    )}
                    {row.metadata && Object.keys(row.metadata).length > 0 && (
                      <Row k="metadata" v={<JsonBlock data={row.metadata} />} />
                    )}
                  </motion.div>
                )}
              </GlassCard>
            </motion.div>
          );
        })}
      </motion.div>
    </div>
  );
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[60px_1fr] gap-3">
      <span className="text-white/40">{k}</span>
      <span className="text-white/80 break-all">{v}</span>
    </div>
  );
}

function JsonBlock({ data }: { data: Record<string, unknown> }) {
  return (
    <pre className="text-[11px] bg-white/5 rounded-lg p-2 overflow-x-auto">
      {JSON.stringify(data, null, 2)}
    </pre>
  );
}
