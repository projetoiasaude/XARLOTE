'use client';
import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { Pill, AlertCircle, Calendar } from 'lucide-react';
import {
  GlassCard, GlassBadge, SectionHeader, Tabs, EmptyState, Skeleton, type BadgeTone,
} from '@/components/ui';

const API = process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001';

interface TreatmentRow {
  id: string;
  user_id: string;
  user_name: string | null;
  name: string;
  status: 'active' | 'paused' | 'completed' | 'interrupted';
  condition_name: string | null;
  started_at: string;
  ended_at: string | null;
  medication_count: number;
  adherence_score_30d: number | null;
  inventory_low: boolean;
}

const STATUS_TONE: Record<string, BadgeTone> = {
  active: 'success',
  paused: 'warn',
  completed: 'neutral',
  interrupted: 'danger',
};

export default function TreatmentsPage() {
  const [items, setItems] = useState<TreatmentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<string>('active');

  useEffect(() => {
    setLoading(true);
    const url = `${API}/admin/treatments?status=${filter === 'all' ? 'all' : filter}&limit=100`;
    fetch(url)
      .then((r) => r.json())
      .then((data: TreatmentRow[]) => setItems(Array.isArray(data) ? data : []))
      .catch(() => setItems([]))
      .finally(() => setLoading(false));
  }, [filter]);

  const counts = {
    all: items.length,
    active: items.filter((t) => t.status === 'active').length,
    paused: items.filter((t) => t.status === 'paused').length,
  };

  return (
    <div className="space-y-6">
      <SectionHeader
        icon={Pill}
        title="Tratamentos"
        subtitle={`${items.length} tratamento(s) ${filter === 'all' ? 'total' : filter} — visão admin`}
      />

      <Tabs
        value={filter}
        onChange={setFilter}
        options={[
          { value: 'active', label: 'Ativos', count: counts.active },
          { value: 'paused', label: 'Pausados', count: counts.paused },
          { value: 'all', label: 'Todos', count: counts.all },
        ]}
      />

      {loading && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} variant="card" />)}
        </div>
      )}

      {!loading && items.length === 0 && (
        <EmptyState
          icon={Pill}
          title="Nenhum tratamento ainda"
          hint="Tratamentos são criados via tool start_treatment_from_order após confirmação de pedido."
        />
      )}

      <motion.div
        initial="hidden"
        animate="visible"
        variants={{ visible: { transition: { staggerChildren: 0.04 } } }}
        className="grid grid-cols-1 md:grid-cols-2 gap-3"
      >
        {items.map((t) => (
          <motion.div key={t.id} variants={{ hidden: { opacity: 0, y: 8 }, visible: { opacity: 1, y: 0 } }}>
            <GlassCard className="p-4 hover:bg-white/[0.06] transition">
              <div className="flex items-start justify-between gap-2 mb-2">
                <div className="min-w-0">
                  <h3 className="text-base font-semibold text-white truncate">{t.name}</h3>
                  <p className="text-xs text-white/55 truncate">
                    {t.user_name ?? 'sem nome'} · {t.condition_name ?? 'sem condição associada'}
                  </p>
                </div>
                <GlassBadge tone={STATUS_TONE[t.status] ?? 'neutral'}>{t.status}</GlassBadge>
              </div>

              <div className="grid grid-cols-3 gap-2 mt-3 text-xs">
                <div>
                  <div className="text-white/40">Iniciado</div>
                  <div className="text-white/85 font-medium flex items-center gap-1">
                    <Calendar size={11} /> {new Date(t.started_at).toLocaleDateString('pt-BR')}
                  </div>
                </div>
                <div>
                  <div className="text-white/40">Medicamentos</div>
                  <div className="text-white/85 font-medium">{t.medication_count}</div>
                </div>
                <div>
                  <div className="text-white/40">Aderência 30d</div>
                  <div className={`font-bold ${
                    t.adherence_score_30d == null ? 'text-white/40'
                    : t.adherence_score_30d < 0.5 ? 'text-rose-400'
                    : t.adherence_score_30d < 0.8 ? 'text-amber-400'
                    : 'text-emerald-400'
                  }`}>
                    {t.adherence_score_30d != null ? `${(t.adherence_score_30d * 100).toFixed(0)}%` : '—'}
                  </div>
                </div>
              </div>

              {t.inventory_low && (
                <div className="mt-3 flex items-center gap-1.5 text-xs text-amber-300">
                  <AlertCircle size={12} /> Estoque acabando — reposição oferecida
                </div>
              )}
            </GlassCard>
          </motion.div>
        ))}
      </motion.div>
    </div>
  );
}
