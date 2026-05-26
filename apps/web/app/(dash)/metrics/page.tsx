'use client';
import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { TrendingUp, Users, MessageCircle, Activity, AlertTriangle, Pill, Stethoscope } from 'lucide-react';
import { GlassCard, GlassPanel, SectionHeader, Skeleton, EmptyState } from '@/components/ui';

const API = process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001';

interface DailyMetrics {
  day: string;
  total_turns: number;
  total_users_active: number;
  total_messages_in: number;
  total_messages_out: number;
  llm_calls: number;
  llm_p50_ms: number | null;
  llm_p95_ms: number | null;
  llm_p99_ms: number | null;
  llm_total_tokens: number;
  llm_total_cost_usd: number;
  tool_calls: number;
  tool_failures: number;
  tool_counts: Record<string, number>;
  orders_created: number;
  orders_confirmed: number;
  orders_failed: number;
  avg_quotes_per_order: number | null;
  consultations_started: number;
  consultations_scheduled: number;
  consultations_completed: number;
  red_flags_detected: number;
  red_flags_by_category: Record<string, number>;
  tts_synthesized: number;
  tts_avg_ms: number | null;
  stt_transcribed: number;
}

export default function MetricsPage() {
  const [metrics, setMetrics] = useState<DailyMetrics[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`${API}/admin/metrics?days=14`)
      .then((r) => r.json())
      .then((data: DailyMetrics[]) => setMetrics(Array.isArray(data) ? data : []))
      .catch(() => setMetrics([]))
      .finally(() => setLoading(false));
  }, []);

  const today = metrics[0];
  const yesterday = metrics[1];

  const sumLast7 = metrics.slice(0, 7).reduce(
    (acc, d) => ({
      turns: acc.turns + d.total_turns,
      users: Math.max(acc.users, d.total_users_active),
      orders: acc.orders + d.orders_created,
      confirmed: acc.confirmed + d.orders_confirmed,
      cost: acc.cost + d.llm_total_cost_usd,
      consultations: acc.consultations + d.consultations_started,
      red_flags: acc.red_flags + d.red_flags_detected,
    }),
    { turns: 0, users: 0, orders: 0, confirmed: 0, cost: 0, consultations: 0, red_flags: 0 },
  );

  function delta(today: number | null | undefined, yesterday: number | null | undefined): string | undefined {
    if (today == null || yesterday == null || yesterday === 0) return undefined;
    const pct = ((today - yesterday) / yesterday) * 100;
    if (Math.abs(pct) < 1) return undefined;
    return `${pct > 0 ? '+' : ''}${pct.toFixed(0)}% vs ontem`;
  }

  return (
    <div className="space-y-6">
      <SectionHeader
        icon={TrendingUp}
        title="Métricas"
        subtitle="Visão diária do sistema — agregada automaticamente"
      />

      {loading && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} variant="card" />)}
        </div>
      )}

      {!loading && metrics.length === 0 && (
        <EmptyState
          icon={TrendingUp}
          title="Nenhuma métrica agregada ainda"
          hint="O worker metrics-aggregator agrega métricas a cada hora. Espere um pouco depois do primeiro turn."
        />
      )}

      {!loading && today && (
        <>
          <motion.div
            initial="hidden"
            animate="visible"
            variants={{ visible: { transition: { staggerChildren: 0.04 } } }}
            className="grid grid-cols-2 md:grid-cols-4 gap-3"
          >
            <KpiCard icon={<Users size={16} />} label="Users ativos hoje" value={today.total_users_active}
              delta={delta(today.total_users_active, yesterday?.total_users_active)} />
            <KpiCard icon={<MessageCircle size={16} />} label="Turns hoje" value={today.total_turns}
              delta={delta(today.total_turns, yesterday?.total_turns)} />
            <KpiCard icon={<Pill size={16} />} label="Pedidos confirmados" value={today.orders_confirmed}
              delta={delta(today.orders_confirmed, yesterday?.orders_confirmed)} />
            <KpiCard icon={<Stethoscope size={16} />} label="Consultas iniciadas" value={today.consultations_started}
              delta={delta(today.consultations_started, yesterday?.consultations_started)} />
          </motion.div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <GlassCard className="p-5">
              <h3 className="text-sm font-semibold text-white/80 mb-3 flex items-center gap-2">
                <Activity size={14} /> LLM (hoje)
              </h3>
              <div className="grid grid-cols-3 gap-3 text-sm">
                <Mini label="Chamadas" value={today.llm_calls.toLocaleString('pt-BR')} />
                <Mini label="p50" value={today.llm_p50_ms ? `${(today.llm_p50_ms / 1000).toFixed(1)}s` : '—'} />
                <Mini label="p95" value={today.llm_p95_ms ? `${(today.llm_p95_ms / 1000).toFixed(1)}s` : '—'} />
                <Mini label="Tokens" value={today.llm_total_tokens.toLocaleString('pt-BR')} />
                <Mini label="Custo USD" value={`$${today.llm_total_cost_usd.toFixed(2)}`} />
                <Mini label="Falhas tool" value={today.tool_failures} highlight={today.tool_failures > 0 ? 'danger' : undefined} />
              </div>
            </GlassCard>

            <GlassCard className="p-5">
              <h3 className="text-sm font-semibold text-white/80 mb-3 flex items-center gap-2">
                <AlertTriangle size={14} /> Red flags (hoje)
              </h3>
              <div className="text-3xl font-bold text-white mb-2">
                {today.red_flags_detected}
              </div>
              <div className="space-y-1 text-xs text-white/60">
                {Object.entries(today.red_flags_by_category).slice(0, 5).map(([cat, n]) => (
                  <div key={cat} className="flex justify-between">
                    <span>{cat}</span>
                    <span className="font-mono">{n}</span>
                  </div>
                ))}
                {today.red_flags_detected === 0 && (
                  <div className="text-white/40 text-center py-3">Nenhum red flag hoje 🙏</div>
                )}
              </div>
            </GlassCard>

            <GlassCard className="p-5">
              <h3 className="text-sm font-semibold text-white/80 mb-3 flex items-center gap-2">
                <TrendingUp size={14} /> Últimos 7 dias
              </h3>
              <div className="space-y-2 text-xs">
                <Row k="Turns total" v={sumLast7.turns} />
                <Row k="Pedidos criados" v={sumLast7.orders} />
                <Row k="Consultas iniciadas" v={sumLast7.consultations} />
                <Row k="Custo LLM total" v={`$${sumLast7.cost.toFixed(2)}`} />
                <Row k="Red flags total" v={sumLast7.red_flags} highlight={sumLast7.red_flags > 5} />
              </div>
            </GlassCard>
          </div>

          {Object.keys(today.tool_counts).length > 0 && (
            <GlassCard className="p-5">
              <h3 className="text-sm font-semibold text-white/80 mb-3">Tools mais usadas (hoje)</h3>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                {Object.entries(today.tool_counts)
                  .sort((a, b) => b[1] - a[1])
                  .slice(0, 12)
                  .map(([tool, n]) => (
                    <div key={tool} className="flex justify-between bg-white/[0.04] rounded-lg px-3 py-2 text-xs">
                      <span className="text-white/70 truncate font-mono">{tool}</span>
                      <span className="text-white font-bold">{n}</span>
                    </div>
                  ))}
              </div>
            </GlassCard>
          )}

          <GlassPanel className="p-5">
            <h3 className="text-sm font-semibold text-white/80 mb-3">Histórico 14 dias</h3>
            <div className="space-y-1 text-xs">
              <div className="grid grid-cols-7 gap-2 text-white/40 font-mono pb-2 border-b border-white/10">
                <span>Dia</span>
                <span className="text-right">Users</span>
                <span className="text-right">Turns</span>
                <span className="text-right">Ord+</span>
                <span className="text-right">Cons+</span>
                <span className="text-right">🚨</span>
                <span className="text-right">$</span>
              </div>
              {metrics.map((m) => (
                <div key={m.day} className="grid grid-cols-7 gap-2 text-white/70 py-1 hover:bg-white/[0.02] rounded">
                  <span className="font-mono">{m.day.slice(5)}</span>
                  <span className="text-right">{m.total_users_active}</span>
                  <span className="text-right">{m.total_turns}</span>
                  <span className="text-right">{m.orders_confirmed}</span>
                  <span className="text-right">{m.consultations_started}</span>
                  <span className={`text-right ${m.red_flags_detected > 0 ? 'text-rose-400 font-bold' : ''}`}>
                    {m.red_flags_detected}
                  </span>
                  <span className="text-right font-mono">${m.llm_total_cost_usd.toFixed(2)}</span>
                </div>
              ))}
            </div>
          </GlassPanel>
        </>
      )}
    </div>
  );
}

function KpiCard({ icon, label, value, delta }: {
  icon: React.ReactNode;
  label: string;
  value: number | string;
  delta?: string | undefined;
}) {
  return (
    <motion.div variants={{ hidden: { opacity: 0, y: 8 }, visible: { opacity: 1, y: 0 } }}>
      <GlassCard className="p-4">
        <div className="flex items-center gap-2 text-white/55 text-xs">
          {icon}
          <span>{label}</span>
        </div>
        <div className="mt-2 text-3xl font-bold text-white">{value}</div>
        {delta && <div className="text-xs text-white/40 mt-1">{delta}</div>}
      </GlassCard>
    </motion.div>
  );
}

function Mini({ label, value, highlight }: { label: string; value: React.ReactNode; highlight?: 'danger' }) {
  return (
    <div>
      <div className="text-[10px] text-white/40">{label}</div>
      <div className={`text-base font-semibold ${highlight === 'danger' ? 'text-rose-400' : 'text-white'}`}>{value}</div>
    </div>
  );
}

function Row({ k, v, highlight }: { k: string; v: React.ReactNode; highlight?: boolean }) {
  return (
    <div className="flex justify-between items-baseline">
      <span className="text-white/55">{k}</span>
      <span className={`font-semibold tabular-nums ${highlight ? 'text-rose-400' : 'text-white'}`}>{v}</span>
    </div>
  );
}
