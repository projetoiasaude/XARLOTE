'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { motion } from 'framer-motion';
import { ArrowRight, MessageCircle, ShieldCheck, Sparkles } from 'lucide-react';
import { GlassButton, GlassInput } from '@/components/ui';
import { XarloteHero } from '@/components/xarlote/XarloteHero';
import { useXarloteApp } from '@/lib/xarlote/app-context';
import { fetchOverview } from '@/lib/xarlote/api';
import { normalizePhoneInput } from '@/lib/xarlote/pairing';

const XARLOTE_WA = 'https://wa.me/556298345024';

const stagger = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { staggerChildren: 0.09, delayChildren: 0.1 } },
};
const item = {
  hidden: { opacity: 0, y: 14, filter: 'blur(6px)' },
  show: { opacity: 1, y: 0, filter: 'blur(0px)', transition: { type: 'spring', stiffness: 280, damping: 26 } },
};

export default function EntrarPage() {
  const router = useRouter();
  const { pair } = useXarloteApp();
  const [raw, setRaw] = useState('');
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unknown, setUnknown] = useState<string | null>(null); // telefone válido mas sem cadastro

  async function submit() {
    setError(null);
    const phone = normalizePhoneInput(raw);
    if (!phone) {
      setError('Hmm, esse número não parece completo — confere o DDD?');
      return;
    }
    setChecking(true);
    try {
      const overview = await fetchOverview(phone);
      if (overview) {
        pair(phone);
        setTimeout(() => router.replace('/app'), 450);
      } else {
        setUnknown(phone);
      }
    } catch {
      setError('Não consegui falar com a Xarlote agora. Tenta de novo em instantes.');
    } finally {
      setChecking(false);
    }
  }

  function startFresh() {
    if (!unknown) return;
    pair(unknown);
    router.replace('/app');
  }

  return (
    <main className="flex flex-1 flex-col items-center justify-center px-6 py-12 pt-safe pb-safe">
      <motion.div variants={stagger} initial="hidden" animate="show" className="flex w-full max-w-sm flex-col items-center">
        <motion.div variants={item}>
          <XarloteHero size={240} />
        </motion.div>

        <motion.h1
          variants={item}
          className="mt-4 bg-gradient-to-r from-aurora-blue via-accent-hi to-aurora-pink bg-clip-text text-3xl font-bold tracking-[0.35em] text-transparent"
        >
          XARLOTE
        </motion.h1>
        <motion.p variants={item} className="mt-2 text-center text-sm text-white/55">
          Sua saúde, cuidada por uma IA que age de verdade —
          <br />
          lembra, compra, marca e acompanha você.
        </motion.p>

        {!unknown ? (
          <motion.div variants={item} className="glass glass-spec mt-8 w-full rounded-3xl p-5">
            <label htmlFor="phone" className="text-xs font-medium text-white/60">
              Seu WhatsApp (o mesmo que fala com a Xarlote)
            </label>
            <GlassInput
              id="phone"
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              placeholder="+55 (62) 99999-9999"
              value={raw}
              onChange={(e) => setRaw(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void submit()}
              className="mt-2 w-full text-base"
              glowOnFocus
            />
            {error && (
              <motion.p
                initial={{ opacity: 0, x: -6 }}
                animate={{ opacity: 1, x: [0, -5, 5, -3, 0] }}
                transition={{ duration: 0.35 }}
                className="mt-2 text-xs text-rose-300"
              >
                {error}
              </motion.p>
            )}
            <GlassButton
              variant="primary"
              size="lg"
              className="mt-4 w-full"
              onClick={() => void submit()}
              disabled={checking}
            >
              {checking ? 'Procurando você…' : 'Entrar'}
              {!checking && <ArrowRight size={16} />}
            </GlassButton>
          </motion.div>
        ) : (
          <motion.div
            initial={{ opacity: 0, y: 12, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            transition={{ type: 'spring', stiffness: 300, damping: 26 }}
            className="glass glass-spec mt-8 w-full rounded-3xl p-5 text-center"
          >
            <Sparkles className="mx-auto text-accent-hi" size={22} />
            <p className="mt-2 text-sm font-medium text-white">A gente ainda não se conhece!</p>
            <p className="mt-1 text-xs text-white/55">
              Esse número ainda não conversou com a Xarlote. Comece pelo WhatsApp ou daqui mesmo —
              a primeira mensagem já apresenta vocês.
            </p>
            <div className="mt-4 flex flex-col gap-2">
              <GlassButton variant="primary" size="md" className="w-full" onClick={startFresh}>
                <MessageCircle size={15} /> Começar por aqui
              </GlassButton>
              <a href={XARLOTE_WA} target="_blank" rel="noreferrer" className="w-full">
                <GlassButton variant="secondary" size="md" className="w-full">
                  Abrir o WhatsApp da Xarlote
                </GlassButton>
              </a>
              <button onClick={() => setUnknown(null)} className="mt-1 text-xs text-white/45 hover:text-white/70">
                usar outro número
              </button>
            </div>
          </motion.div>
        )}

        <motion.div variants={item} className="mt-6 flex items-center gap-2 text-[11px] text-white/40">
          <ShieldCheck size={13} className="shrink-0 text-emerald-300/70" />
          A Xarlote é uma IA — transparente sempre. Seus dados são seus (LGPD).
        </motion.div>
        <motion.p variants={item} className="mt-1.5 text-[11px] text-white/30">
          Emergência? Ligue <span className="font-semibold text-rose-300/80">192 (SAMU)</span>.
        </motion.p>
      </motion.div>
    </main>
  );
}
