'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { motion } from 'framer-motion';
import { ShoppingBag } from 'lucide-react';
import { timeAgo, adminGet } from '@/lib/utils';
import {
  GlassCard, GlassBadge, SectionHeader, EmptyState, type BadgeTone,
} from '@/components/ui';

interface Order {
  id: string;
  status: string;
  items: Array<{ name: string }>;
  created_at: string;
  users?: { preferred_name?: string; phone_e164?: string } | null;
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

export default function OrdersPage() {
  const [orders, setOrders] = useState<Order[]>([]);
  const [loaded, setLoaded] = useState(false);

  async function load() {
    try {
      const data = await adminGet<Order[]>('/admin/orders');
      setOrders(data ?? []);
    } catch {
      /* falha transitória — mantém o estado anterior */
    } finally {
      setLoaded(true);
    }
  }

  // Leitura via API (service role + token do login). Antes era Supabase anon
  // direto, que o RLS (is_staff) bloqueia. "Tempo real" via polling leve.
  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="space-y-6">
      <SectionHeader
        icon={ShoppingBag}
        title="Pedidos"
        subtitle="Cotações com farmácias em tempo real"
        size="lg"
        action={<GlassBadge tone="accent">{orders.length}</GlassBadge>}
      />

      {orders.length === 0 ? (
        <GlassCard className="p-2">
          <EmptyState
            icon={ShoppingBag}
            title="Nenhum pedido ainda"
            hint={loaded ? 'Peça um remédio pela Xarlote pra cotar farmácias.' : 'Carregando…'}
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
          {orders.map((o) => (
            <motion.div
              key={o.id}
              variants={{
                hidden: { opacity: 0, y: 6 },
                show: { opacity: 1, y: 0, transition: { type: 'spring' as const, stiffness: 320, damping: 26 } },
              }}
            >
              <Link href={`/orders/${o.id}`} className="block">
                <GlassCard variant="lo" interactive className="flex items-center gap-4 px-4 py-3">
                  <div className="flex-1 min-w-0">
                    <p className="text-white text-sm font-medium truncate">
                      {Array.isArray(o.items) ? o.items.map((i) => i.name).join(', ') : 'Itens'}
                    </p>
                    <p className="text-white/45 text-xs truncate">{o.users?.preferred_name ?? o.users?.phone_e164 ?? '—'}</p>
                  </div>
                  <GlassBadge tone={STATUS_TONE[o.status] ?? 'neutral'} size="xs">
                    {o.status}
                  </GlassBadge>
                  <span className="text-xs text-white/40 shrink-0 hidden md:inline">{timeAgo(o.created_at)}</span>
                </GlassCard>
              </Link>
            </motion.div>
          ))}
        </motion.div>
      )}
    </div>
  );
}
