'use client';
import Link from 'next/link';
import { motion } from 'framer-motion';
import {
  Zap, MessageCircle, ShoppingBag, Activity, ArrowUpRight, Sparkles,
  Users, Store, Brain, Mic, Image as ImageIcon,
} from 'lucide-react';
import { GlassCard, GlassBadge, StatusPing } from '@/components/ui';
import { useXarloteStatus } from '@/lib/hooks/use-xarlote-status';

const CARDS = [
  {
    href: '/simulator',
    icon: Zap,
    title: 'Simulador',
    desc: 'Teste a Xarlote sem uazapi. Envie texto, imagem e localização.',
    accent: 'from-amber-400/50 via-rose-400/30 to-transparent',
    iconColor: 'text-amber-300',
  },
  {
    href: '/conversations',
    icon: MessageCircle,
    title: 'Conversas',
    desc: 'Stream em tempo real de todos os atendimentos da Xarlote.',
    accent: 'from-aurora-blue/55 via-cyan-400/25 to-transparent',
    iconColor: 'text-aurora-blue',
  },
  {
    href: '/orders',
    icon: ShoppingBag,
    title: 'Pedidos',
    desc: 'Cotações com farmácias, status do pedido e confirmações.',
    accent: 'from-emerald-400/50 via-teal-400/25 to-transparent',
    iconColor: 'text-emerald-300',
  },
  {
    href: '/users',
    icon: Users,
    title: 'Usuários',
    desc: 'Perfil 360 com memória semântica, lembretes e histórico.',
    accent: 'from-accent/55 via-aurora-purple/25 to-transparent',
    iconColor: 'text-accent-hi',
  },
  {
    href: '/suppliers',
    icon: Store,
    title: 'Farmácias',
    desc: 'Suppliers descobertos, ratings, status WhatsApp.',
    accent: 'from-pink-400/45 via-rose-400/20 to-transparent',
    iconColor: 'text-rose-300',
  },
  {
    href: '/logs',
    icon: Activity,
    title: 'Logs',
    desc: 'Stream do sistema com filtros por nível e categoria.',
    accent: 'from-purple-400/45 via-fuchsia-400/20 to-transparent',
    iconColor: 'text-purple-300',
  },
];

const container = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { staggerChildren: 0.06, delayChildren: 0.1 } },
};
const item = {
  hidden: { opacity: 0, y: 12 },
  show: { opacity: 1, y: 0, transition: { type: 'spring' as const, stiffness: 320, damping: 26 } },
};

export default function OverviewPage() {
  const status = useXarloteStatus();
  return (
    <div className="space-y-8 py-2">
      {/* Hero */}
      <motion.section
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
        className="flex flex-col gap-3"
      >
        <GlassBadge tone={status.enabled ? 'live' : 'danger'} dot className="self-start">
          {status.enabled ? 'Xarlote conectada' : 'Xarlote desligada'}
        </GlassBadge>
        <div>
          <h1 className="text-4xl font-semibold tracking-tight text-white">
            Cockpit da <span className="bg-gradient-to-r from-aurora-blue via-accent to-aurora-purple bg-clip-text text-transparent">Xarlote</span>
          </h1>
          <p className="mt-2 text-sm text-white/55 max-w-xl">
            Tudo o que ela ouve, fala e aprende em tempo real. Pode mandar áudio, foto, texto ou localização que ela entende.
          </p>
        </div>

        {/* Capabilities pills */}
        <div className="flex flex-wrap gap-2 pt-2">
          <CapabilityPill icon={Brain} label="Memória evolutiva" />
          <CapabilityPill icon={Mic} label="Áudio nativo" />
          <CapabilityPill icon={ImageIcon} label="Visão multimodal" />
          <CapabilityPill icon={Sparkles} label={`Modelo: ${status.model?.split('/').at(-1) ?? '—'}`} />
        </div>
      </motion.section>

      {/* Grid de cards */}
      <motion.div
        variants={container}
        initial="hidden"
        animate="show"
        className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4"
      >
        {CARDS.map((card) => {
          const Icon = card.icon;
          return (
            <motion.div key={card.href} variants={item}>
              <Link href={card.href} className="block group">
                <GlassCard interactive className="relative overflow-hidden p-6 h-full">
                  {/* Accent gradient overlay */}
                  <div
                    className={`pointer-events-none absolute -top-12 -right-12 h-40 w-40 rounded-full bg-gradient-to-br ${card.accent} blur-2xl opacity-70 group-hover:opacity-90 transition-opacity`}
                  />
                  <div className="relative">
                    <div className="flex items-start justify-between mb-3">
                      <div className={`flex h-11 w-11 items-center justify-center rounded-2xl bg-white/8 border border-white/12 ${card.iconColor}`}>
                        <Icon size={20} />
                      </div>
                      <ArrowUpRight
                        size={18}
                        className="text-white/30 group-hover:text-white/70 group-hover:translate-x-0.5 group-hover:-translate-y-0.5 transition-all"
                      />
                    </div>
                    <h3 className="text-base font-semibold text-white">{card.title}</h3>
                    <p className="mt-1 text-sm text-white/55 leading-relaxed">{card.desc}</p>
                  </div>
                </GlassCard>
              </Link>
            </motion.div>
          );
        })}
      </motion.div>

      {/* Onboarding box */}
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.3, duration: 0.4 }}
      >
        <GlassCard className="p-6">
          <div className="flex items-center gap-2 mb-4">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-accent/15 border border-accent/25 text-accent-hi">
              <Sparkles size={16} />
            </div>
            <h2 className="text-base font-semibold text-white">Como começar</h2>
          </div>
          <ol className="space-y-3">
            {[
              ['1', 'Abra o ', <strong key="s" className="text-white">Simulador</strong>, ' e escolha um número de telefone.'],
              ['2', 'Envie qualquer mensagem — a Xarlote responde via OpenRouter.'],
              ['3', 'Na primeira mensagem, ela pede o aceite LGPD.'],
              ['4', 'Depois do aceite, você pode pedir remédios, criar lembretes, mandar áudio/foto.'],
              ['5', 'Pra cotar farmácias: peça um remédio + endereço ou localização 📍.'],
            ].map(([n, ...rest], i) => (
              <li key={i} className="flex items-start gap-3 text-sm text-white/65">
                <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-white/8 border border-white/12 text-[11px] font-semibold text-white/80">
                  {n}
                </span>
                <span>{rest}</span>
              </li>
            ))}
          </ol>
        </GlassCard>
      </motion.div>
    </div>
  );
}

function CapabilityPill({ icon: Icon, label }: { icon: typeof Brain; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full px-2.5 h-7 text-xs text-white/65 bg-white/[0.04] border border-white/8">
      <Icon size={12} className="text-accent-hi" />
      {label}
    </span>
  );
}
