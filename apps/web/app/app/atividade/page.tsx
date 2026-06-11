'use client';
import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AnimatePresence, motion } from 'framer-motion';
import { Bike, ChevronDown, Crown, MapPin, ShoppingBag, Star, Stethoscope, Zap } from 'lucide-react';
import { GlassBadge, GlassButton, Skeleton, StatusPing } from '@/components/ui';
import { Screen, screenItem } from '@/components/xarlote/Screen';
import { LiquidStepper } from '@/components/xarlote/bits';
import { XarloteLogo } from '@/components/xarlote/XarloteLogo';
import { useXarloteApp } from '@/lib/xarlote/app-context';
import { brl, fullDateTime } from '@/lib/xarlote/format';
import { supabase } from '@/lib/supabase';
import { cn, timeAgo } from '@/lib/utils';
import type { XarOrder, XarQuote } from '@/lib/xarlote/types';

const ORDER_STEPS = ['Pedido', 'Cotando', 'Opções', 'Confirmado', 'Entrega'];
const STEP_INDEX: Record<string, number> = {
  drafting: 0,
  quoting: 1,
  quoted: 2,
  confirming: 3,
  handed_off: 4,
  completed: 4,
};
const ACTIVE_ORDER = ['drafting', 'quoting', 'quoted', 'confirming', 'handed_off'];

const QUOTE_LABEL: Record<string, string> = {
  pending: 'na fila',
  contacting: 'contatada',
  negotiating: 'negociando',
  quoted: 'respondeu',
  unavailable: 'indisponível',
  timeout: 'sem resposta',
  refused: 'recusou',
};
const QUOTE_RANK: Record<string, number> = {
  quoted: 0,
  negotiating: 1,
  contacting: 2,
  pending: 3,
  unavailable: 4,
  timeout: 5,
  refused: 6,
};

function quoteTone(s: string): 'success' | 'accent' | 'neutral' | 'danger' {
  if (s === 'quoted') return 'success';
  if (s === 'negotiating') return 'accent';
  if (['unavailable', 'timeout', 'refused'].includes(s)) return 'danger';
  return 'neutral';
}

function OrderCard({ order, onChoose }: { order: XarOrder; onChoose: (q: XarQuote) => void }) {
  const step = STEP_INDEX[order.status] ?? 0;
  const itemNames = (order.items ?? []).map((i) => i.name).filter(Boolean).join(', ') || 'Medicamento';
  const contacted = order.quotes.length;
  const responded = order.quotes.filter((q) => q.status === 'quoted').length;
  const sorted = [...order.quotes].sort((a, b) => {
    const r = (QUOTE_RANK[a.status] ?? 9) - (QUOTE_RANK[b.status] ?? 9);
    if (r !== 0) return r;
    return (a.total ?? Infinity) - (b.total ?? Infinity);
  });
  const best = sorted.find((q) => q.status === 'quoted' && q.total != null);
  const canChoose = ['quoting', 'quoted', 'confirming'].includes(order.status);
  const delivering = order.status === 'handed_off' || order.status === 'completed';

  return (
    <motion.div variants={screenItem} className="glass glass-spec overflow-hidden rounded-3xl p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="flex items-center gap-2 text-sm font-semibold">
            <ShoppingBag size={15} className="shrink-0 text-accent-hi" />
            <span className="truncate">{itemNames}</span>
          </p>
          <p className="mt-0.5 text-[11px] text-white/40">
            {timeAgo(order.created_at)}
            {order.delivery_address && (
              <span className="ml-1.5 inline-flex items-center gap-0.5">
                <MapPin size={9} /> {order.delivery_address.slice(0, 42)}
              </span>
            )}
          </p>
        </div>
        {delivering && (
          <GlassBadge tone="success" size="xs" dot>
            <Bike size={11} className="mr-0.5" /> a caminho
          </GlassBadge>
        )}
      </div>

      <div className="mt-4">
        <LiquidStepper steps={ORDER_STEPS} active={step} />
      </div>

      {order.status === 'quoting' && (
        <p className="mt-3 text-center text-xs text-white/55">
          <span className="font-semibold text-white">{contacted}</span> farmácias contatadas ·{' '}
          <span className="font-semibold text-accent-hi">{responded}</span> já responderam
        </p>
      )}

      {sorted.length > 0 && (
        <div className="mt-3 space-y-2">
          <AnimatePresence initial={false}>
            {sorted.map((q) => {
              const isBest = best?.id === q.id;
              const isSelected = order.selected_quote_id === q.id;
              return (
                <motion.div
                  key={q.id}
                  layout
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ type: 'spring', stiffness: 320, damping: 28 }}
                  className={cn(
                    'rounded-2xl border p-3',
                    isSelected
                      ? 'border-emerald-400/50 bg-emerald-400/10'
                      : isBest
                        ? 'border-accent/45 bg-accent/10 shadow-glow-accent'
                        : 'border-white/8 bg-white/[0.03]',
                  )}
                >
                  <div className="flex items-center gap-2.5">
                    <StatusPing tone={quoteTone(q.status)} size="sm" pulse={q.status === 'negotiating'} />
                    <div className="min-w-0 flex-1">
                      <p className="flex items-center gap-1.5 truncate text-[13px] font-medium">
                        {(isBest || isSelected) && <Crown size={12} className={isSelected ? 'text-emerald-300' : 'text-amber-300'} />}
                        {q.suppliers?.name ?? 'Farmácia'}
                      </p>
                      <p className="text-[10px] text-white/40">
                        {QUOTE_LABEL[q.status] ?? q.status}
                        {q.distance_km != null && ` · ${q.distance_km.toFixed(1)} km`}
                        {q.eta_minutes != null && ` · ~${q.eta_minutes}min`}
                        {q.delivery_fee != null && q.delivery_fee > 0 && ` · frete ${brl(q.delivery_fee)}`}
                      </p>
                    </div>
                    {q.total != null && (
                      <p className="shrink-0 text-base font-bold tabular-nums text-white">{brl(q.total)}</p>
                    )}
                  </div>
                  {canChoose && q.status === 'quoted' && q.total != null && !isSelected && (
                    <GlassButton size="xs" variant={isBest ? 'primary' : 'secondary'} className="mt-2 w-full" onClick={() => onChoose(q)}>
                      Escolher esta
                    </GlassButton>
                  )}
                </motion.div>
              );
            })}
          </AnimatePresence>
        </div>
      )}
    </motion.div>
  );
}

export default function AtividadePage() {
  const router = useRouter();
  const { overview, overviewLoading } = useXarloteApp();
  const [orders, setOrders] = useState<XarOrder[]>([]);
  const [showPast, setShowPast] = useState(false);

  useEffect(() => {
    if (overview) setOrders(overview.orders);
  }, [overview]);

  const activeOrders = useMemo(() => orders.filter((o) => ACTIVE_ORDER.includes(o.status)), [orders]);
  const pastOrders = useMemo(() => orders.filter((o) => !ACTIVE_ORDER.includes(o.status)), [orders]);
  const consultations = overview?.consultations ?? [];
  const activeConsults = consultations.filter((c) => !['completed', 'cancelled'].includes(c.status));

  // Realtime: cotações dos pedidos ativos pulsam ao vivo
  useEffect(() => {
    if (activeOrders.length === 0) return;
    const channels = activeOrders.map((o) =>
      supabase
        .channel(`xar-app-quotes-${o.id}`)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'quotes', filter: `order_id=eq.${o.id}` }, (payload) => {
          const q = payload.new as XarQuote & { order_id: string };
          if (!q?.id) return;
          setOrders((prev) =>
            prev.map((ord) => {
              if (ord.id !== q.order_id) return ord;
              const exists = ord.quotes.some((x) => x.id === q.id);
              return {
                ...ord,
                quotes: exists
                  ? ord.quotes.map((x) => (x.id === q.id ? { ...x, ...q } : x))
                  : [...ord.quotes, { ...q, suppliers: null }],
              };
            }),
          );
        })
        .subscribe(),
    );
    return () => {
      channels.forEach((ch) => void ch.unsubscribe());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeOrders.map((o) => o.id).join(',')]);

  function choose(order: XarOrder, q: XarQuote) {
    const name = q.suppliers?.name ?? 'essa farmácia';
    const draft = `Quero a da ${name}${q.total != null ? ` por ${brl(q.total)}` : ''}. Pode confirmar?`;
    router.push(`/app?draft=${encodeURIComponent(draft)}`);
  }

  const loading = overviewLoading && !overview;
  const nothing = activeOrders.length === 0 && activeConsults.length === 0;

  return (
    <Screen title="Atividade" subtitle="a Xarlote agindo no mundo real por você">
      {loading ? (
        <div className="space-y-3">
          <Skeleton variant="card" className="h-44" />
          <Skeleton variant="card" className="h-28" />
        </div>
      ) : nothing ? (
        <motion.div variants={screenItem} className="glass flex flex-col items-center rounded-3xl p-8 text-center">
          <XarloteLogo size={150} />
          <p className="mt-3 text-sm font-medium">Nada em andamento agora</p>
          <p className="mt-1 max-w-[290px] text-xs text-white/50">
            Peça um remédio ou uma consulta — a Xarlote contata as farmácias e clínicas por você e o progresso aparece
            aqui, ao vivo.
          </p>
          <div className="mt-4 flex gap-2">
            <GlassButton
              variant="primary"
              size="sm"
              onClick={() => router.push('/app?draft=' + encodeURIComponent('Preciso comprar um remédio: '))}
            >
              <ShoppingBag size={13} /> Pedir remédio
            </GlassButton>
            <GlassButton
              variant="secondary"
              size="sm"
              onClick={() => router.push('/app?draft=' + encodeURIComponent('Quero marcar uma consulta com '))}
            >
              <Stethoscope size={13} /> Marcar consulta
            </GlassButton>
          </div>
        </motion.div>
      ) : (
        <div className="space-y-4">
          {activeOrders.map((o) => (
            <OrderCard key={o.id} order={o} onChoose={(q) => choose(o, q)} />
          ))}

          {activeConsults.map((c) => (
            <motion.div key={c.id} variants={screenItem} className="glass glass-spec rounded-3xl p-4">
              <p className="flex items-center gap-2 text-sm font-semibold">
                <Stethoscope size={15} className="text-aurora-purple" />
                Consulta{c.specialty ? ` · ${c.specialty}` : ''}
              </p>
              <p className="mt-0.5 text-[11px] text-white/40">
                {[c.modality, c.urgency && `urgência: ${c.urgency}`, c.city].filter(Boolean).join(' · ')}
              </p>
              <div className="mt-2.5 flex items-center gap-2">
                <GlassBadge tone={c.status === 'scheduled' ? 'success' : 'accent'} size="xs" dot>
                  {c.status === 'searching'
                    ? 'procurando clínicas'
                    : c.status === 'quoting'
                      ? 'negociando horários'
                      : c.status === 'quoted'
                        ? 'opções prontas'
                        : c.status === 'scheduled'
                          ? 'agendada'
                          : c.status}
                </GlassBadge>
                {c.scheduled_at && <span className="text-[11px] text-white/55">{fullDateTime(c.scheduled_at)}</span>}
              </div>
              {c.consultation_quotes.length > 0 && (
                <div className="mt-3 space-y-1.5">
                  {c.consultation_quotes.map((q) => (
                    <div key={q.id} className="flex items-center justify-between rounded-xl border border-white/8 bg-white/[0.03] px-3 py-2">
                      <div className="min-w-0">
                        <p className="truncate text-xs font-medium">{q.clinics?.name ?? 'Clínica'}</p>
                        <p className="text-[10px] text-white/40">
                          {q.proposed_datetime ? fullDateTime(q.proposed_datetime) : QUOTE_LABEL[q.status] ?? q.status}
                        </p>
                      </div>
                      {q.price_brl != null && <p className="text-sm font-bold tabular-nums">{brl(q.price_brl)}</p>}
                    </div>
                  ))}
                </div>
              )}
            </motion.div>
          ))}
        </div>
      )}

      {/* Histórico */}
      {pastOrders.length > 0 && (
        <motion.div variants={screenItem} className="mt-6">
          <button
            onClick={() => setShowPast((v) => !v)}
            className="flex items-center gap-1.5 text-xs font-medium text-white/45 transition-colors hover:text-white/70"
          >
            <ChevronDown size={13} className={cn('transition-transform', showPast && 'rotate-180')} />
            pedidos anteriores ({pastOrders.length})
          </button>
          <AnimatePresence>
            {showPast && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                className="mt-2 space-y-1.5 overflow-hidden"
              >
                {pastOrders.map((o) => (
                  <div key={o.id} className="glass-lo glass flex items-center justify-between rounded-2xl px-3.5 py-2.5 opacity-75">
                    <div className="min-w-0">
                      <p className="truncate text-xs">{(o.items ?? []).map((i) => i.name).join(', ') || 'Pedido'}</p>
                      <p className="text-[10px] text-white/35">{timeAgo(o.created_at)}</p>
                    </div>
                    <GlassBadge tone={o.status === 'completed' ? 'success' : 'neutral'} size="xs">
                      {o.status === 'completed' ? 'concluído' : o.status === 'cancelled' ? 'cancelado' : 'falhou'}
                    </GlassBadge>
                  </div>
                ))}
              </motion.div>
            )}
          </AnimatePresence>
        </motion.div>
      )}

      {/* rodapé vivo */}
      {(activeOrders.length > 0 || activeConsults.length > 0) && (
        <motion.p variants={screenItem} className="mt-5 flex flex-wrap items-center justify-center gap-1.5 px-16 text-center text-[11px] text-white/35">
          <Zap size={11} className="text-accent-hi" /> atualizando ao vivo
          <Star size={9} className="text-white/20" /> decisões finais sempre passam por você no chat
        </motion.p>
      )}
    </Screen>
  );
}
