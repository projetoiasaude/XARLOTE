'use client';
import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { Building2, Star, Phone, MapPin } from 'lucide-react';
import {
  GlassCard, GlassBadge, GlassInput, SectionHeader, EmptyState, Skeleton,
} from '@/components/ui';

const API = process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001';

interface ClinicRow {
  id: string;
  name: string;
  type: string;
  specialties: string[];
  city: string | null;
  state: string | null;
  address: string | null;
  phone_e164: string | null;
  whatsapp_e164: string | null;
  rating: number | null;
  total_consultations: number;
  response_rate: number | null;
  last_contacted_at: string | null;
  blacklist_reason: string | null;
  created_at: string;
}

export default function ClinicsPage() {
  const [items, setItems] = useState<ClinicRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');

  useEffect(() => {
    setLoading(true);
    fetch(`${API}/admin/clinics?limit=200`)
      .then((r) => r.json())
      .then((data: ClinicRow[]) => setItems(Array.isArray(data) ? data : []))
      .catch(() => setItems([]))
      .finally(() => setLoading(false));
  }, []);

  const filtered = items.filter((c) => {
    if (!search) return true;
    const s = search.toLowerCase();
    return (
      c.name.toLowerCase().includes(s) ||
      (c.city ?? '').toLowerCase().includes(s) ||
      (c.specialties ?? []).some((sp) => sp.toLowerCase().includes(s))
    );
  });

  return (
    <div className="space-y-6">
      <SectionHeader
        icon={Building2}
        title="Clínicas"
        subtitle={`Diretório de ${items.length} clínica(s) — alimentado por discovery + scrape`}
      />

      <GlassInput
        placeholder="Buscar por nome, cidade, especialidade..."
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />

      {loading && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} variant="card" />)}
        </div>
      )}

      {!loading && filtered.length === 0 && (
        <EmptyState
          icon={Building2}
          title="Nenhuma clínica encontrada"
          hint="Clínicas são adicionadas via clinic-discovery quando uma busca por especialidade é disparada."
        />
      )}

      <motion.div
        initial="hidden"
        animate="visible"
        variants={{ visible: { transition: { staggerChildren: 0.03 } } }}
        className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3"
      >
        {filtered.map((c) => (
          <motion.div key={c.id} variants={{ hidden: { opacity: 0, y: 6 }, visible: { opacity: 1, y: 0 } }}>
            <GlassCard className="p-4">
              <div className="flex items-start justify-between gap-2 mb-2">
                <h3 className="text-sm font-semibold text-white truncate">{c.name}</h3>
                {c.rating != null && (
                  <span className="flex items-center gap-1 text-xs text-amber-300 shrink-0">
                    <Star size={10} fill="currentColor" /> {c.rating.toFixed(1)}
                  </span>
                )}
              </div>

              {c.specialties.length > 0 && (
                <div className="flex flex-wrap gap-1 mb-2">
                  {c.specialties.slice(0, 3).map((sp) => (
                    <GlassBadge key={sp} tone="info" size="xs">{sp}</GlassBadge>
                  ))}
                </div>
              )}

              <div className="space-y-1 text-xs text-white/60">
                {c.address && (
                  <div className="flex items-start gap-1.5">
                    <MapPin size={10} className="mt-0.5 shrink-0" />
                    <span className="truncate">{c.address}</span>
                  </div>
                )}
                {c.whatsapp_e164 && (
                  <div className="flex items-center gap-1.5">
                    <Phone size={10} className="shrink-0" />
                    <span className="font-mono text-emerald-400/80">{c.whatsapp_e164}</span>
                  </div>
                )}
                {!c.whatsapp_e164 && c.phone_e164 && (
                  <div className="flex items-center gap-1.5 text-white/40">
                    <Phone size={10} className="shrink-0" />
                    <span className="font-mono">{c.phone_e164} (sem WA)</span>
                  </div>
                )}
              </div>

              <div className="mt-3 pt-2 border-t border-white/8 flex items-center justify-between text-[10px] text-white/40">
                <span>{c.total_consultations} consulta(s)</span>
                {c.response_rate != null && <span>Resp: {(c.response_rate * 100).toFixed(0)}%</span>}
                {c.blacklist_reason && <GlassBadge tone="danger" size="xs">blacklist</GlassBadge>}
              </div>
            </GlassCard>
          </motion.div>
        ))}
      </motion.div>
    </div>
  );
}
