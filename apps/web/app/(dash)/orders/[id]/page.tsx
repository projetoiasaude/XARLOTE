'use client';
import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { timeAgo } from '@/lib/utils';

interface Quote {
  id: string;
  status: string;
  total: number | null;
  delivery_fee: number | null;
  eta_minutes: number | null;
  payment_methods: string[] | null;
  pix_key: string | null;
  notes: string | null;
  distance_km: number | null;
  suppliers?: { name: string; whatsapp_e164?: string } | null;
}

interface Order {
  id: string;
  status: string;
  items: Array<{ name: string; dosage?: string }>;
  created_at: string;
  delivery_lat: number | null;
  delivery_lng: number | null;
}

const QUOTE_STATUS: Record<string, { label: string; color: string }> = {
  pending: { label: 'Aguardando', color: 'text-gray-400' },
  contacting: { label: 'Contatando', color: 'text-yellow-400' },
  negotiating: { label: 'Negociando', color: 'text-blue-400' },
  quoted: { label: 'Cotado ✓', color: 'text-green-400' },
  unavailable: { label: 'Sem estoque', color: 'text-orange-400' },
  timeout: { label: 'Timeout', color: 'text-red-400' },
};

export default function OrderDetailPage({ params }: { params: { id: string } }) {
  const { id } = params;
  const [order, setOrder] = useState<Order | null>(null);
  const [quotes, setQuotes] = useState<Quote[]>([]);

  async function load() {
    const { data: ord } = await supabase.from('orders').select('*').eq('id', id).single();
    const { data: qs } = await supabase.from('quotes').select('*, suppliers(name, whatsapp_e164)').eq('order_id', id);
    setOrder(ord as Order);
    setQuotes((qs as Quote[]) ?? []);
  }

  useEffect(() => { load(); }, [id]);

  useEffect(() => {
    const ch = supabase.channel(`order-${id}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'quotes', filter: `order_id=eq.${id}` }, load)
      .subscribe();
    return () => { ch.unsubscribe(); };
  }, [id]);

  if (!order) return <div className="p-6 text-gray-400">Carregando…</div>;

  return (
    <div className="p-6">
      <div className="mb-6">
        <h1 className="text-xl font-bold text-white mb-1">Pedido {id.slice(0, 8)}…</h1>
        <p className="text-gray-400 text-sm">{timeAgo(order.created_at)} · status: <span className="text-white">{order.status}</span></p>
        <div className="mt-2 flex flex-wrap gap-2">
          {order.items.map((item, i) => (
            <span key={i} className="bg-wa-bubble_in text-white text-xs px-2 py-1 rounded-full">
              {item.name}{item.dosage ? ` ${item.dosage}` : ''}
            </span>
          ))}
        </div>
        {order.delivery_lat && (
          <p className="text-xs text-gray-500 mt-2">📍 {order.delivery_lat.toFixed(4)}, {order.delivery_lng?.toFixed(4)}</p>
        )}
      </div>

      <h2 className="text-white font-semibold mb-3">Cotações ({quotes.length})</h2>
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
        {quotes.map((q) => {
          const st = QUOTE_STATUS[q.status] ?? { label: q.status, color: 'text-gray-400' };
          return (
            <div key={q.id} className="bg-wa-panel border border-wa-border rounded-xl p-4">
              <div className="flex items-center justify-between mb-2">
                <p className="text-white font-medium text-sm">{(q.suppliers as any)?.name ?? '—'}</p>
                <span className={`text-xs font-medium ${st.color}`}>{st.label}</span>
              </div>
              {q.distance_km && <p className="text-xs text-gray-500">📍 {q.distance_km.toFixed(1)} km</p>}
              {q.total !== null && (
                <div className="mt-2 space-y-0.5">
                  <p className="text-green-400 font-bold">R$ {q.total.toFixed(2)}</p>
                  {q.delivery_fee !== null && <p className="text-xs text-gray-400">Frete: R$ {q.delivery_fee.toFixed(2)}</p>}
                  {q.eta_minutes && <p className="text-xs text-gray-400">Entrega: ~{q.eta_minutes}min</p>}
                  {q.payment_methods && <p className="text-xs text-gray-400">{q.payment_methods.join(' / ')}</p>}
                  {q.pix_key && <p className="text-xs text-gray-400 truncate">Pix: {q.pix_key}</p>}
                </div>
              )}
              {q.notes && <p className="text-xs text-gray-500 mt-2 italic">"{q.notes}"</p>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
