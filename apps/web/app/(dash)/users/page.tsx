'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { motion } from 'framer-motion';
import { Users as UsersIcon, Search } from 'lucide-react';
import { timeAgo, adminGet } from '@/lib/utils';
import {
  GlassCard, GlassInput, GlassBadge, Avatar, SectionHeader, EmptyState,
  type BadgeTone,
} from '@/components/ui';

interface User {
  id: string;
  phone_e164: string;
  preferred_name: string | null;
  full_name: string | null;
  onboarding_status: string;
  lgpd_consent_at: string | null;
  created_at: string;
}

const ONBOARDING_TONE: Record<string, BadgeTone> = {
  not_started: 'neutral',
  consent_pending: 'warn',
  profiling: 'info',
  active: 'success',
};

export default function UsersPage() {
  const [users, setUsers] = useState<User[]>([]);
  const [search, setSearch] = useState('');
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    // Leitura via API (service role + token do login). Supabase anon e bloqueado pelo RLS (is_staff).
    adminGet<User[]>('/admin/users?limit=200')
      .then((data) => setUsers(data ?? []))
      .catch(() => { /* falha transitoria — mantem */ })
      .finally(() => setLoaded(true));
  }, []);

  const visible = users.filter(
    (u) =>
      !search ||
      (u.preferred_name ?? '').toLowerCase().includes(search.toLowerCase()) ||
      (u.full_name ?? '').toLowerCase().includes(search.toLowerCase()) ||
      u.phone_e164.includes(search),
  );

  const name = (u: User) => u.preferred_name ?? u.full_name ?? u.phone_e164;

  return (
    <div className="space-y-6">
      <SectionHeader
        icon={UsersIcon}
        title="Usuários"
        subtitle={`${users.length} cadastrados`}
        size="lg"
      />

      <div className="relative max-w-md">
        <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-white/40 pointer-events-none" />
        <GlassInput
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Buscar por nome ou telefone…"
          className="pl-9"
        />
      </div>

      {visible.length === 0 ? (
        <GlassCard className="p-2">
          <EmptyState
            icon={UsersIcon}
            title={search ? 'Nenhum resultado' : 'Nenhum usuário ainda'}
            hint={!loaded ? 'Carregando…' : search ? 'Tente outro termo.' : 'Use o simulador pra começar.'}
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
          className="space-y-2"
        >
          {visible.map((u) => (
            <motion.div
              key={u.id}
              variants={{
                hidden: { opacity: 0, y: 6 },
                show: { opacity: 1, y: 0, transition: { type: 'spring' as const, stiffness: 320, damping: 26 } },
              }}
            >
              <Link href={`/users/${u.id}`} className="block">
                <GlassCard variant="lo" interactive className="px-4 py-3 flex items-center gap-3">
                  <Avatar name={name(u)} size="md" />
                  <div className="min-w-0 flex-1">
                    <p className="text-white text-sm font-medium truncate">{name(u)}</p>
                    <p className="text-white/40 text-[11px] font-mono">{u.phone_e164}</p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <span className="text-[11px] text-white/40 hidden md:inline">{timeAgo(u.created_at)}</span>
                    <GlassBadge tone={ONBOARDING_TONE[u.onboarding_status] ?? 'neutral'} size="xs">
                      {u.onboarding_status}
                    </GlassBadge>
                  </div>
                </GlassCard>
              </Link>
            </motion.div>
          ))}
        </motion.div>
      )}
    </div>
  );
}
