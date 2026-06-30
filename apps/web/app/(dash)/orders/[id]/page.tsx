'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { motion } from 'framer-motion';
import { MessageCircle, ArrowLeft, ShoppingBag, MapPin, Truck, Wallet, Timer } from 'lucide-react';
import { timeAgo, adminGet } from '@/lib/utils';
import { PharmacyChatDrawer } from '@/components/chat/PharmacyChatDrawer';
import {
  GlassCard, GlassBadge, GlassButton, SectionHeader, Avatar,
  type BadgeTone,
} from '@/components/ui';

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
  conversation_id: string | null;
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

const QUOTE_STATUS: Record<string, { label: string; tone: BadgeTone }> = {
  pending: { label: 'Aguardando', tone: 'neutral' },
  contacting: { label: 'Contatando', tone: 'warn' },
  negotiating: { label: 'Negociando', tone: 'info' },
  quoted: { label: 'Cotado', tone: 'success' },
  unavailable: { label: 'Sem estoque', tone: 'warn' },
  timeout: { label: 'Timeout', tone: 'danger' },
  refused: { label: 'Recusado', tone: 'danger' },
};

const ORDER_TONE: Record<string, BadgeTone> = {
  drafting: 'neutral',
  quoting: 'warn',
  quoted: 'info',
  confirming: 'info',
  handed_off: 'success',
  cancelled: 'danger',
  failed: 'danger',
};

export default function OrderDetailPage({ params }: { params: { id: string } }) {
  const { id } = params;
  const [order, setOrder] = useState<Order | null>(null);
  const [quotes, setQuotes] = useState<Quote[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [chatQuote, setChatQuote] = useState<Quote | null>(null);

  // Leitura via API (service role + token do login). Antes era Supabase anon
  // direto, que o RLS (is_staff) bloqueia. "Tempo real" via polling leve.
  async function load() {
    try {
      const data = await adminGet<{ order: Order | null; quotes: Quote[] }>(`/admin/orders/${id}`);
      setOrder(data.order ?? null);
      setQuotes(data.quotes ?? []);
    } catch {
      /* falha transitória — mantém o estado anterior */
    } finally {
      setLoaded(true);
    }
  }

  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  if (!order) {
    return (
      <p className="text-white/50 text-sm py-12 text-center">
        {loaded ? 'Pedido não encontrado.' : 'Carregando…'}
      </p>
    );
  }

  return (
    <div className="space-y-6">
      <Link
        href="/orders"
        className="inline-flex items-center gap-1.5 text-sm text-white/55 hover:text-white transition-colors"
      >
        <ArrowLeft size={14} />
        Pedidos
      </Link>

      {/* Header do pedido */}
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
      >
        <GlassCard className="p-6">
          <SectionHeader
            icon={ShoppingBag}
            title={`Pedido ${id.slice(0, 8)}…`}
            subtitle={timeAgo(order.created_at)}
            action={<GlassBadge tone={ORDER_TONE[order.status] ?? 'neutral'} dot>{order.status}</GlassBadge>}
          />
          <div className="mt-4 flex flex-wrap gap-2">
            {order.items.map((item, i) => (
              <GlassBadge key={i} tone="info">
                {item.name}{item.dosage ? ` · ${item.dosage}` : ''}
              </GlassBadge>
            ))}
          </div>
          {order.delivery_lat && (
            <div className="mt-4 flex items-center gap-1.5 text-xs text-white/45 font-mono">
              <MapPin size={12} className="text-emerald-300" />
              {order.delivery_lat.toFixed(4)}, {order.delivery_lng?.toFixed(4)}
            </div>
          )}
        </GlassCard>
      </motion.div>

      <SectionHeader
        title={`Cotações (${quotes.length})`}
        action={
          <GlassBadge tone="accent" dot={quotes.some((q) => ['contacting','negotiating'].includes(q.status))}>
            {quotes.filter((q) => q.status === 'quoted').length} concluídas
          </GlassBadge>
        }
      />

      <motion.div
        initial="hidden"
        animate="show"
        variants={{
          hidden: { opacity: 0 },
          show: { opacity: 1, transition: { staggerChildren: 0.05 } },
        }}
        className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4"
      >
        {quotes.map((q) => {
          const st = QUOTE_STATUS[q.status] ?? { label: q.status, tone: 'neutral' as BadgeTone };
          const supplierName = q.suppliers?.name ?? '—';
          return (
            <motion.div
              key={q.id}
              variants={{
                hidden: { opacity: 0, y: 8 },
                show: { opacity: 1, y: 0, transition: { type: 'spring' as const, stiffness: 320, damping: 26 } },
              }}
            >
              <GlassCard className="p-5 flex flex-col h-full">
                <div className="flex items-start gap-3 mb-3">
                  <Avatar name={supplierName} size="sm" />
                  <div className="min-w-0 flex-1">
                    <p className="text-white font-medium text-sm truncate">{supplierName}</p>
                    {q.distance_km != null && (
                      <p className="text-[11px] text-white/45 flex items-center gap-1 mt-0.5">
                        <MapPin size={10} />
                        {q.distance_km.toFixed(1)} km
                      </p>
                    )}
                  </div>
                  <GlassBadge tone={st.tone} size="xs">{st.label}</GlassBadge>
                </div>

                {q.total !== null && (
                  <div className="mt-1">
                    <div className="text-2xl font-bold text-white tabular-nums tracking-tight">
                      R$ {q.total.toFixed(2)}
                    </div>
                    <div className="mt-2 space-y-1 text-[11px] text-white/55">
                      {q.delivery_fee !== null && (
                        <div className="flex items-center gap-1.5">
                          <Truck size={11} />
                          Frete R$ {q.delivery_fee.toFixed(2)}
                        </div>
                      )}
                      {q.eta_minutes && (
                        <div className="flex items-center gap-1.5">
                          <Timer size={11} />
                          ~{q.eta_minutes}min
                        </div>
                      )}
                      {q.payment_methods && (
                        <div className="flex items-center gap-1.5">
                          <Wallet size={11} />
                          {q.payment_methods.join(' / ')}
                        </div>
                      )}
                      {q.pix_key && (
                        <div className="truncate font-mono text-white/40">Pix: {q.pix_key}</div>
                      )}
                    </div>
                  </div>
                )}

                {q.notes && (
                  <p className="text-xs text-white/45 italic mt-3 line-clamp-2">&ldquo;{q.notes}&rdquo;</p>
                )}

                <div className="mt-4 pt-3 border-t border-white/8">
                  <GlassButton
                    variant="secondary"
                    size="sm"
                    onClick={() => setChatQuote(q)}
                    disabled={!q.conversation_id}
                    className="w-full"
                  >
                    <MessageCircle size={14} />
                    Ver diálogo / responder
                  </GlassButton>
                </div>
              </GlassCard>
            </motion.div>
          );
        })}
      </motion.div>

      <PharmacyChatDrawer
        open={!!chatQuote}
        conversationId={chatQuote?.conversation_id ?? null}
        pharmacyName={chatQuote?.suppliers?.name ?? 'Farmácia'}
        onClose={() => setChatQuote(null)}
      />
    </div>
  );
}
