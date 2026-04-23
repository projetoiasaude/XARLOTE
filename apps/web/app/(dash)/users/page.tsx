'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { supabase } from '@/lib/supabase';
import { timeAgo } from '@/lib/utils';

interface User {
  id: string;
  phone_e164: string;
  preferred_name: string | null;
  full_name: string | null;
  onboarding_status: string;
  lgpd_consent_at: string | null;
  created_at: string;
}

const ONBOARDING_STYLE: Record<string, string> = {
  not_started: 'text-gray-500 bg-gray-800',
  consent_pending: 'text-yellow-400 bg-yellow-900/30',
  profiling: 'text-blue-400 bg-blue-900/30',
  active: 'text-green-400 bg-green-900/30',
};

export default function UsersPage() {
  const [users, setUsers] = useState<User[]>([]);
  const [search, setSearch] = useState('');

  useEffect(() => {
    supabase
      .from('users')
      .select('id, phone_e164, preferred_name, full_name, onboarding_status, lgpd_consent_at, created_at')
      .order('created_at', { ascending: false })
      .limit(100)
      .then(({ data }) => setUsers((data as User[]) ?? []));
  }, []);

  const visible = users.filter(
    (u) =>
      !search ||
      (u.preferred_name ?? '').toLowerCase().includes(search.toLowerCase()) ||
      (u.full_name ?? '').toLowerCase().includes(search.toLowerCase()) ||
      u.phone_e164.includes(search)
  );

  const name = (u: User) => u.preferred_name ?? u.full_name ?? u.phone_e164;

  return (
    <div className="p-6">
      <h1 className="text-xl font-bold text-white mb-4">Usuários ({users.length})</h1>

      <input
        type="text"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Buscar por nome ou telefone…"
        className="w-full mb-4 px-3 py-2 bg-wa-panel border border-wa-border rounded-lg text-sm text-white placeholder-gray-500 outline-none focus:border-brand-500"
      />

      <div className="space-y-1">
        {visible.map((u) => (
          <Link
            key={u.id}
            href={`/users/${u.id}`}
            className="flex items-center gap-3 px-4 py-3 bg-wa-panel border border-wa-border rounded-xl hover:bg-wa-bubble_in/30 transition-colors"
          >
            <div className="w-10 h-10 rounded-full bg-brand-500 flex items-center justify-center text-white font-bold shrink-0">
              {name(u).slice(0, 1).toUpperCase()}
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-white text-sm font-medium">{name(u)}</p>
              <p className="text-gray-500 text-xs">{u.phone_e164}</p>
            </div>
            <div className="text-right shrink-0 space-y-1">
              <span className={`block text-xs px-2 py-0.5 rounded-full ${ONBOARDING_STYLE[u.onboarding_status] ?? 'text-gray-400'}`}>
                {u.onboarding_status}
              </span>
              <p className="text-xs text-gray-500">{timeAgo(u.created_at)}</p>
            </div>
          </Link>
        ))}
        {visible.length === 0 && (
          <p className="text-gray-500 text-sm">
            {search ? 'Nenhum resultado.' : 'Nenhum usuário ainda. Use o simulador para começar.'}
          </p>
        )}
      </div>
    </div>
  );
}
