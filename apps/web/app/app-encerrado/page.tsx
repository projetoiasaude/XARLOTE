import type { Metadata } from 'next';
import { MessageCircle, ShieldCheck } from 'lucide-react';
import { GlassCard, GlassButton } from '@/components/ui';
import { XarloteLogo } from '@/components/xarlote/XarloteLogo';

// Número da Xarlote — o mesmo que o /app/entrar oferecia (app/app/entrar/page.tsx).
const XARLOTE_WA = 'https://wa.me/556298345024';

export const metadata: Metadata = {
  title: 'Xarlote — acesso pelo navegador encerrado',
  description: 'O painel do paciente pelo navegador foi encerrado. A conversa com a Xarlote continua no WhatsApp.',
  // Nada aqui deve virar resultado de busca: a URL antiga (/app) ainda circula por aí.
  robots: { index: false, follow: false },
};

/**
 * Destino de TODO `/app*` enquanto `NEXT_PUBLIC_APP_WEB_ENABLED` não for `1`
 * (ver `middleware.ts`). Server component de propósito: sem estado, sem fetch, sem
 * token — a página que substitui uma porta aberta não pode ter maçaneta nenhuma.
 */
export default function AppEncerradoPage() {
  return (
    <main className="grid min-h-svh place-items-center px-6 py-12">
      <div className="flex w-full max-w-md flex-col items-center text-center">
        <XarloteLogo size={120} />

        <h1 className="mt-4 text-2xl font-semibold tracking-tight text-white">
          A Xarlote saiu do navegador
        </h1>
        <p className="mt-2 text-sm leading-relaxed text-white/60">
          Esta página era um atalho pra ver lembretes e histórico pelo computador. Pra entrar,
          ela pedia só o número de telefone — e digitar um número não prova que ele é seu.
          Preferimos fechar a porta a deixar o histórico de alguém ao alcance de quem souber
          o telefone.
        </p>

        <GlassCard className="mt-7 w-full p-5 text-left">
          <p className="text-sm leading-relaxed text-white/75">
            <strong className="text-white">Nada mudou pra você.</strong> A conversa continua no
            WhatsApp, do mesmo jeito de sempre: é lá que a Xarlote lembra dos remédios, cota na
            farmácia, marca consulta e guarda seus exames.
          </p>

          <a href={XARLOTE_WA} target="_blank" rel="noreferrer" className="mt-4 block">
            <GlassButton variant="primary" size="lg" className="w-full">
              <MessageCircle size={16} />
              Abrir o WhatsApp da Xarlote
            </GlassButton>
          </a>

          <p className="mt-3 text-xs leading-relaxed text-white/45">
            Seus dados continuam sendo seus. Pra pedir uma cópia ou apagar tudo, é só falar
            isso pra Xarlote na conversa.
          </p>
        </GlassCard>

        <div className="mt-6 flex items-center gap-2 text-[11px] text-white/45">
          <ShieldCheck size={13} className="shrink-0 text-emerald-300/70" />
          A Xarlote é uma IA — transparente sempre.
        </div>
        <p className="mt-1.5 text-[11px] text-white/45">
          Emergência? Ligue <span className="font-semibold text-rose-300/90">192 (SAMU)</span>.
        </p>
      </div>
    </main>
  );
}
