'use client';
import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { MapPin, Phone, Star, Ban, Store, Search } from 'lucide-react';
import { timeAgo, adminGet } from '@/lib/utils';
import {
  GlassCard, GlassBadge, GlassInput, Avatar, SectionHeader, EmptyState,
  Tabs, type BadgeTone,
} from '@/components/ui';

interface Supplier {
  id: string;
  name: string;
  phone_e164: string | null;
  whatsapp_e164: string | null;
  whatsapp_verified_at: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  rating: number | null;
  reviews: number | null;
  status: string;
  blacklist_reason: string | null;
  tags: string[];
  last_contacted_at: string | null;
  source: string;
  created_at: string;
}

const STATUS_TONE: Record<string, BadgeTone> = {
  active: 'success',
  blacklisted: 'danger',
  inactive: 'neutral',
};

export default function SuppliersPage() {
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [filter, setFilter] = useState<'all' | 'active' | 'blacklisted'>('all');
  const [search, setSearch] = useState('');

  useEffect(() => {
    // Leitura via API (service role + token do login). Supabase anon e bloqueado pelo RLS (is_staff).
    adminGet<Supplier[]>('/admin/suppliers')
      .then((data) => setSuppliers(data ?? []))
      .catch(() => { /* falha transitoria — mantem */ });
  }, []);

  const visible = suppliers
    .filter((s) => filter === 'all' || s.status === filter)
    .filter((s) =>
      !search ||
      s.name.toLowerCase().includes(search.toLowerCase()) ||
      (s.city ?? '').toLowerCase().includes(search.toLowerCase()),
    );

  const countAll = suppliers.length;
  const countActive = suppliers.filter((s) => s.status === 'active').length;
  const countBlacklisted = suppliers.filter((s) => s.status === 'blacklisted').length;

  return (
    <div className="space-y-6">
      <SectionHeader
        icon={Store}
        title="Farmácias"
        subtitle={`${countAll} cadastradas`}
        size="lg"
        action={
          <Tabs
            id="suppliers-filter"
            value={filter}
            onChange={(v) => setFilter(v as typeof filter)}
            size="sm"
            options={[
              { value: 'all', label: 'Todas', count: countAll },
              { value: 'active', label: 'Ativas', count: countActive },
              { value: 'blacklisted', label: 'Bloqueadas', count: countBlacklisted },
            ]}
          />
        }
      />

      <div className="relative max-w-md">
        <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-white/40 pointer-events-none" />
        <GlassInput
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Buscar por nome ou cidade…"
          className="pl-9"
        />
      </div>

      {visible.length === 0 ? (
        <GlassCard className="p-2">
          <EmptyState
            icon={Store}
            title={search ? 'Nenhum resultado' : 'Nenhuma farmácia ainda'}
            hint={search ? 'Tente outro termo.' : 'Suppliers aparecem aqui após a primeira busca via Google Places.'}
          />
        </GlassCard>
      ) : (
        <motion.div
          initial="hidden"
          animate="show"
          variants={{
            hidden: { opacity: 0 },
            show: { opacity: 1, transition: { staggerChildren: 0.04 } },
          }}
          className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4"
        >
          {visible.map((s) => (
            <motion.div
              key={s.id}
              variants={{
                hidden: { opacity: 0, y: 8 },
                show: { opacity: 1, y: 0, transition: { type: 'spring' as const, stiffness: 320, damping: 26 } },
              }}
            >
              <GlassCard className="p-4 h-full flex flex-col">
                <div className="flex items-start gap-3 mb-2">
                  <Avatar name={s.name} size="sm" />
                  <div className="flex-1 min-w-0">
                    <p className="text-white font-semibold text-sm leading-tight">{s.name}</p>
                    {s.rating !== null && (
                      <div className="flex items-center gap-1 text-xs text-amber-300 mt-0.5">
                        <Star size={11} fill="currentColor" />
                        <span>{s.rating.toFixed(1)}</span>
                        {s.reviews && <span className="text-white/40">({s.reviews})</span>}
                      </div>
                    )}
                  </div>
                  <GlassBadge tone={STATUS_TONE[s.status] ?? 'neutral'} size="xs">
                    {s.status}
                  </GlassBadge>
                </div>

                <div className="space-y-1.5 flex-1 mb-2">
                  {s.address && (
                    <div className="flex items-start gap-1.5 text-xs text-white/55">
                      <MapPin size={11} className="mt-0.5 shrink-0 text-emerald-300/70" />
                      <span>{s.address}{s.city ? `, ${s.city}` : ''}{s.state ? `/${s.state}` : ''}</span>
                    </div>
                  )}
                  <div className="flex items-center gap-3 text-xs">
                    {s.phone_e164 && (
                      <span className="flex items-center gap-1 text-white/55">
                        <Phone size={11} /> {s.phone_e164}
                      </span>
                    )}
                    {s.whatsapp_verified_at ? (
                      <GlassBadge tone="success" size="xs">WhatsApp ✓</GlassBadge>
                    ) : (
                      <span className="text-white/30 text-[11px]">sem WA</span>
                    )}
                  </div>

                  {s.tags && s.tags.length > 0 && (
                    <div className="flex flex-wrap gap-1 pt-1">
                      {s.tags.slice(0, 4).map((tag) => (
                        <span
                          key={tag}
                          className="text-[10px] bg-white/[0.04] text-white/55 px-1.5 py-0.5 rounded border border-white/8"
                        >
                          {tag}
                        </span>
                      ))}
                    </div>
                  )}

                  {s.blacklist_reason && (
                    <div className="flex items-start gap-1.5 text-xs text-rose-300 mt-1">
                      <Ban size={11} className="mt-0.5 shrink-0" />
                      <span>{s.blacklist_reason}</span>
                    </div>
                  )}
                </div>

                <div className="flex items-center justify-between text-[10px] text-white/35 pt-2 border-t border-white/5">
                  <span className="uppercase tracking-wider">{s.source}</span>
                  {s.last_contacted_at
                    ? <span>{timeAgo(s.last_contacted_at)}</span>
                    : <span>nunca contatado</span>}
                </div>
              </GlassCard>
            </motion.div>
          ))}
        </motion.div>
      )}
    </div>
  );
}
