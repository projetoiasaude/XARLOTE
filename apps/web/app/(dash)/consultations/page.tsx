'use client';
import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { Stethoscope, MapPin, Star } from 'lucide-react';
import {
  GlassCard, GlassBadge, SectionHeader, Tabs, EmptyState, Skeleton, type BadgeTone,
} from '@/components/ui';

const API = process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001';

interface ConsultationRow {
  id: string;
  user_id: string;
  user_name: string | null;
  status: 'searching' | 'quoting' | 'quoted' | 'confirming' | 'scheduled' | 'completed' | 'cancelled' | 'failed';
  specialty: string;
  urgency: string;
  modality: string | null;
  city: string | null;
  scheduled_at: string | null;
  scheduled_clinic_name: string | null;
  user_rating: number | null;
  quotes_offered: number;
  quotes_total: number;
  created_at: string;
}

const STATUS_TONE: Record<string, BadgeTone> = {
  searching: 'info',
  quoting: 'info',
  quoted: 'accent',
  confirming: 'warn',
  scheduled: 'success',
  completed: 'success',
  cancelled: 'neutral',
  failed: 'danger',
};

function formatDateTime(iso: string | null): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('pt-BR', {
      day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
    });
  } catch { return iso; }
}

export default function ConsultationsPage() {
  const [items, setItems] = useState<ConsultationRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<string>('active');

  useEffect(() => {
    setLoading(true);
    fetch(`${API}/admin/consultations?status=${filter}&limit=100`)
      .then((r) => r.json())
      .then((data: ConsultationRow[]) => setItems(Array.isArray(data) ? data : []))
      .catch(() => setItems([]))
      .finally(() => setLoading(false));
  }, [filter]);

  const counts = {
    active: items.filter((c) => ['searching', 'quoting', 'quoted', 'confirming'].includes(c.status)).length,
    scheduled: items.filter((c) => c.status === 'scheduled').length,
    completed: items.filter((c) => c.status === 'completed').length,
    all: items.length,
  };

  return (
    <div className="space-y-6">
      <SectionHeader
        icon={Stethoscope}
        title="Consultas"
        subtitle={`${items.length} consulta(s) — visão admin`}
      />

      <Tabs
        value={filter}
        onChange={setFilter}
        options={[
          { value: 'active', label: 'Em andamento', count: counts.active },
          { value: 'scheduled', label: 'Agendadas', count: counts.scheduled },
          { value: 'completed', label: 'Realizadas', count: counts.completed },
          { value: 'all', label: 'Tudo', count: counts.all },
        ]}
      />

      {loading && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} variant="card" />)}
        </div>
      )}

      {!loading && items.length === 0 && (
        <EmptyState
          icon={Stethoscope}
          title="Nenhuma consulta ainda"
          hint="Consultas são iniciadas via tool start_consultation_search."
        />
      )}

      <motion.div
        initial="hidden"
        animate="visible"
        variants={{ visible: { transition: { staggerChildren: 0.04 } } }}
        className="grid grid-cols-1 md:grid-cols-2 gap-3"
      >
        {items.map((c) => (
          <motion.div key={c.id} variants={{ hidden: { opacity: 0, y: 8 }, visible: { opacity: 1, y: 0 } }}>
            <GlassCard className="p-4">
              <div className="flex items-start justify-between gap-2 mb-2">
                <div className="min-w-0">
                  <h3 className="text-base font-semibold text-white truncate">
                    {c.specialty}
                  </h3>
                  <p className="text-xs text-white/55 truncate">
                    {c.user_name ?? 'sem nome'} · {c.modality ?? 'modalidade indef.'}
                    {c.city && <> · <MapPin size={10} className="inline" /> {c.city}</>}
                  </p>
                </div>
                <div className="flex flex-col items-end gap-1">
                  <GlassBadge tone={STATUS_TONE[c.status] ?? 'neutral'}>{c.status}</GlassBadge>
                  <GlassBadge tone="neutral" size="xs">{c.urgency}</GlassBadge>
                </div>
              </div>

              {c.scheduled_clinic_name && (
                <div className="mt-2 text-xs text-white/70">
                  📅 {formatDateTime(c.scheduled_at)} · {c.scheduled_clinic_name}
                </div>
              )}

              <div className="grid grid-cols-3 gap-2 mt-3 text-xs">
                <div>
                  <div className="text-white/40">Criada</div>
                  <div className="text-white/85">{formatDateTime(c.created_at)}</div>
                </div>
                <div>
                  <div className="text-white/40">Cotações</div>
                  <div className="text-white/85 font-medium">{c.quotes_offered}/{c.quotes_total}</div>
                </div>
                {c.user_rating != null && (
                  <div>
                    <div className="text-white/40">Avaliação</div>
                    <div className="text-amber-300 font-bold flex items-center gap-0.5">
                      {c.user_rating} <Star size={10} fill="currentColor" />
                    </div>
                  </div>
                )}
              </div>
            </GlassCard>
          </motion.div>
        ))}
      </motion.div>
    </div>
  );
}
