'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { supabase } from '@/lib/supabase';
import { timeAgo } from '@/lib/utils';

interface Conv {
  id: string;
  whatsapp_jid: string;
  last_message_at: string | null;
  status: string;
  users?: { preferred_name?: string; full_name?: string; phone_e164?: string } | null;
}

export default function ConversationsPage() {
  const [convs, setConvs] = useState<Conv[]>([]);

  async function load() {
    const { data } = await supabase
      .from('conversations')
      .select('id, whatsapp_jid, last_message_at, status, users(preferred_name, full_name, phone_e164)')
      .eq('party_type', 'user')
      .order('last_message_at', { ascending: false, nullsFirst: false })
      .limit(50);
    setConvs((data as Conv[]) ?? []);
  }

  useEffect(() => { load(); }, []);

  useEffect(() => {
    const ch = supabase
      .channel('conv-list')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'conversations' }, load)
      .subscribe();
    return () => { ch.unsubscribe(); };
  }, []);

  const name = (c: Conv) => c.users?.preferred_name ?? c.users?.full_name ?? c.users?.phone_e164 ?? c.whatsapp_jid.split('@')[0];

  return (
    <div className="p-6">
      <h1 className="text-xl font-bold text-white mb-4">Conversas com usuários</h1>
      <div className="space-y-1">
        {convs.map((c) => (
          <Link key={c.id} href={`/conversations/${c.id}`}
            className="flex items-center gap-3 px-4 py-3 bg-wa-panel border border-wa-border rounded-xl hover:bg-wa-bubble_in/30 transition-colors"
          >
            <div className="w-10 h-10 rounded-full bg-brand-500 flex items-center justify-center text-white font-bold shrink-0">
              {name(c).slice(0, 1).toUpperCase()}
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-white text-sm font-medium">{name(c)}</p>
              <p className="text-gray-500 text-xs">{c.whatsapp_jid.split('@')[0]}</p>
            </div>
            <div className="text-right shrink-0">
              <span className={`text-xs px-2 py-0.5 rounded-full ${c.status === 'active' ? 'bg-green-900/50 text-green-400' : 'bg-gray-800 text-gray-500'}`}>
                {c.status}
              </span>
              {c.last_message_at && <p className="text-xs text-gray-500 mt-1">{timeAgo(c.last_message_at)}</p>}
            </div>
          </Link>
        ))}
        {convs.length === 0 && <p className="text-gray-500 text-sm">Nenhuma conversa ainda. Use o simulador para começar.</p>}
      </div>
    </div>
  );
}
