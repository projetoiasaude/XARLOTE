'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { motion } from 'framer-motion';
import { MessageCircle } from 'lucide-react';
import { timeAgo, adminGet } from '@/lib/utils';
import { GlassCard, GlassBadge, Avatar, EmptyState, SectionHeader } from '@/components/ui';

interface Conv {
  id: string;
  whatsapp_jid: string;
  last_message_at: string | null;
  status: string;
  users?: { preferred_name?: string; full_name?: string; phone_e164?: string } | null;
}

export default function ConversationsPage() {
  const [convs, setConvs] = useState<Conv[]>([]);
  const [loaded, setLoaded] = useState(false);

  async function load() {
    try {
      const data = await adminGet<Conv[]>('/admin/conversations');
      setConvs(data ?? []);
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

  const name = (c: Conv) => c.users?.preferred_name ?? c.users?.full_name ?? c.users?.phone_e164 ?? c.whatsapp_jid.split('@')[0];

  return (
    <div className="space-y-6">
      <SectionHeader
        icon={MessageCircle}
        title="Conversas"
        subtitle="Atendimentos da Xarlote em tempo real"
        size="lg"
        action={
          <GlassBadge tone="live" dot>
            {convs.length} {convs.length === 1 ? 'ativa' : 'ativas'}
          </GlassBadge>
        }
      />

      {convs.length === 0 && loaded ? (
        <GlassCard className="p-2">
          <EmptyState
            icon={MessageCircle}
            title="Nenhuma conversa ainda"
            hint="Use o simulador ou mande mensagem pela uazapi pra Xarlote começar a conversar."
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
          {convs.map((c) => (
            <motion.div
              key={c.id}
              variants={{
                hidden: { opacity: 0, y: 6 },
                show: { opacity: 1, y: 0, transition: { type: 'spring' as const, stiffness: 320, damping: 26 } },
              }}
            >
              <Link href={`/conversations/${c.id}`} className="block">
                <GlassCard variant="lo" interactive className="px-4 py-3 flex items-center gap-3">
                  <Avatar name={name(c)} size="md" />
                  <div className="min-w-0 flex-1">
                    <p className="text-white text-sm font-medium truncate">{name(c)}</p>
                    <p className="text-white/40 text-[11px] font-mono">{c.whatsapp_jid.split('@')[0]}</p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {c.last_message_at && (
                      <span className="text-[11px] text-white/40">{timeAgo(c.last_message_at)}</span>
                    )}
                    <GlassBadge tone={c.status === 'active' ? 'live' : 'neutral'} dot size="xs">
                      {c.status}
                    </GlassBadge>
                  </div>
                </GlassCard>
              </Link>
            </motion.div>
          ))}
        </motion.div>
      )}
    </div>
  );
}
