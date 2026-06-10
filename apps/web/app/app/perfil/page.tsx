'use client';
import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { motion } from 'framer-motion';
import {
  Brain,
  Download,
  Heart,
  LogOut,
  MessageCircleHeart,
  Phone,
  ShieldCheck,
  Sparkles,
  Trash2,
  type LucideIcon,
} from 'lucide-react';
import { format } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { Avatar, GlassBadge, GlassButton, Skeleton } from '@/components/ui';
import { Screen, screenItem } from '@/components/xarlote/Screen';
import { ConfidenceBar, SourceBadge } from '@/components/xarlote/bits';
import { useXarloteApp } from '@/lib/xarlote/app-context';
import { formatPhonePretty } from '@/lib/xarlote/pairing';
import { cn } from '@/lib/utils';
import type { MemoryKind, XarMemoryCard } from '@/lib/xarlote/types';

const KIND_META: Record<MemoryKind, { label: string; sub: string; icon: LucideIcon; tint: string; border: string }> = {
  fact: { label: 'Fatos', sub: 'o que é verdade sobre você', icon: Brain, tint: 'text-accent-hi', border: 'border-accent/25' },
  preference: { label: 'Preferências', sub: 'como você gosta das coisas', icon: Sparkles, tint: 'text-aurora-purple', border: 'border-purple-400/25' },
  episode: { label: 'Episódios', sub: 'momentos que vocês viveram', icon: MessageCircleHeart, tint: 'text-aurora-pink', border: 'border-pink-400/25' },
  affect: { label: 'Afeto', sub: 'como você se sente', icon: Heart, tint: 'text-amber-300', border: 'border-amber-400/25' },
};

export default function PerfilPage() {
  const router = useRouter();
  const { overview, overviewLoading, phone, unpair } = useXarloteApp();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const grouped = useMemo(() => {
    const g: Record<string, XarMemoryCard[]> = {};
    for (const c of overview?.memoryCards ?? []) {
      (g[c.kind] ??= []).push(c);
    }
    return g;
  }, [overview?.memoryCards]);

  function exportData() {
    if (!overview) return;
    const blob = new Blob([JSON.stringify(overview, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `xarlote-meus-dados-${format(new Date(), 'yyyy-MM-dd')}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function sair() {
    unpair();
    router.replace('/app/entrar');
  }

  if (!overview) {
    return (
      <Screen title="Perfil" subtitle="você, do jeito que a Xarlote te conhece">
        {overviewLoading ? (
          <div className="space-y-3">
            <Skeleton variant="card" className="h-28" />
            <Skeleton variant="card" className="h-44" />
          </div>
        ) : (
          <motion.div variants={screenItem} className="glass rounded-3xl p-6 text-center text-sm text-white/55">
            Assim que vocês conversarem, seu perfil aparece aqui.
            <div className="mt-4 flex justify-center gap-2">
              <GlassButton variant="primary" size="sm" onClick={() => router.push('/app')}>
                Ir pro chat
              </GlassButton>
              <GlassButton variant="ghost" size="sm" onClick={sair}>
                <LogOut size={13} /> trocar número
              </GlassButton>
            </div>
          </motion.div>
        )}
      </Screen>
    );
  }

  const u = overview.user;
  const name = u.preferred_name ?? u.full_name ?? 'Você';

  return (
    <Screen title="Perfil" subtitle="você, do jeito que a Xarlote te conhece">
      {/* Hero */}
      <motion.div variants={screenItem} className="glass glass-spec mb-5 rounded-3xl p-5">
        <div className="flex items-center gap-4">
          <Avatar name={name} size="xl" />
          <div className="min-w-0">
            <p className="text-lg font-bold leading-tight">{name}</p>
            {u.full_name && u.preferred_name && u.full_name !== u.preferred_name && (
              <p className="text-xs text-white/45">{u.full_name}</p>
            )}
            <p className="mt-0.5 flex items-center gap-1 text-xs text-white/55">
              <Phone size={11} /> {phone ? formatPhonePretty(phone) : u.phone_e164}
            </p>
          </div>
        </div>
        <div className="mt-4 flex flex-wrap gap-1.5">
          <GlassBadge tone="accent" size="xs">
            cliente desde {format(new Date(u.created_at), 'MMM yyyy', { locale: ptBR })}
          </GlassBadge>
          {u.lgpd_consent_at && (
            <GlassBadge tone="success" size="xs" dot>
              LGPD aceita em {format(new Date(u.lgpd_consent_at), 'dd/MM/yyyy')}
            </GlassBadge>
          )}
          {u.home_city && (
            <GlassBadge tone="neutral" size="xs">
              {u.home_city}
            </GlassBadge>
          )}
        </div>
      </motion.div>

      {/* Memória da Xarlote */}
      <motion.section variants={screenItem} className="mb-5">
        <h2 className="mb-1 flex items-center gap-2 text-sm font-semibold text-white/85">
          <Brain size={15} className="text-accent-hi" /> O que a Xarlote lembra de você
        </h2>
        <p className="mb-3 text-[11px] text-white/40">
          A memória influencia as respostas — e ela sempre avisa quando usa algo que lembrou.
        </p>

        {overview.memoryCards.length === 0 ? (
          <div className="glass-lo glass rounded-2xl p-4 text-xs text-white/50">
            Ainda não há memórias — elas nascem naturalmente das conversas.
          </div>
        ) : (
          <div className="space-y-3">
            {(Object.keys(KIND_META) as MemoryKind[]).map((kind) => {
              const cards = grouped[kind] ?? [];
              if (cards.length === 0) return null;
              const meta = KIND_META[kind];
              const Icon = meta.icon;
              const isOpen = expanded.has(kind);
              const visible = isOpen ? cards : cards.slice(0, 4);
              return (
                <div key={kind} className={cn('glass glass-spec rounded-3xl border p-4', meta.border)}>
                  <div className="mb-2.5 flex items-center gap-2">
                    <Icon size={15} className={meta.tint} />
                    <p className="text-[13px] font-semibold">{meta.label}</p>
                    <span className="text-[10px] text-white/35">{meta.sub}</span>
                    <span className="ml-auto rounded-full bg-white/8 px-2 py-0.5 text-[10px] font-semibold text-white/55">
                      {cards.length}
                    </span>
                  </div>
                  <div className="space-y-2.5">
                    {visible.map((c) => (
                      <div key={c.id} className="rounded-2xl bg-white/[0.04] p-3">
                        <p className="text-[13px] leading-snug text-white/90">{c.text}</p>
                        <div className="mt-2 flex items-center gap-2">
                          <div className="flex-1">
                            <ConfidenceBar value={c.confidence} />
                          </div>
                          <SourceBadge source={c.source} />
                        </div>
                      </div>
                    ))}
                  </div>
                  {cards.length > 4 && (
                    <button
                      onClick={() =>
                        setExpanded((s) => {
                          const n = new Set(s);
                          if (n.has(kind)) n.delete(kind);
                          else n.add(kind);
                          return n;
                        })
                      }
                      className="mt-2.5 text-[11px] font-medium text-accent-hi transition-colors hover:text-white"
                    >
                      {isOpen ? 'mostrar menos' : `ver todas (${cards.length})`}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </motion.section>

      {/* Contato de emergência */}
      <motion.section variants={screenItem} className="mb-5">
        <div className="glass rounded-3xl p-4">
          <p className="flex items-center gap-2 text-[13px] font-semibold">
            <Phone size={14} className="text-rose-300" /> Contato de emergência
          </p>
          {u.emergency_contact_name ? (
            <p className="mt-1.5 text-xs text-white/60">
              {u.emergency_contact_name}
              {u.emergency_contact_relation && ` (${u.emergency_contact_relation})`} ·{' '}
              {u.emergency_contact_phone_e164}
            </p>
          ) : (
            <div className="mt-1.5 flex items-center justify-between gap-3">
              <p className="text-xs text-white/50">Nenhum cadastrado — em emergências, isso salva minutos.</p>
              <GlassButton
                size="xs"
                variant="secondary"
                onClick={() => router.push('/app?draft=' + encodeURIComponent('Quero cadastrar meu contato de emergência: '))}
              >
                cadastrar
              </GlassButton>
            </div>
          )}
        </div>
      </motion.section>

      {/* Privacidade */}
      <motion.section variants={screenItem} className="mb-5">
        <div className="glass rounded-3xl p-4">
          <p className="flex items-center gap-2 text-[13px] font-semibold">
            <ShieldCheck size={14} className="text-emerald-300" /> Privacidade & seus dados
          </p>
          <p className="mt-1.5 text-xs leading-relaxed text-white/50">
            Tudo que a Xarlote sabe é seu. Você pode levar embora ou apagar de vez — sem letras miúdas.
          </p>
          <div className="mt-3 flex flex-col gap-2 sm:flex-row">
            <GlassButton size="sm" variant="secondary" className="flex-1" onClick={exportData}>
              <Download size={13} /> Exportar meus dados
            </GlassButton>
            <GlassButton
              size="sm"
              variant="ghost"
              className="flex-1 text-rose-300/85 hover:bg-rose-500/10 hover:text-rose-200"
              onClick={() => router.push('/app?draft=' + encodeURIComponent('esquecer'))}
            >
              <Trash2 size={13} /> Apagar tudo (LGPD)
            </GlassButton>
          </div>
          <p className="mt-2 text-[10px] text-white/35">
            Apagar é conversado no chat e exige sua confirmação explícita — é irreversível.
          </p>
        </div>
      </motion.section>

      {/* Sair */}
      <motion.div variants={screenItem} className="flex flex-col items-center gap-3 pb-4">
        <GlassButton size="sm" variant="ghost" onClick={sair} className="text-white/50">
          <LogOut size={13} /> Sair deste aparelho
        </GlassButton>
        <p className="text-[10px] text-white/25">Xarlote App · uma IA transparente, feita pra cuidar 💜</p>
      </motion.div>
    </Screen>
  );
}
