'use client';
import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AnimatePresence, motion } from 'framer-motion';
import {
  AlarmClockCheck,
  CalendarClock,
  Check,
  Clock3,
  Droplets,
  Dumbbell,
  Moon,
  Pill,
  Plus,
  Sparkles,
  Stethoscope,
  X,
  type LucideIcon,
} from 'lucide-react';
import { GlassBadge, GlassButton, Skeleton } from '@/components/ui';
import { Screen, screenItem } from '@/components/xarlote/Screen';
import { XarloteMascot } from '@/components/xarlote/XarloteMascot';
import { useXarloteApp } from '@/lib/xarlote/app-context';
import { reminderAction } from '@/lib/xarlote/api';
import { countdown, fullDateTime, humanizeRrule } from '@/lib/xarlote/format';
import { cn } from '@/lib/utils';
import type { XarReminder } from '@/lib/xarlote/types';

const TYPE_META: Record<string, { icon: LucideIcon; label: string; tint: string }> = {
  medication: { icon: Pill, label: 'remédio', tint: 'text-accent-hi' },
  appointment: { icon: Stethoscope, label: 'consulta', tint: 'text-aurora-purple' },
  exercise: { icon: Dumbbell, label: 'exercício', tint: 'text-emerald-300' },
  hydration: { icon: Droplets, label: 'hidratação', tint: 'text-sky-300' },
  sleep: { icon: Moon, label: 'sono', tint: 'text-indigo-300' },
  custom: { icon: Sparkles, label: 'lembrete', tint: 'text-amber-300' },
};

const ACTIVE = ['pending', 'sent', 'snoozed'];

export default function LembretesPage() {
  const router = useRouter();
  const { overview, overviewLoading, phone, refreshOverview } = useXarloteApp();
  const [local, setLocal] = useState<XarReminder[]>([]);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [showHistory, setShowHistory] = useState(false);
  const [, setTick] = useState(0); // re-render p/ countdown vivo

  useEffect(() => {
    if (overview) setLocal(overview.reminders);
  }, [overview]);

  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);

  const active = useMemo(
    () =>
      local
        .filter((r) => ACTIVE.includes(r.status))
        .sort((a, b) => +new Date(a.next_run_at ?? a.scheduled_at ?? 0) - +new Date(b.next_run_at ?? b.scheduled_at ?? 0)),
    [local],
  );
  const history = useMemo(() => local.filter((r) => !ACTIVE.includes(r.status)), [local]);
  const next = active.find((r) => r.next_run_at && +new Date(r.next_run_at) > Date.now()) ?? active[0];

  async function act(r: XarReminder, action: 'done' | 'snooze' | 'cancel') {
    if (!phone || busy.has(r.id)) return;
    navigator.vibrate?.(6);
    setBusy((s) => new Set(s).add(r.id));
    const prev = local;
    // otimista
    setLocal((list) =>
      list.map((it) =>
        it.id === r.id
          ? {
              ...it,
              status: action === 'done' ? 'acknowledged' : action === 'cancel' ? 'cancelled' : 'pending',
              next_run_at: action === 'snooze' ? new Date(Date.now() + 30 * 60_000).toISOString() : it.next_run_at,
            }
          : it,
      ),
    );
    try {
      await reminderAction(r.id, phone, action, action === 'snooze' ? 30 : undefined);
      void refreshOverview();
    } catch {
      setLocal(prev); // rollback
    } finally {
      setBusy((s) => {
        const n = new Set(s);
        n.delete(r.id);
        return n;
      });
    }
  }

  const loading = overviewLoading && !overview;

  return (
    <Screen
      title="Lembretes"
      subtitle="a Xarlote se programa sozinha pra cuidar de você"
      right={
        <GlassButton size="sm" variant="secondary" onClick={() => router.push('/app?draft=' + encodeURIComponent('Me lembra de '))}>
          <Plus size={14} /> novo
        </GlassButton>
      }
    >
      {loading ? (
        <div className="space-y-3">
          <Skeleton variant="card" className="h-28" />
          <Skeleton variant="card" className="h-20" />
          <Skeleton variant="card" className="h-20" />
        </div>
      ) : active.length === 0 ? (
        <motion.div variants={screenItem} className="glass flex flex-col items-center rounded-3xl p-8 text-center">
          <XarloteMascot size={110} />
          <p className="mt-3 text-sm font-medium">Nenhum lembrete programado</p>
          <p className="mt-1 max-w-[290px] text-xs text-white/50">
            Quando você começar um tratamento, a Xarlote cria os despertadores sozinha — horário certo, contagem de
            comprimidos e aviso antes de acabar.
          </p>
          <GlassButton
            variant="primary"
            size="md"
            className="mt-4"
            onClick={() => router.push('/app?draft=' + encodeURIComponent('Me lembra de tomar '))}
          >
            Pedir um lembrete
          </GlassButton>
        </motion.div>
      ) : (
        <>
          {/* Próximo lembrete — destaque */}
          {next && (
            <motion.div
              variants={screenItem}
              className="glass glass-spec relative mb-5 overflow-hidden rounded-3xl border-accent/30 p-5"
            >
              <div className="absolute -right-8 -top-8 h-32 w-32 rounded-full bg-accent/20 blur-2xl" />
              <div className="relative flex items-center gap-4">
                <XarloteMascot size={62} glow={false} />
                <div className="min-w-0 flex-1">
                  <p className="text-[10px] font-semibold uppercase tracking-widest text-accent-hi">próximo</p>
                  <p className="mt-0.5 truncate text-lg font-bold leading-tight">{next.title}</p>
                  <p className="mt-1 text-sm text-white/60">
                    {next.next_run_at ? (
                      <>
                        <span className="font-semibold text-white">{countdown(next.next_run_at)}</span>
                        <span className="text-white/40"> · {fullDateTime(next.next_run_at)}</span>
                      </>
                    ) : (
                      'sem horário definido'
                    )}
                  </p>
                  {humanizeRrule(next.rrule) && (
                    <p className="mt-0.5 text-[11px] text-white/40">repete: {humanizeRrule(next.rrule)}</p>
                  )}
                </div>
              </div>
            </motion.div>
          )}

          {/* Lista de ativos */}
          <motion.div variants={screenItem} className="space-y-2.5">
            <AnimatePresence initial={false}>
              {active.map((r) => {
                const meta = TYPE_META[r.type] ?? TYPE_META['custom']!;
                const Icon = meta.icon;
                const isBusy = busy.has(r.id);
                return (
                  <motion.div
                    key={r.id}
                    layout
                    initial={{ opacity: 0, y: 12 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, x: 60, scale: 0.95 }}
                    transition={{ type: 'spring', stiffness: 320, damping: 28 }}
                    className={cn('glass glass-spec rounded-3xl p-4', isBusy && 'pointer-events-none opacity-60')}
                  >
                    <div className="flex items-start gap-3">
                      <div className={cn('mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-white/6 border border-white/10', meta.tint)}>
                        <Icon size={17} />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <p className="truncate text-sm font-semibold">{r.title}</p>
                          {r.status === 'sent' && (
                            <GlassBadge tone="info" size="xs">
                              enviado
                            </GlassBadge>
                          )}
                          {r.status === 'snoozed' && (
                            <GlassBadge tone="warn" size="xs">
                              adiado
                            </GlassBadge>
                          )}
                        </div>
                        {r.body && <p className="mt-0.5 line-clamp-2 text-xs text-white/50">{r.body}</p>}
                        <p className="mt-1 text-[11px] text-white/45">
                          {r.next_run_at && (
                            <span className="font-medium text-white/70">{countdown(r.next_run_at)}</span>
                          )}
                          {humanizeRrule(r.rrule) && <span> · {humanizeRrule(r.rrule)}</span>}
                        </p>
                      </div>
                    </div>
                    <div className="mt-3 flex items-center gap-2">
                      <GlassButton size="xs" variant="success" onClick={() => void act(r, 'done')}>
                        <Check size={12} /> feito
                      </GlassButton>
                      <GlassButton size="xs" variant="secondary" onClick={() => void act(r, 'snooze')}>
                        <Clock3 size={12} /> +30min
                      </GlassButton>
                      <GlassButton size="xs" variant="ghost" className="ml-auto text-white/45 hover:text-rose-300" onClick={() => void act(r, 'cancel')}>
                        <X size={12} /> cancelar
                      </GlassButton>
                    </div>
                  </motion.div>
                );
              })}
            </AnimatePresence>
          </motion.div>
        </>
      )}

      {/* Como funciona */}
      <motion.div variants={screenItem} className="glass-lo glass mt-6 rounded-3xl p-4">
        <div className="flex items-start gap-3">
          <AlarmClockCheck size={16} className="mt-0.5 shrink-0 text-accent-hi" />
          <p className="text-xs leading-relaxed text-white/55">
            <span className="font-semibold text-white/80">Como funciona:</span> quando você compra um remédio com a
            Xarlote, ela mesma agenda os horários, conta os comprimidos que restam e te procura antes de acabar — sem
            você pedir nada.
          </p>
        </div>
      </motion.div>

      {/* Histórico */}
      {history.length > 0 && (
        <motion.div variants={screenItem} className="mt-6">
          <button
            onClick={() => setShowHistory((v) => !v)}
            className="flex items-center gap-1.5 text-xs font-medium text-white/45 transition-colors hover:text-white/70"
          >
            <CalendarClock size={13} />
            {showHistory ? 'esconder histórico' : `histórico (${history.length})`}
          </button>
          <AnimatePresence>
            {showHistory && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                className="mt-2 space-y-1.5 overflow-hidden"
              >
                {history.map((r) => (
                  <div key={r.id} className="glass-lo glass flex items-center justify-between rounded-2xl px-3.5 py-2.5 opacity-70">
                    <p className="truncate text-xs text-white/65">{r.title}</p>
                    <GlassBadge tone={r.status === 'acknowledged' ? 'success' : 'neutral'} size="xs">
                      {r.status === 'acknowledged' ? 'feito' : 'cancelado'}
                    </GlassBadge>
                  </div>
                ))}
              </motion.div>
            )}
          </AnimatePresence>
        </motion.div>
      )}
    </Screen>
  );
}
