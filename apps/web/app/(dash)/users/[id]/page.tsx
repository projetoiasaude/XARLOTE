'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { motion } from 'framer-motion';
import {
  Heart, AlertTriangle, Pill, MapPin, Clock, FileText, Brain, Bell,
  Sparkles, User as UserIcon, Quote, Calendar, Smile, ArrowLeft, BadgeCheck,
} from 'lucide-react';
import { timeAgo, apiUrl } from '@/lib/utils';
import {
  GlassCard, GlassBadge, Avatar, SectionHeader, EmptyState, Stat, Skeleton,
  type BadgeTone,
} from '@/components/ui';

interface User {
  id: string;
  phone_e164: string;
  preferred_name: string | null;
  full_name: string | null;
  birth_date: string | null;
  gender: string;
  onboarding_status: string;
  lgpd_consent_at: string | null;
  timezone: string;
  metadata?: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}
interface HealthCondition { id: string; name: string; severity: string | null; active: boolean; source?: string; created_at: string; }
interface Allergy { id: string; substance: string; reaction: string | null; severity: string | null; source?: string; created_at: string; }
interface Medication { id: string; medication_name: string; dosage: string | null; frequency: string | null; active: boolean; source?: string; created_at: string; }
interface Address { id: string; label: string; street: string | null; number?: string | null; neighborhood?: string | null; city: string | null; state: string | null; cep?: string | null; is_default: boolean; }
interface Order { id: string; status: string; items: Array<{ name: string }>; created_at: string; }
interface MemoryCard {
  id: string;
  kind: 'fact' | 'episode' | 'preference' | 'affect';
  text: string;
  tags: string[];
  confidence: number;
  source: string;
  last_seen_at: string;
  created_at: string;
}
interface Reminder {
  id: string;
  type: string;
  title: string;
  body: string | null;
  scheduled_at: string | null;
  rrule: string | null;
  next_run_at: string | null;
  status: string;
}
interface ProfileData {
  user: User;
  conditions: HealthCondition[];
  allergies: Allergy[];
  medications: Medication[];
  addresses: Address[];
  recentOrders: Order[];
  memoryCards: MemoryCard[];
  reminders: Reminder[];
}

const STATUS_TONE: Record<string, BadgeTone> = {
  drafting: 'neutral',
  quoting: 'warn',
  quoted: 'info',
  confirming: 'info',
  handed_off: 'success',
  cancelled: 'danger',
  failed: 'danger',
};

const ONBOARDING_TONE: Record<string, BadgeTone> = {
  active: 'success',
  profiling: 'info',
  consent_pending: 'warn',
  not_started: 'neutral',
};

const KIND_META: Record<MemoryCard['kind'], { label: string; icon: typeof Brain; color: string; tint: string }> = {
  fact: { label: 'Fatos durables', icon: Sparkles, color: 'text-purple-200', tint: 'from-purple-500/20 via-purple-500/5 to-transparent' },
  affect: { label: 'Contexto afetivo', icon: Smile, color: 'text-pink-200', tint: 'from-pink-500/20 via-pink-500/5 to-transparent' },
  preference: { label: 'Preferências', icon: UserIcon, color: 'text-cyan-200', tint: 'from-cyan-500/20 via-cyan-500/5 to-transparent' },
  episode: { label: 'Eventos recentes', icon: Quote, color: 'text-amber-200', tint: 'from-amber-500/20 via-amber-500/5 to-transparent' },
};

function SourceBadge({ source }: { source?: string }) {
  if (!source) return null;
  const inferred = source === 'inferred';
  return (
    <GlassBadge tone={inferred ? 'info' : 'success'} size="xs">
      {inferred ? 'auto' : 'usuário'}
    </GlassBadge>
  );
}

function ConfidenceBar({ value }: { value: number }) {
  const pct = Math.max(0, Math.min(1, value)) * 100;
  const tone = pct >= 80 ? 'bg-emerald-400' : pct >= 60 ? 'bg-amber-400' : 'bg-rose-400';
  return (
    <div className="flex items-center gap-1.5" title={`Confidence: ${pct.toFixed(0)}%`}>
      <div className="h-1 w-12 bg-white/8 rounded-full overflow-hidden">
        <div className={`h-full ${tone}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-[10px] text-white/45 tabular-nums">{pct.toFixed(0)}</span>
    </div>
  );
}

function formatRRule(rrule: string | null): string {
  if (!rrule) return '';
  const m = rrule.match(/FREQ=([A-Z]+)/);
  if (!m) return rrule;
  const map: Record<string, string> = { DAILY: 'diário', WEEKLY: 'semanal', MONTHLY: 'mensal', YEARLY: 'anual', HOURLY: 'a cada hora' };
  return map[m[1]!] ?? rrule;
}

export default function UserProfilePage({ params }: { params: { id: string } }) {
  const { id } = params;
  const [data, setData] = useState<ProfileData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(apiUrl(`/admin/users/${id}`))
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((d: ProfileData) => { if (!cancelled) setData(d); })
      .catch((e) => { if (!cancelled) setError(String(e)); });
    return () => { cancelled = true; };
  }, [id]);

  if (error) {
    return (
      <GlassCard className="p-6 text-rose-300">Erro ao carregar perfil: {error}</GlassCard>
    );
  }

  if (!data) {
    return (
      <div className="space-y-4">
        <Skeleton variant="card" className="h-24" />
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Skeleton variant="card" />
          <Skeleton variant="card" />
        </div>
      </div>
    );
  }

  const { user, conditions, allergies, medications, addresses, recentOrders, memoryCards, reminders } = data;
  const displayName = user.preferred_name ?? user.full_name ?? user.phone_e164;
  const cardsByKind = (k: MemoryCard['kind']) => memoryCards.filter((c) => c.kind === k);
  const remindersPending = reminders.filter((r) => r.status === 'pending').length;
  const remindersSent = reminders.filter((r) => r.status === 'sent').length;

  return (
    <div className="space-y-6">
      {/* Back nav */}
      <Link
        href="/users"
        className="inline-flex items-center gap-1.5 text-sm text-white/55 hover:text-white transition-colors"
      >
        <ArrowLeft size={14} />
        Usuários
      </Link>

      {/* Hero */}
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
      >
        <GlassCard className="p-6">
          <div className="flex flex-col md:flex-row items-start gap-5">
            <Avatar name={displayName} size="xl" />
            <div className="flex-1 min-w-0">
              <h1 className="text-2xl font-semibold text-white tracking-tight">{displayName}</h1>
              {user.full_name && user.preferred_name && user.full_name !== user.preferred_name && (
                <p className="text-white/60 text-sm">{user.full_name}</p>
              )}
              <p className="text-white/40 text-sm font-mono mt-0.5">{user.phone_e164}</p>
              <div className="flex flex-wrap gap-2 mt-3">
                <GlassBadge tone={ONBOARDING_TONE[user.onboarding_status] ?? 'neutral'} dot>
                  {user.onboarding_status}
                </GlassBadge>
                {user.lgpd_consent_at && (
                  <GlassBadge tone="info">
                    <BadgeCheck size={11} className="mr-0.5" /> LGPD · {timeAgo(user.lgpd_consent_at)}
                  </GlassBadge>
                )}
                {user.birth_date && (
                  <GlassBadge tone="neutral">
                    {new Date(user.birth_date).toLocaleDateString('pt-BR')}
                  </GlassBadge>
                )}
                <span className="text-xs text-white/35 self-center">Cliente desde {timeAgo(user.created_at)}</span>
              </div>
            </div>

            <div className="grid grid-cols-3 gap-2 shrink-0">
              <Stat label="Memória" value={memoryCards.length} icon={<Brain size={11} />} />
              <Stat label="Lembretes" value={remindersPending} icon={<Bell size={11} />} />
              <Stat label="Pedidos" value={recentOrders.length} icon={<FileText size={11} />} />
            </div>
          </div>
        </GlassCard>
      </motion.div>

      {/* Memória */}
      <motion.section
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, delay: 0.1, ease: [0.22, 1, 0.36, 1] }}
      >
        <GlassCard className="relative overflow-hidden p-6">
          <div
            aria-hidden
            className="pointer-events-none absolute -top-20 -right-20 h-64 w-64 rounded-full bg-gradient-to-br from-accent/30 via-aurora-purple/15 to-transparent blur-3xl"
          />
          <div className="relative">
            <SectionHeader
              icon={Brain}
              title={`Memória da Xarlote sobre ${displayName.split(' ')[0]}`}
              subtitle={`${memoryCards.length} cards · recuperados por relevância semântica`}
              action={
                memoryCards.length > 0 && (
                  <GlassBadge tone="accent" dot>
                    {memoryCards.length} cards
                  </GlassBadge>
                )
              }
            />

            {memoryCards.length === 0 ? (
              <EmptyState
                icon={Brain}
                title="Ainda não há memória registrada"
                hint="Conforme o usuário conversar, a Xarlote extrai fatos automaticamente."
                className="py-6"
              />
            ) : (
              <div className="mt-5 grid grid-cols-1 md:grid-cols-2 gap-3">
                {(['fact', 'affect', 'preference', 'episode'] as const).map((kind) => {
                  const cards = cardsByKind(kind);
                  if (cards.length === 0) return null;
                  const meta = KIND_META[kind];
                  const Icon = meta.icon;
                  return (
                    <div key={kind} className="relative overflow-hidden rounded-2xl border border-white/8 bg-white/[0.03] p-4">
                      <div className={`pointer-events-none absolute -top-12 -right-12 h-32 w-32 rounded-full bg-gradient-to-br ${meta.tint} blur-2xl`} />
                      <div className="relative">
                        <div className={`flex items-center gap-2 text-xs font-semibold mb-3 ${meta.color}`}>
                          <Icon size={13} />
                          {meta.label}
                          <span className="text-white/30 font-normal">· {cards.length}</span>
                        </div>
                        <div className="space-y-2">
                          {cards.slice(0, 8).map((c) => (
                            <div key={c.id} className="flex items-start gap-2 text-sm">
                              <span className="text-white/85 flex-1 leading-relaxed">{c.text}</span>
                              <div className="flex items-center gap-1.5 shrink-0 mt-0.5">
                                <SourceBadge source={c.source} />
                                <ConfidenceBar value={c.confidence} />
                              </div>
                            </div>
                          ))}
                          {cards.length > 8 && (
                            <p className="text-xs text-white/35 italic">+ {cards.length - 8} mais…</p>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </GlassCard>
      </motion.section>

      {/* Saúde estruturada */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <GlassCard className="p-5">
          <SectionHeader icon={Heart} title={`Condições (${conditions.length})`} />
          <div className="mt-3 space-y-1.5">
            {conditions.length === 0 ? (
              <p className="text-white/40 text-sm">Nenhuma registrada.</p>
            ) : conditions.map((c) => (
              <div key={c.id} className="flex items-center gap-2 py-1.5 border-b border-white/5 last:border-0">
                <span className="text-sm text-white flex-1">{c.name}</span>
                {c.severity && <span className="text-xs text-white/50">{c.severity}</span>}
                <SourceBadge source={c.source} />
              </div>
            ))}
          </div>
        </GlassCard>

        <GlassCard className="p-5">
          <SectionHeader icon={AlertTriangle} title={`Alergias (${allergies.length})`} />
          <div className="mt-3 space-y-1.5">
            {allergies.length === 0 ? (
              <p className="text-white/40 text-sm">Nenhuma registrada.</p>
            ) : allergies.map((a) => (
              <div key={a.id} className="flex items-start gap-2 py-1.5 border-b border-white/5 last:border-0">
                <div className="flex-1">
                  <span className="text-sm text-white">{a.substance}</span>
                  {a.reaction && <p className="text-xs text-white/45 mt-0.5">{a.reaction}</p>}
                </div>
                {a.severity && <span className="text-xs text-rose-300">{a.severity}</span>}
                <SourceBadge source={a.source} />
              </div>
            ))}
          </div>
        </GlassCard>

        <GlassCard className="p-5">
          <SectionHeader icon={Pill} title={`Medicamentos em uso (${medications.length})`} />
          <div className="mt-3 space-y-1.5">
            {medications.length === 0 ? (
              <p className="text-white/40 text-sm">Nenhum registrado.</p>
            ) : medications.map((m) => (
              <div key={m.id} className="py-1.5 border-b border-white/5 last:border-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm text-white flex-1">{m.medication_name}</span>
                  {m.dosage && <span className="text-xs text-white/50">{m.dosage}</span>}
                  <SourceBadge source={m.source} />
                </div>
                {m.frequency && <p className="text-xs text-white/40 mt-0.5">{m.frequency}</p>}
              </div>
            ))}
          </div>
        </GlassCard>

        <GlassCard className="p-5">
          <SectionHeader icon={MapPin} title={`Endereços (${addresses.length})`} />
          <div className="mt-3 space-y-1.5">
            {addresses.length === 0 ? (
              <p className="text-white/40 text-sm">Nenhum registrado.</p>
            ) : addresses.map((a) => (
              <div key={a.id} className="py-1.5 border-b border-white/5 last:border-0">
                <div className="flex items-center gap-2">
                  <span className="text-[10px] uppercase tracking-wider text-white/45 font-semibold">{a.label}</span>
                  {a.is_default && <GlassBadge tone="accent" size="xs">padrão</GlassBadge>}
                </div>
                <p className="text-sm text-white mt-0.5">
                  {[a.street, a.number, a.neighborhood, a.city, a.state, a.cep].filter(Boolean).join(', ')}
                </p>
              </div>
            ))}
          </div>
        </GlassCard>
      </div>

      {/* Lembretes */}
      <GlassCard className="p-5">
        <SectionHeader
          icon={Bell}
          title="Lembretes ativos"
          subtitle={`${remindersPending} pendentes · ${remindersSent} enviados`}
        />
        <div className="mt-3">
          {reminders.length === 0 ? (
            <p className="text-white/40 text-sm">Nenhum lembrete ativo.</p>
          ) : (
            <div className="space-y-1.5">
              {reminders.map((r) => (
                <div key={r.id} className="flex items-center gap-3 py-2 border-b border-white/5 last:border-0">
                  <span className="text-[10px] uppercase tracking-wider text-white/40 shrink-0 w-20 font-semibold">{r.type}</span>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-white truncate">{r.title}</p>
                    {r.body && <p className="text-xs text-white/45 truncate">{r.body}</p>}
                  </div>
                  {r.rrule && (
                    <span className="text-xs text-white/55 shrink-0 flex items-center gap-1">
                      <Calendar size={11} />
                      {formatRRule(r.rrule)}
                    </span>
                  )}
                  {r.next_run_at && (
                    <span className="text-xs text-white/40 shrink-0 flex items-center gap-1">
                      <Clock size={11} />
                      {timeAgo(r.next_run_at)}
                    </span>
                  )}
                  <GlassBadge
                    tone={r.status === 'pending' ? 'warn' : r.status === 'sent' ? 'info' : 'neutral'}
                    size="xs"
                  >
                    {r.status}
                  </GlassBadge>
                </div>
              ))}
            </div>
          )}
        </div>
      </GlassCard>

      {/* Pedidos */}
      <GlassCard className="p-5">
        <SectionHeader icon={FileText} title={`Últimos pedidos (${recentOrders.length})`} />
        <div className="mt-3">
          {recentOrders.length === 0 ? (
            <p className="text-white/40 text-sm">Nenhum pedido ainda.</p>
          ) : (
            <div className="space-y-1.5">
              {recentOrders.map((o) => (
                <div key={o.id} className="flex items-center gap-3 py-2 border-b border-white/5 last:border-0">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-white truncate">
                      {Array.isArray(o.items) ? o.items.map((i) => i.name).join(', ') : 'Itens'}
                    </p>
                  </div>
                  <GlassBadge tone={STATUS_TONE[o.status] ?? 'neutral'} size="xs">{o.status}</GlassBadge>
                  <div className="flex items-center gap-1 text-xs text-white/40 shrink-0">
                    <Clock size={11} />
                    {timeAgo(o.created_at)}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </GlassCard>
    </div>
  );
}
