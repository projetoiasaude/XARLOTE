'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { supabase } from '@/lib/supabase';
import { timeAgo } from '@/lib/utils';

interface Order {
  id: string;
  status: string;
  items: Array<{ name: string }>;
  created_at: string;
  users?: { preferred_name?: string; phone_e164?: string } | null;
}

const STATUS_COLORS: Record<string, string> = {
  drafting: 'text-gray-400 bg-gray-800',
  quoting: 'text-yellow-400 bg-yellow-900/30',
  quoted: 'text-blue-400 bg-blue-900/30',
  handed_off: 'text-green-400 bg-green-900/30',
  cancelled: 'text-red-400 bg-red-900/30',
};

export default function OrdersPage() {
  const [orders, setOrders] = useState<Order[]>([]);

  async function load() {
    const { data } = await supabase
      .from('orders')
      .select('id, status, items, created_at, users(preferred_name, phone_e164)')
      .order('created_at', { ascending: false })
      .limit(50);
    setOrders((data as Order[]) ?? []);
  }

  useEffect(() => { load(); }, []);

  useEffect(() => {
    const ch = supabase.channel('orders-list')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'orders' }, load)
      .subscribe();
    return () => { ch.unsubscribe(); };
  }, []);

  return (
    <div className="p-6">
      <h1 className="text-xl font-bold text-white mb-4">Pedidos de medicamentos</h1>
      <div className="space-y-2">
        {orders.map((o) => (
          <Link key={o.id} href={`/orders/${o.id}`}
            className="flex items-center gap-4 px-4 py-3 bg-wa-panel border border-wa-border rounded-xl hover:bg-wa-bubble_in/30 transition-colors"
          >
            <div className="flex-1 min-w-0">
              <p className="text-white text-sm font-medium truncate">
                {Array.isArray(o.items) ? o.items.map((i) => i.name).join(', ') : 'Itens'}
              </p>
              <p className="text-gray-500 text-xs">{o.users?.preferred_name ?? o.users?.phone_e164 ?? '—'}</p>
            </div>
            <span className={`text-xs px-2 py-1 rounded-full font-medium ${STATUS_COLORS[o.status] ?? 'text-gray-400'}`}>
              {o.status}
            </span>
            <p className="text-xs text-gray-500 shrink-0">{timeAgo(o.created_at)}</p>
          </Link>
        ))}
        {orders.length === 0 && <p className="text-gray-500 text-sm">Nenhum pedido ainda.</p>}
      </div>
    </div>
  );
}
