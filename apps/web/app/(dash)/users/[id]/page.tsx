'use client';
import { useEffect, useState } from 'react';
import { timeAgo } from '@/lib/utils';
import {
  Heart, AlertTriangle, Pill, MapPin, Clock, FileText, Brain, Bell,
  Sparkles, User as UserIcon, Quote, Calendar, Smile,
} from 'lucide-react';

const API = process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001';

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

interface HealthCondition {
  id: string; name: string; severity: string | null; active: boolean;
  source?: string; created_at: string;
}
interface Allergy {
  id: string; substance: string; reaction: string | null; severity: string | null;
  source?: string; created_at: string;
}
interface Medication {
  id: string; medication_name: string; dosage: string | null; frequency: string | null;
  active: boolean; source?: string; created_at: string;
}
interface Address {
  id: string; label: string; street: string | null; number?: string | null;
  neighborhood?: string | null; city: string | null; state: string | null;
  cep?: string | null; is_default: boolean;
}
interface Order {
  id: string; status: string; items: Array<{ name: string }>; created_at: string;
}
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

const STATUS_COLORS: Record<string, string> = {
  drafting: 'text-gray-400',
  quoting: 'text-yellow-400',
  quoted: 'text-blue-400',
  handed_off: 'text-green-400',
  cancelled: 'text-red-400',
  failed: 'text-red-400',
};

const KIND_META: Record<MemoryCard['kind'], { label: string; icon: typeof Brain; color: string; bg: string }> = {
  fact: { label: 'Fato durável', icon: Sparkles, color: 'text-purple-300', bg: 'bg-purple-500/10 border-purple-500/30' },
  affect: { label: 'Afetivo', icon: Smile, color: 'text-pink-300', bg: 'bg-pink-500/10 border-pink-500/30' },
  preference: { label: 'Preferência', icon: UserIcon, color: 'text-cyan-300', bg: 'bg-cyan-500/10 border-cyan-500/30' },
  episode: { label: 'Evento recente', icon: Quote, color: 'text-amber-300', bg: 'bg-amber-500/10 border-amber-500/30' },
};

function SourceBadge({ source }: { source?: string }) {
  if (!source) return null;
  const isInferred = source === 'inferred';
  return (
    <span
      className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${
        isInferred ? 'bg-cyan-500/15 text-cyan-300' : 'bg-emerald-500/15 text-emerald-300'
      }`}
      title={isInferred ? 'Extraído automaticamente da conversa pela Xarlote' : 'Informado diretamente pelo usuário'}
    >
      {isInferred ? 'auto' : 'usuário'}
    </span>
  );
}

function ConfidenceBar({ value }: { value: number }) {
  const pct = Math.max(0, Math.min(1, value)) * 100;
  const color = pct >= 80 ? 'bg-green-400' : pct >= 60 ? 'bg-yellow-400' : 'bg-orange-400';
  return (
    <div className="flex items-center gap-1.5" title={`Confidence: ${pct.toFixed(0)}%`}>
      <div className="h-1 w-12 bg-gray-800 rounded overflow-hidden">
        <div className={`h-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-[10px] text-gray-500 tabular-nums">{pct.toFixed(0)}</span>
    </div>
  );
}

function formatRRule(rrule: string | null): string {
  if (!rrule) return '';
  // Simplifica: FREQ=DAILY → "diário", FREQ=WEEKLY → "semanal", etc.
  const m = rrule.match(/FREQ=([A-Z]+)/);
  if (!m) return rrule;
  const map: Record<string, string> = {
    DAILY: 'diário', WEEKLY: 'semanal', MONTHLY: 'mensal', YEARLY: 'anual', HOURLY: 'a cada hora',
  };
  return map[m[1]!] ?? rrule;
}

export default function UserProfilePage({ params }: { params: { id: string } }) {
  const { id } = params;
  const [data, setData] = useState<ProfileData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`${API}/admin/users/${id}`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((d: ProfileData) => {
        if (!cancelled) setData(d);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    return () => { cancelled = true; };
  }, [id]);

  if (error) return <div className="p-6 text-red-400">Erro ao carregar perfil: {error}</div>;
  if (!data) return <div className="p-6 text-gray-400">Carregando…</div>;

  const { user, conditions, allergies, medications, addresses, recentOrders, memoryCards, reminders } = data;

  const displayName = user.preferred_name ?? user.full_name ?? user.phone_e164;
  const cardsByKind = (kind: MemoryCard['kind']) => memoryCards.filter((c) => c.kind === kind);

  // Métrica simples de adesão: dose recente confirmada vs enviada (placeholder
  // até ter o cálculo real — por enquanto só mostra contagem)
  const remindersPending = reminders.filter((r) => r.status === 'pending').length;
  const remindersSent = reminders.filter((r) => r.status === 'sent').length;

  return (
    <div className="p-6 space-y-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex items-start gap-4">
        <div className="w-16 h-16 rounded-full bg-brand-500 flex items-center justify-center text-white font-bold text-2xl shrink-0">
          {displayName.slice(0, 1).toUpperCase()}
        </div>
        <div className="flex-1 min-w-0">
          <h1 className="text-2xl font-bold text-white">{displayName}</h1>
          {user.full_name && user.preferred_name && user.full_name !== user.preferred_name && (
            <p className="text-gray-400 text-sm">{user.full_name}</p>
          )}
          <p className="text-gray-500 text-sm font-mono">{user.phone_e164}</p>
          <div className="flex flex-wrap gap-2 mt-2">
            <span className={`text-xs px-2 py-0.5 rounded-full ${
              user.onboarding_status === 'active' ? 'bg-green-900/40 text-green-400' :
              user.onboarding_status === 'profiling' ? 'bg-blue-900/40 text-blue-400' :
              user.onboarding_status === 'consent_pending' ? 'bg-yellow-900/40 text-yellow-400' :
              'bg-gray-800 text-gray-400'
            }`}>
              {user.onboarding_status}
            </span>
            {user.lgpd_consent_at && (
              <span className="text-xs px-2 py-0.5 rounded-full bg-blue-900/30 text-blue-400">
                LGPD ✓ {timeAgo(user.lgpd_consent_at)}
              </span>
            )}
            {user.birth_date && (
              <span className="text-xs px-2 py-0.5 rounded-full bg-gray-800 text-gray-400">
                {new Date(user.birth_date).toLocaleDateString('pt-BR')}
              </span>
            )}
            <span className="text-xs text-gray-500">Cliente desde {timeAgo(user.created_at)}</span>
          </div>
        </div>

        {/* Stats */}
        <div className="hidden md:grid grid-cols-3 gap-2 text-center shrink-0">
          <div className="bg-wa-panel border border-wa-border rounded-lg p-2 min-w-[80px]">
            <div className="text-xs text-gray-400">Memória</div>
            <div className="text-lg font-bold text-white">{memoryCards.length}</div>
          </div>
          <div className="bg-wa-panel border border-wa-border rounded-lg p-2 min-w-[80px]">
            <div className="text-xs text-gray-400">Lembretes</div>
            <div className="text-lg font-bold text-white">{remindersPending}</div>
          </div>
          <div className="bg-wa-panel border border-wa-border rounded-lg p-2 min-w-[80px]">
            <div className="text-xs text-gray-400">Pedidos</div>
            <div className="text-lg font-bold text-white">{recentOrders.length}</div>
          </div>
        </div>
      </div>

      {/* MEMÓRIA — destaque maior, é o que humaniza a Xarlote */}
      <section className="bg-gradient-to-br from-purple-950/30 to-wa-panel border border-purple-500/20 rounded-xl p-5">
        <div className="flex items-center justify-between mb-3">
          <h2 className="flex items-center gap-2 text-white font-semibold text-base">
            <Brain size={18} className="text-purple-400" />
            Memória da Xarlote sobre {displayName.split(' ')[0]} ({memoryCards.length})
          </h2>
          <span className="text-xs text-gray-500">o que ela aprendeu nas conversas</span>
        </div>

        {memoryCards.length === 0 ? (
          <p className="text-gray-500 text-sm py-4 text-center">
            Ainda não há memória registrada — conforme o usuário conversar, a Xarlote vai aprendendo.
          </p>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {(['fact', 'affect', 'preference', 'episode'] as const).map((kind) => {
              const cards = cardsByKind(kind);
              if (cards.length === 0) return null;
              const meta = KIND_META[kind];
              const Icon = meta.icon;
              return (
                <div key={kind} className={`rounded-lg border p-3 ${meta.bg}`}>
                  <div className={`flex items-center gap-2 text-xs font-medium mb-2 ${meta.color}`}>
                    <Icon size={13} />
                    {meta.label} ({cards.length})
                  </div>
                  <div className="space-y-1.5">
                    {cards.slice(0, 8).map((c) => (
                      <div key={c.id} className="flex items-start gap-2 text-sm">
                        <span className="text-gray-300 flex-1">{c.text}</span>
                        <div className="flex items-center gap-1.5 shrink-0">
                          <SourceBadge source={c.source} />
                          <ConfidenceBar value={c.confidence} />
                        </div>
                      </div>
                    ))}
                    {cards.length > 8 && (
                      <p className="text-xs text-gray-500 italic">+ {cards.length - 8} mais…</p>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* Saúde estruturada */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <section className="bg-wa-panel border border-wa-border rounded-xl p-4">
          <h2 className="flex items-center gap-2 text-white font-semibold mb-3">
            <Heart size={16} className="text-red-400" /> Condições ({conditions.length})
          </h2>
          {conditions.length === 0 ? (
            <p className="text-gray-500 text-sm">Nenhuma registrada.</p>
          ) : conditions.map((c) => (
            <div key={c.id} className="flex items-center gap-2 py-1.5 border-b border-wa-border last:border-0">
              <span className="text-sm text-white flex-1">{c.name}</span>
              {c.severity && <span className="text-xs text-gray-400">{c.severity}</span>}
              <SourceBadge source={c.source} />
            </div>
          ))}
        </section>

        <section className="bg-wa-panel border border-wa-border rounded-xl p-4">
          <h2 className="flex items-center gap-2 text-white font-semibold mb-3">
            <AlertTriangle size={16} className="text-yellow-400" /> Alergias ({allergies.length})
          </h2>
          {allergies.length === 0 ? (
            <p className="text-gray-500 text-sm">Nenhuma registrada.</p>
          ) : allergies.map((a) => (
            <div key={a.id} className="flex items-start gap-2 py-1.5 border-b border-wa-border last:border-0">
              <div className="flex-1">
                <span className="text-sm text-white">{a.substance}</span>
                {a.reaction && <p className="text-xs text-gray-400">{a.reaction}</p>}
              </div>
              {a.severity && <span className="text-xs text-red-400">{a.severity}</span>}
              <SourceBadge source={a.source} />
            </div>
          ))}
        </section>

        <section className="bg-wa-panel border border-wa-border rounded-xl p-4">
          <h2 className="flex items-center gap-2 text-white font-semibold mb-3">
            <Pill size={16} className="text-blue-400" /> Medicamentos em uso ({medications.length})
          </h2>
          {medications.length === 0 ? (
            <p className="text-gray-500 text-sm">Nenhum registrado.</p>
          ) : medications.map((m) => (
            <div key={m.id} className="py-1.5 border-b border-wa-border last:border-0">
              <div className="flex items-center gap-2">
                <span className="text-sm text-white flex-1">{m.medication_name}</span>
                {m.dosage && <span className="text-xs text-gray-400">{m.dosage}</span>}
                <SourceBadge source={m.source} />
              </div>
              {m.frequency && <p className="text-xs text-gray-500 mt-0.5">{m.frequency}</p>}
            </div>
          ))}
        </section>

        <section className="bg-wa-panel border border-wa-border rounded-xl p-4">
          <h2 className="flex items-center gap-2 text-white font-semibold mb-3">
            <MapPin size={16} className="text-green-400" /> Endereços ({addresses.length})
          </h2>
          {addresses.length === 0 ? (
            <p className="text-gray-500 text-sm">Nenhum registrado.</p>
          ) : addresses.map((a) => (
            <div key={a.id} className="py-1.5 border-b border-wa-border last:border-0">
              <div className="flex items-center gap-2">
                <span className="text-xs text-gray-500 uppercase">{a.label}</span>
                {a.is_default && <span className="text-[10px] text-brand-500">padrão</span>}
              </div>
              <p className="text-sm text-white">
                {[a.street, a.number, a.neighborhood, a.city, a.state, a.cep].filter(Boolean).join(', ')}
              </p>
            </div>
          ))}
        </section>
      </div>

      {/* Lembretes ativos */}
      <section className="bg-wa-panel border border-wa-border rounded-xl p-4">
        <h2 className="flex items-center gap-2 text-white font-semibold mb-3">
          <Bell size={16} className="text-orange-400" /> Lembretes ativos ({remindersPending} pendentes, {remindersSent} enviados)
        </h2>
        {reminders.length === 0 ? (
          <p className="text-gray-500 text-sm">Nenhum lembrete ativo.</p>
        ) : (
          <div className="space-y-2">
            {reminders.map((r) => (
              <div key={r.id} className="flex items-center gap-3 py-2 border-b border-wa-border last:border-0">
                <span className="text-xs uppercase text-gray-500 shrink-0 w-20">{r.type}</span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-white truncate">{r.title}</p>
                  {r.body && <p className="text-xs text-gray-500 truncate">{r.body}</p>}
                </div>
                {r.rrule && (
                  <span className="text-xs text-gray-400 shrink-0 flex items-center gap-1">
                    <Calendar size={11} />
                    {formatRRule(r.rrule)}
                  </span>
                )}
                {r.next_run_at && (
                  <span className="text-xs text-gray-500 shrink-0 flex items-center gap-1">
                    <Clock size={11} />
                    {timeAgo(r.next_run_at)}
                  </span>
                )}
                <span className={`text-xs shrink-0 ${
                  r.status === 'pending' ? 'text-yellow-400' :
                  r.status === 'sent' ? 'text-blue-400' :
                  r.status === 'snoozed' ? 'text-gray-400' : 'text-gray-500'
                }`}>{r.status}</span>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Pedidos */}
      <section className="bg-wa-panel border border-wa-border rounded-xl p-4">
        <h2 className="flex items-center gap-2 text-white font-semibold mb-3">
          <FileText size={16} className="text-purple-400" /> Últimos pedidos ({recentOrders.length})
        </h2>
        {recentOrders.length === 0 ? (
          <p className="text-gray-500 text-sm">Nenhum pedido ainda.</p>
        ) : (
          <div className="space-y-2">
            {recentOrders.map((o) => (
              <div key={o.id} className="flex items-center gap-3 py-2 border-b border-wa-border last:border-0">
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-white truncate">
                    {Array.isArray(o.items) ? o.items.map((i) => i.name).join(', ') : 'Itens'}
                  </p>
                </div>
                <span className={`text-xs shrink-0 ${STATUS_COLORS[o.status] ?? 'text-gray-400'}`}>{o.status}</span>
                <div className="flex items-center gap-1 text-xs text-gray-500 shrink-0">
                  <Clock size={11} />
                  {timeAgo(o.created_at)}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
