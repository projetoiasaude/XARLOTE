'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Activity, ChevronDown, ChevronRight, ChevronsDown, Filter, Radio } from 'lucide-react';
import {
  GlassPanel, GlassBadge, GlassInput, Tabs, SectionHeader, EmptyState, Skeleton,
  type BadgeTone,
} from '@/components/ui';
import { cn } from '@/lib/utils';

const API = process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001';
const PAGE = 120;
const LIVE_CAP = 500; // teto do buffer no modo ao vivo — não vira lista infinita no browser

type View = 'all' | 'decisions' | 'critical';

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

interface TimelineResponse {
  items: TimelineItem[];
  nextCursor: string | null;
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
  const [loadingMore, setLoadingMore] = useState(false);
  const [view, setView] = useState<View>('all');
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [live, setLive] = useState(true);
  const [cursor, setCursor] = useState<string | null>(null);
  const seenUids = useRef<Set<string>>(new Set());

  const buildUrl = useCallback((before?: string) => {
    const p = new URLSearchParams({ limit: String(PAGE) });
    if (view !== 'all') p.set('view', view);
    if (search) p.set('q', search);
    if (before) p.set('before', before);
    return `${API}/admin/timeline?${p.toString()}`;
  }, [view, search]);

  // Busca o topo (mais recentes). initial=true substitui o buffer; senão faz merge no topo.
  const fetchLatest = useCallback(async (initial: boolean) => {
    try {
      const res = await fetch(buildUrl());
      const data: TimelineResponse = await res.json();
      const arr = Array.isArray(data?.items) ? data.items : [];
      if (initial) {
        seenUids.current = new Set(arr.map((d) => d.uid));
        setItems(arr);
        setCursor(data.nextCursor ?? null);
      } else {
        const novel = arr.filter((d) => !seenUids.current.has(d.uid));
        if (novel.length === 0) return;
        novel.forEach((d) => seenUids.current.add(d.uid));
        setItems((prev) => [...novel, ...prev].slice(0, LIVE_CAP));
      }
    } catch { /* silencioso */ }
  }, [buildUrl]);

  // debounce da busca (evita 1 request por tecla)
  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput.trim()), 350);
    return () => clearTimeout(t);
  }, [searchInput]);

  // (re)carrega do zero quando muda a view ou a busca
  useEffect(() => {
    setLoading(true);
    seenUids.current = new Set();
    fetchLatest(true).finally(() => setLoading(false));
  }, [view, search, fetchLatest]);

  // polling ao vivo (só do topo)
  useEffect(() => {
    if (!live) return;
    const tid = setInterval(() => fetchLatest(false), 3000);
    return () => clearInterval(tid);
  }, [live, fetchLatest]);

  // Carrega páginas mais antigas via cursor keyset. Pausa o tail ao vivo
  // pra não brigar com o teto do buffer enquanto se explora o histórico.
  const loadOlder = useCallback(async () => {
    if (!cursor || loadingMore) return;
    setLive(false);
    setLoadingMore(true);
    try {
      const res = await fetch(buildUrl(cursor));
      const data: TimelineResponse = await res.json();
      const arr = Array.isArray(data?.items) ? data.items : [];
      const novel = arr.filter((d) => !seenUids.current.has(d.uid));
      novel.forEach((d) => seenUids.current.add(d.uid));
      setItems((prev) => [...prev, ...novel]);
      setCursor(data.nextCursor ?? null);
    } catch { /* silencioso */ }
    finally { setLoadingMore(false); }
  }, [cursor, loadingMore, buildUrl]);

  function toggle(uid: string) {
    setExpanded((prev) => {
      const n = new Set(prev);
      if (n.has(uid)) n.delete(uid); else n.add(uid);
      return n;
    });
  }

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
            id="audit"
            value={view}
            onChange={(v) => setView(v as View)}
            options={[
              { value: 'all', label: 'Tudo' },
              { value: 'decisions', label: 'Decisões' },
              { value: 'critical', label: '⚠️ Alertas' },
            ]}
          />
          <div className="flex-1 min-w-[200px] relative">
            <Filter size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-white/40 pointer-events-none" />
            <GlassInput
              placeholder="Buscar no histórico todo: ação, ator, mensagem…"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              className="pl-9"
            />
          </div>
        </div>
        <p className="text-[11px] text-white/35">
          Filtros e busca rodam no servidor (varrem o histórico inteiro, não só o que está na tela).
          {' '}Logs operacionais antigos são podados automaticamente; auditoria e eventos ficam guardados.
        </p>
      </GlassPanel>

      {loading && (
        <div className="space-y-2">
          {Array.from({ length: 10 }).map((_, i) => <Skeleton key={i} variant="card" />)}
        </div>
      )}

      {!loading && items.length === 0 && (
        <EmptyState
          icon={Activity}
          title="Nada por aqui ainda"
          hint="Conforme a Xarlote conversa e age, cada passo aparece aqui em tempo real."
        />
      )}

      {!loading && items.length > 0 && (
        <div className="space-y-1">
          <AnimatePresence initial={false}>
            {items.map((it) => {
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

          {/* Paginação keyset: carrega histórico mais antigo sob demanda */}
          <div className="pt-3 flex flex-col items-center gap-1.5">
            {cursor ? (
              <button
                onClick={loadOlder}
                disabled={loadingMore}
                className={cn(
                  'flex items-center gap-1.5 rounded-full px-4 h-9 text-xs font-medium border transition-colors',
                  'bg-white/5 text-white/70 border-white/10 hover:bg-white/10 disabled:opacity-50',
                )}
              >
                <ChevronsDown size={13} className={loadingMore ? 'animate-bounce' : ''} />
                {loadingMore ? 'Carregando…' : 'Carregar mais antigas'}
              </button>
            ) : (
              <span className="text-[11px] text-white/30">fim do histórico carregado</span>
            )}
            <span className="text-[11px] text-white/25">{items.length} eventos na tela</span>
          </div>
        </div>
      )}
    </div>
  );
}
