'use client';
import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { timeAgo } from '@/lib/utils';
import { MapPin, Phone, Star, Ban } from 'lucide-react';

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

const STATUS_STYLES: Record<string, string> = {
  active: 'bg-green-900/40 text-green-400',
  blacklisted: 'bg-red-900/40 text-red-400',
  inactive: 'bg-gray-800 text-gray-500',
};

export default function SuppliersPage() {
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [filter, setFilter] = useState<'all' | 'active' | 'blacklisted'>('all');
  const [search, setSearch] = useState('');

  useEffect(() => {
    supabase
      .from('suppliers')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(100)
      .then(({ data }) => setSuppliers((data as Supplier[]) ?? []));
  }, []);

  const visible = suppliers
    .filter((s) => filter === 'all' || s.status === filter)
    .filter((s) =>
      !search ||
      s.name.toLowerCase().includes(search.toLowerCase()) ||
      (s.city ?? '').toLowerCase().includes(search.toLowerCase())
    );

  return (
    <div className="p-6">
      <div className="flex items-center gap-3 mb-5">
        <h1 className="text-xl font-bold text-white">Farmácias / Fornecedores</h1>
        <div className="flex gap-1 ml-auto">
          {(['all', 'active', 'blacklisted'] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`px-3 py-1 rounded text-xs ${filter === f ? 'bg-wa-bubble_in text-white' : 'text-gray-500 hover:text-white'}`}
            >
              {f === 'all' ? 'Todos' : f === 'active' ? 'Ativos' : 'Bloqueados'}
            </button>
          ))}
        </div>
      </div>

      <input
        type="text"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Buscar por nome ou cidade…"
        className="w-full mb-4 px-3 py-2 bg-wa-panel border border-wa-border rounded-lg text-sm text-white placeholder-gray-500 outline-none focus:border-brand-500"
      />

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
        {visible.map((s) => (
          <div key={s.id} className="bg-wa-panel border border-wa-border rounded-xl p-4 space-y-2">
            <div className="flex items-start justify-between gap-2">
              <p className="text-white font-semibold text-sm leading-tight">{s.name}</p>
              <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium shrink-0 ${STATUS_STYLES[s.status] ?? 'text-gray-400'}`}>
                {s.status}
              </span>
            </div>

            {s.address && (
              <div className="flex items-start gap-1.5 text-xs text-gray-400">
                <MapPin size={12} className="mt-0.5 shrink-0 text-gray-500" />
                <span>{s.address}{s.city ? `, ${s.city}` : ''}{s.state ? `/${s.state}` : ''}</span>
              </div>
            )}

            <div className="flex items-center gap-3 text-xs">
              {s.phone_e164 && (
                <span className="flex items-center gap-1 text-gray-400">
                  <Phone size={11} /> {s.phone_e164}
                </span>
              )}
              {s.whatsapp_verified_at ? (
                <span className="text-green-400 font-medium">WhatsApp ✓</span>
              ) : (
                <span className="text-gray-600">WhatsApp —</span>
              )}
            </div>

            {s.rating !== null && (
              <div className="flex items-center gap-1 text-xs text-yellow-400">
                <Star size={11} fill="currentColor" />
                <span>{s.rating.toFixed(1)}</span>
                {s.reviews && <span className="text-gray-500">({s.reviews} avaliações)</span>}
              </div>
            )}

            {s.tags && s.tags.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {s.tags.map((tag) => (
                  <span key={tag} className="text-[10px] bg-wa-bg text-gray-400 px-1.5 py-0.5 rounded">{tag}</span>
                ))}
              </div>
            )}

            {s.blacklist_reason && (
              <div className="flex items-start gap-1.5 text-xs text-red-400">
                <Ban size={11} className="mt-0.5 shrink-0" />
                <span>{s.blacklist_reason}</span>
              </div>
            )}

            <div className="flex items-center justify-between text-[10px] text-gray-600 pt-1 border-t border-wa-border">
              <span>{s.source}</span>
              {s.last_contacted_at
                ? <span>Último contato: {timeAgo(s.last_contacted_at)}</span>
                : <span>Nunca contatado</span>}
            </div>
          </div>
        ))}
        {visible.length === 0 && (
          <p className="text-gray-500 text-sm col-span-full">
            {search ? 'Nenhum resultado.' : 'Nenhuma farmácia cadastrada ainda.'}
          </p>
        )}
      </div>
    </div>
  );
}
