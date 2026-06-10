'use client';
import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { motion } from 'framer-motion';
import {
  Activity,
  AlertTriangle,
  HeartPulse,
  Pill,
  ShieldAlert,
  ShoppingBag,
  Sparkles,
  Stethoscope,
} from 'lucide-react';
import { GlassBadge, GlassButton, Skeleton, Tabs } from '@/components/ui';
import { Screen, screenItem } from '@/components/xarlote/Screen';
import { CountUp, ProgressRing } from '@/components/xarlote/bits';
import { XarloteSwim } from '@/components/xarlote/XarloteSwim';
import { useXarloteApp } from '@/lib/xarlote/app-context';
import { countdown, shortDate } from '@/lib/xarlote/format';
import { cn, timeAgo } from '@/lib/utils';
import type { XarInventory, XarOverview } from '@/lib/xarlote/types';

type TLKind = 'compra' | 'sintoma' | 'consulta' | 'dose';
interface TLItem {
  id: string;
  at: string;
  kind: TLKind;
  title: string;
  sub?: string;
}

const TL_META: Record<TLKind, { icon: typeof Pill; tint: string; ring: string }> = {
  compra: { icon: ShoppingBag, tint: 'text-accent-hi', ring: 'border-accent/40 bg-accent/15' },
  sintoma: { icon: Activity, tint: 'text-rose-300', ring: 'border-rose-400/40 bg-rose-400/15' },
  consulta: { icon: Stethoscope, tint: 'text-aurora-purple', ring: 'border-purple-400/40 bg-purple-400/15' },
  dose: { icon: Pill, tint: 'text-amber-300', ring: 'border-amber-400/40 bg-amber-400/15' },
};

function buildTimeline(o: XarOverview): TLItem[] {
  const items: TLItem[] = [];
  for (const ord of o.orders) {
    if (['handed_off', 'completed'].includes(ord.status)) {
      items.push({
        id: `o-${ord.id}`,
        at: ord.updated_at ?? ord.created_at,
        kind: 'compra',
        title: 'Compra na farmácia entregue',
        sub: (ord.items ?? []).map((i) => i.name).filter(Boolean).join(', ') || undefined,
      });
    }
  }
  for (const s of o.symptoms) {
    items.push({
      id: `s-${s.id}`,
      at: s.created_at,
      kind: 'sintoma',
      title: `Sintoma: ${s.name}`,
      sub: s.intensity != null ? `intensidade ${s.intensity}/10` : s.context?.slice(0, 80) ?? undefined,
    });
  }
  for (const c of o.consultations) {
    items.push({
      id: `c-${c.id}`,
      at: c.created_at,
      kind: 'consulta',
      title: `Consulta${c.specialty ? ` · ${c.specialty}` : ''}`,
      sub: c.scheduled_at ? `agendada para ${shortDate(c.scheduled_at)}` : c.status,
    });
  }
  for (const m of o.medicationLog) {
    if (['skipped', 'no_response'].includes(m.status)) {
      items.push({ id: `m-${m.id}`, at: m.created_at, kind: 'dose', title: 'Dose não confirmada' });
    }
  }
  return items.sort((a, b) => +new Date(b.at) - +new Date(a.at)).slice(0, 30);
}

function inventoryFor(invs: XarInventory[], medicationId: string): XarInventory | undefined {
  return invs.find((i) => i.medication_id === medicationId);
}

export default function SaudePage() {
  const router = useRouter();
  const { overview, overviewLoading } = useXarloteApp();
  const [tlFilter, setTlFilter] = useState('tudo');

  const timeline = useMemo(() => (overview ? buildTimeline(overview) : []), [overview]);
  const tlFiltered = tlFilter === 'tudo' ? timeline : timeline.filter((t) => t.kind === tlFilter);

  if (!overview) {
    return (
      <Screen title="Saúde 360" subtitle="tudo que a Xarlote acompanha por você">
        {overviewLoading ? (
          <div className="space-y-3">
            <Skeleton variant="card" className="h-24" />
            <Skeleton variant="card" className="h-40" />
            <Skeleton variant="card" className="h-40" />
          </div>
        ) : (
          <motion.div variants={screenItem} className="glass flex flex-col items-center rounded-3xl p-8 text-center">
            <XarloteSwim size={150} />
            <p className="mt-3 text-sm font-medium">Sua história de saúde nasce na conversa</p>
            <p className="mt-1 max-w-[280px] text-xs text-white/50">
              Conforme você fala com a Xarlote, remédios, condições e tudo mais vão aparecendo aqui — organizados sozinhos.
            </p>
            <GlassButton variant="primary" size="md" className="mt-4" onClick={() => router.push('/app')}>
              Conversar com a Xarlote
            </GlassButton>
          </motion.div>
        )}
      </Screen>
    );
  }

  const adherenceRaw = overview.user.adherence_score_30d;
  const adherence = adherenceRaw == null ? null : adherenceRaw <= 1 ? Math.round(adherenceRaw * 100) : Math.round(adherenceRaw);
  const activeReminders = overview.reminders.filter((r) => ['pending', 'sent', 'snoozed'].includes(r.status)).length;

  const hasAnything =
    overview.medications.length + overview.conditions.length + overview.allergies.length + overview.treatments.length + timeline.length > 0;

  return (
    <Screen title="Saúde 360" subtitle="tudo que a Xarlote acompanha por você">
      {/* Pills de visão geral */}
      <motion.div variants={screenItem} className="mb-5 grid grid-cols-3 gap-2.5">
        {[
          { label: 'adesão 30d', value: adherence, suffix: '%' },
          { label: 'remédios ativos', value: overview.medications.length, suffix: '' },
          { label: 'lembretes', value: activeReminders, suffix: '' },
        ].map((s) => (
          <div key={s.label} className="glass glass-spec rounded-2xl px-3 py-3 text-center">
            <p className="text-xl font-bold text-white">
              {s.value == null ? '—' : <CountUp value={s.value} suffix={s.suffix} />}
            </p>
            <p className="mt-0.5 text-[10px] uppercase tracking-wide text-white/45">{s.label}</p>
          </div>
        ))}
      </motion.div>

      {!hasAnything && (
        <motion.div variants={screenItem} className="glass flex flex-col items-center rounded-3xl p-8 text-center">
          <XarloteSwim size={140} />
          <p className="mt-3 text-sm font-medium">Tudo limpo por aqui (por enquanto)</p>
          <p className="mt-1 max-w-[280px] text-xs text-white/50">
            Conta pra Xarlote o que você toma e como anda sua saúde — ela organiza tudo aqui sozinha.
          </p>
          <GlassButton variant="primary" size="sm" className="mt-4" onClick={() => router.push('/app')}>
            Contar agora
          </GlassButton>
        </motion.div>
      )}

      {/* Medicamentos + estoque */}
      {overview.medications.length > 0 && (
        <motion.section variants={screenItem} className="mb-6">
          <h2 className="mb-2.5 flex items-center gap-2 text-sm font-semibold text-white/85">
            <Pill size={15} className="text-accent-hi" /> Medicamentos
          </h2>
          <div className="grid gap-2.5 sm:grid-cols-2">
            {overview.medications.map((med) => {
              const inv = inventoryFor(overview.inventory, med.id);
              const total = (inv?.tablets_per_box ?? 0) * (inv?.box_count ?? 1);
              const pct = inv?.tablets_remaining != null && total > 0 ? Math.min(100, Math.round((inv.tablets_remaining / total) * 100)) : null;
              return (
                <motion.div
                  key={med.id}
                  whileHover={{ y: -2, scale: 1.004 }}
                  transition={{ type: 'spring', stiffness: 320, damping: 26 }}
                  className="glass glass-spec flex items-center gap-3 rounded-3xl p-4"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold">{med.medication_name}</p>
                    <p className="mt-0.5 text-xs text-white/50">
                      {[med.dosage, med.frequency].filter(Boolean).join(' · ') || 'em uso'}
                    </p>
                    {inv?.expected_depletion_at && (
                      <p className={cn('mt-1.5 text-[11px] font-medium', (pct ?? 100) < 20 ? 'text-rose-300' : 'text-white/45')}>
                        acaba {countdown(inv.expected_depletion_at)} — a Xarlote te avisa antes
                      </p>
                    )}
                  </div>
                  {pct != null && inv ? (
                    <ProgressRing pct={pct} size={58}>
                      <div className="text-center leading-none">
                        <p className="text-[13px] font-bold tabular-nums">{inv.tablets_remaining}</p>
                        <p className="text-[8px] text-white/40">restam</p>
                      </div>
                    </ProgressRing>
                  ) : (
                    <GlassBadge tone="neutral" size="xs">
                      sem estoque monitorado
                    </GlassBadge>
                  )}
                </motion.div>
              );
            })}
          </div>
        </motion.section>
      )}

      {/* Alergias — sempre visível primeiro por segurança */}
      {overview.allergies.length > 0 && (
        <motion.section variants={screenItem} className="mb-6">
          <h2 className="mb-2.5 flex items-center gap-2 text-sm font-semibold text-white/85">
            <ShieldAlert size={15} className="text-rose-300" /> Alergias
          </h2>
          <div className="flex flex-wrap gap-2">
            {overview.allergies.map((a) => (
              <span
                key={a.id}
                className="flex items-center gap-1.5 rounded-full border border-rose-400/35 bg-rose-500/12 px-3 py-1.5 text-xs font-medium text-rose-200"
              >
                <AlertTriangle size={12} />
                {a.substance}
                {a.severity && <span className="text-rose-300/60">· {a.severity}</span>}
              </span>
            ))}
          </div>
        </motion.section>
      )}

      {/* Condições */}
      {overview.conditions.length > 0 && (
        <motion.section variants={screenItem} className="mb-6">
          <h2 className="mb-2.5 flex items-center gap-2 text-sm font-semibold text-white/85">
            <HeartPulse size={15} className="text-aurora-pink" /> Condições
          </h2>
          <div className="flex flex-wrap gap-2">
            {overview.conditions.map((c) => (
              <span key={c.id} className="glass rounded-full px-3 py-1.5 text-xs font-medium text-white/85">
                {c.name}
              </span>
            ))}
          </div>
        </motion.section>
      )}

      {/* Tratamentos */}
      {overview.treatments.length > 0 && (
        <motion.section variants={screenItem} className="mb-6">
          <h2 className="mb-2.5 flex items-center gap-2 text-sm font-semibold text-white/85">
            <Sparkles size={15} className="text-accent-hi" /> Tratamentos
          </h2>
          <div className="space-y-2">
            {overview.treatments.map((t) => (
              <div key={t.id} className="glass flex items-center justify-between rounded-2xl px-4 py-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{t.name}</p>
                  {t.started_at && <p className="text-[11px] text-white/40">desde {shortDate(t.started_at)}</p>}
                </div>
                <GlassBadge
                  tone={t.status === 'active' ? 'success' : t.status === 'paused' ? 'warn' : 'neutral'}
                  size="xs"
                  dot={t.status === 'active'}
                >
                  {t.status === 'active' ? 'ativo' : t.status === 'paused' ? 'pausado' : t.status === 'completed' ? 'concluído' : t.status}
                </GlassBadge>
              </div>
            ))}
          </div>
        </motion.section>
      )}

      {/* Médicos */}
      {overview.prescribers.length > 0 && (
        <motion.section variants={screenItem} className="mb-6">
          <h2 className="mb-2.5 flex items-center gap-2 text-sm font-semibold text-white/85">
            <Stethoscope size={15} className="text-aurora-purple" /> Seus médicos
          </h2>
          <div className="space-y-2">
            {overview.prescribers.map((p) => (
              <div key={p.id} className="glass flex items-center gap-3 rounded-2xl px-4 py-3">
                <div className="flex h-9 w-9 items-center justify-center rounded-full bg-gradient-to-br from-aurora-purple to-aurora-pink text-xs font-bold">
                  {p.name.slice(0, 1).toUpperCase()}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{p.name}</p>
                  <p className="text-[11px] text-white/45">
                    {[p.specialty, p.crm && `CRM ${p.crm}${p.crm_state ? `-${p.crm_state}` : ''}`].filter(Boolean).join(' · ')}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </motion.section>
      )}

      {/* Linha da vida */}
      {timeline.length > 0 && (
        <motion.section variants={screenItem}>
          <div className="mb-3 flex flex-col gap-2.5 sm:flex-row sm:items-center sm:justify-between">
            <h2 className="flex items-center gap-2 whitespace-nowrap text-sm font-semibold text-white/85">
              <Activity size={15} className="text-accent-hi" /> Linha da vida
            </h2>
            <Tabs
              id="tl"
              size="sm"
              value={tlFilter}
              onChange={setTlFilter}
              options={[
                { value: 'tudo', label: 'tudo' },
                { value: 'compra', label: 'compras' },
                { value: 'sintoma', label: 'sintomas' },
                { value: 'consulta', label: 'consultas' },
              ]}
            />
          </div>
          <div className="relative ml-3 space-y-3 border-l border-white/10 pl-5">
            {tlFiltered.map((item, i) => {
              const Meta = TL_META[item.kind];
              const Icon = Meta.icon;
              return (
                <motion.div
                  key={item.id}
                  initial={{ opacity: 0, x: -10 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: i * 0.04, type: 'spring', stiffness: 320, damping: 26 }}
                  className="relative"
                >
                  <span
                    className={cn(
                      'absolute -left-[29px] top-1 flex h-[18px] w-[18px] items-center justify-center rounded-full border',
                      Meta.ring,
                    )}
                  >
                    <Icon size={9} className={Meta.tint} />
                  </span>
                  <div className="glass-lo glass rounded-2xl px-3.5 py-2.5">
                    <p className="text-[13px] font-medium leading-snug">{item.title}</p>
                    {item.sub && <p className="mt-0.5 text-[11px] text-white/45">{item.sub}</p>}
                    <p className="mt-0.5 text-[10px] text-white/30">{timeAgo(item.at)}</p>
                  </div>
                </motion.div>
              );
            })}
            {tlFiltered.length === 0 && <p className="py-3 text-xs text-white/40">nada nessa categoria ainda.</p>}
          </div>
        </motion.section>
      )}
    </Screen>
  );
}
