'use client';
import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { timeAgo, formatTime } from '@/lib/utils';
import { Heart, AlertTriangle, Pill, MapPin, Clock, FileText } from 'lucide-react';

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
  created_at: string;
  updated_at: string;
}

interface HealthCondition {
  id: string;
  name: string;
  severity: string | null;
  active: boolean;
  created_at: string;
}

interface Allergy {
  id: string;
  substance: string;
  reaction: string | null;
  severity: string | null;
  created_at: string;
}

interface Medication {
  id: string;
  medication_name: string;
  dosage: string | null;
  frequency: string | null;
  active: boolean;
  created_at: string;
}

interface Address {
  id: string;
  label: string;
  street: string | null;
  city: string | null;
  state: string | null;
  is_default: boolean;
}

interface Order {
  id: string;
  status: string;
  items: Array<{ name: string }>;
  created_at: string;
}

const STATUS_COLORS: Record<string, string> = {
  drafting: 'text-gray-400',
  quoting: 'text-yellow-400',
  quoted: 'text-blue-400',
  handed_off: 'text-green-400',
  cancelled: 'text-red-400',
};

export default function UserProfilePage({ params }: { params: { id: string } }) {
  const { id } = params;
  const [user, setUser] = useState<User | null>(null);
  const [conditions, setConditions] = useState<HealthCondition[]>([]);
  const [allergies, setAllergies] = useState<Allergy[]>([]);
  const [medications, setMedications] = useState<Medication[]>([]);
  const [addresses, setAddresses] = useState<Address[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);

  useEffect(() => {
    Promise.all([
      supabase.from('users').select('*').eq('id', id).single(),
      supabase.from('user_health_conditions').select('*').eq('user_id', id).eq('active', true),
      supabase.from('user_allergies').select('*').eq('user_id', id),
      supabase.from('user_medications').select('*').eq('user_id', id).eq('active', true),
      supabase.from('user_addresses').select('*').eq('user_id', id),
      supabase.from('orders').select('id, status, items, created_at').eq('user_id', id).order('created_at', { ascending: false }).limit(10),
    ]).then(([u, cond, allg, meds, addr, ords]) => {
      setUser(u.data as User ?? null);
      setConditions((cond.data as HealthCondition[]) ?? []);
      setAllergies((allg.data as Allergy[]) ?? []);
      setMedications((meds.data as Medication[]) ?? []);
      setAddresses((addr.data as Address[]) ?? []);
      setOrders((ords.data as Order[]) ?? []);
    });
  }, [id]);

  if (!user) return <div className="p-6 text-gray-400">Carregando…</div>;

  const displayName = user.preferred_name ?? user.full_name ?? user.phone_e164;

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-start gap-4">
        <div className="w-16 h-16 rounded-full bg-brand-500 flex items-center justify-center text-white font-bold text-2xl shrink-0">
          {displayName.slice(0, 1).toUpperCase()}
        </div>
        <div className="flex-1">
          <h1 className="text-2xl font-bold text-white">{displayName}</h1>
          {user.full_name && user.preferred_name && (
            <p className="text-gray-400 text-sm">{user.full_name}</p>
          )}
          <p className="text-gray-500 text-sm">{user.phone_e164}</p>
          <div className="flex flex-wrap gap-2 mt-2">
            <span className={`text-xs px-2 py-0.5 rounded-full ${
              user.onboarding_status === 'active' ? 'bg-green-900/40 text-green-400' : 'bg-yellow-900/40 text-yellow-400'
            }`}>
              {user.onboarding_status}
            </span>
            {user.lgpd_consent_at && (
              <span className="text-xs px-2 py-0.5 rounded-full bg-blue-900/30 text-blue-400">
                LGPD ✓ {timeAgo(user.lgpd_consent_at)}
              </span>
            )}
            <span className="text-xs text-gray-500">Cliente desde {timeAgo(user.created_at)}</span>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Condições de saúde */}
        <section className="bg-wa-panel border border-wa-border rounded-xl p-4">
          <h2 className="flex items-center gap-2 text-white font-semibold mb-3">
            <Heart size={16} className="text-red-400" /> Condições ({conditions.length})
          </h2>
          {conditions.length === 0
            ? <p className="text-gray-500 text-sm">Nenhuma registrada.</p>
            : conditions.map((c) => (
              <div key={c.id} className="flex items-center justify-between py-1 border-b border-wa-border last:border-0">
                <span className="text-sm text-white">{c.name}</span>
                {c.severity && <span className="text-xs text-gray-400">{c.severity}</span>}
              </div>
            ))}
        </section>

        {/* Alergias */}
        <section className="bg-wa-panel border border-wa-border rounded-xl p-4">
          <h2 className="flex items-center gap-2 text-white font-semibold mb-3">
            <AlertTriangle size={16} className="text-yellow-400" /> Alergias ({allergies.length})
          </h2>
          {allergies.length === 0
            ? <p className="text-gray-500 text-sm">Nenhuma registrada.</p>
            : allergies.map((a) => (
              <div key={a.id} className="flex items-start justify-between py-1 border-b border-wa-border last:border-0">
                <div>
                  <span className="text-sm text-white">{a.substance}</span>
                  {a.reaction && <p className="text-xs text-gray-400">{a.reaction}</p>}
                </div>
                {a.severity && <span className="text-xs text-red-400">{a.severity}</span>}
              </div>
            ))}
        </section>

        {/* Medicamentos */}
        <section className="bg-wa-panel border border-wa-border rounded-xl p-4">
          <h2 className="flex items-center gap-2 text-white font-semibold mb-3">
            <Pill size={16} className="text-blue-400" /> Medicamentos em uso ({medications.length})
          </h2>
          {medications.length === 0
            ? <p className="text-gray-500 text-sm">Nenhum registrado.</p>
            : medications.map((m) => (
              <div key={m.id} className="py-1 border-b border-wa-border last:border-0">
                <div className="flex items-center justify-between">
                  <span className="text-sm text-white">{m.medication_name}</span>
                  {m.dosage && <span className="text-xs text-gray-400">{m.dosage}</span>}
                </div>
                {m.frequency && <p className="text-xs text-gray-500">{m.frequency}</p>}
              </div>
            ))}
        </section>

        {/* Endereços */}
        <section className="bg-wa-panel border border-wa-border rounded-xl p-4">
          <h2 className="flex items-center gap-2 text-white font-semibold mb-3">
            <MapPin size={16} className="text-green-400" /> Endereços ({addresses.length})
          </h2>
          {addresses.length === 0
            ? <p className="text-gray-500 text-sm">Nenhum registrado.</p>
            : addresses.map((a) => (
              <div key={a.id} className="py-1 border-b border-wa-border last:border-0">
                <div className="flex items-center gap-2">
                  <span className="text-xs text-gray-500 uppercase">{a.label}</span>
                  {a.is_default && <span className="text-[10px] text-brand-500">padrão</span>}
                </div>
                <p className="text-sm text-white">
                  {[a.street, a.city, a.state].filter(Boolean).join(', ')}
                </p>
              </div>
            ))}
        </section>
      </div>

      {/* Pedidos */}
      <section className="bg-wa-panel border border-wa-border rounded-xl p-4">
        <h2 className="flex items-center gap-2 text-white font-semibold mb-3">
          <FileText size={16} className="text-purple-400" /> Últimos pedidos ({orders.length})
        </h2>
        {orders.length === 0
          ? <p className="text-gray-500 text-sm">Nenhum pedido ainda.</p>
          : (
            <div className="space-y-2">
              {orders.map((o) => (
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
