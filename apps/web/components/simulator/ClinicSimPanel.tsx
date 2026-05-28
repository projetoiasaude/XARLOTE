'use client';
import { useEffect, useRef, useState } from 'react';
import { Stethoscope, Send, X, ChevronUp } from 'lucide-react';

const API = process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001';

interface ClinicNegotiation {
  quote_id: string;
  status: string;
  conversation_id: string | null;
  clinic_name: string;
  clinic_phone: string | null;
  proposed_datetime: string | null;
  price_brl: number | null;
}

interface ClinicMsg {
  id: string;
  direction: 'in' | 'out';
  content: string | null;
  created_at: string;
}

/**
 * Painel de simulação de CLÍNICA — espelho do painel de farmácia.
 * Você responde como se fosse cada clínica que a Xarlote contatou.
 * Aparece flutuante no canto quando há uma consulta em negociação.
 *
 * Auto-contido: próprio polling, não mexe no estado do WhatsAppSim.
 */
export function ClinicSimPanel({ userConversationId }: { userConversationId: string | null }) {
  const [clinics, setClinics] = useState<ClinicNegotiation[]>([]);
  const [specialty, setSpecialty] = useState<string | null>(null);
  const [open, setOpen] = useState(true);
  const [selected, setSelected] = useState<string | null>(null); // conversation_id
  const [messages, setMessages] = useState<ClinicMsg[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Polling das clínicas em negociação
  useEffect(() => {
    if (!userConversationId) { setClinics([]); return; }
    let alive = true;
    const load = async () => {
      try {
        const r = await fetch(`${API}/api/simulate/clinic-conversations/${userConversationId}`);
        const d = await r.json();
        if (!alive) return;
        setSpecialty(d.consultation?.specialty ?? null);
        setClinics(Array.isArray(d.clinics) ? d.clinics : []);
      } catch { /* ignora */ }
    };
    load();
    const tid = setInterval(load, 2500);
    return () => { alive = false; clearInterval(tid); };
  }, [userConversationId]);

  // Polling das mensagens da clínica selecionada
  useEffect(() => {
    if (!selected) { setMessages([]); return; }
    let alive = true;
    const load = async () => {
      try {
        const r = await fetch(`${API}/api/simulate/clinic-messages/${selected}`);
        const d = await r.json();
        if (!alive) return;
        setMessages(Array.isArray(d.messages) ? d.messages : []);
      } catch { /* ignora */ }
    };
    load();
    const tid = setInterval(load, 2000);
    return () => { alive = false; clearInterval(tid); };
  }, [selected]);

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages]);

  async function reply() {
    const text = input.trim();
    if (!text || !selected || sending) return;
    setSending(true);
    try {
      await fetch(`${API}/api/simulate/clinic-reply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversationId: selected, text }),
      });
      setInput('');
    } catch { /* ignora */ }
    finally { setSending(false); }
  }

  // Só clínicas que já têm conversa iniciada (a Xarlote já mandou a 1ª msg)
  const active = clinics.filter((c) => c.conversation_id);
  if (!userConversationId || active.length === 0) return null;

  return (
    <div className="fixed bottom-4 right-4 z-50 w-[360px] rounded-2xl overflow-hidden shadow-2xl border border-teal-500/30 bg-[#0d1117]">
      {/* Header */}
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-3 py-2.5 bg-gradient-to-r from-teal-700 to-cyan-700 text-white"
      >
        <Stethoscope size={15} />
        <span className="text-sm font-semibold flex-1 text-left">
          Clínicas {specialty ? `· ${specialty}` : ''} ({active.length})
        </span>
        <span className="text-[10px] bg-white/20 rounded px-1.5 py-0.5">SIMULADOR</span>
        <ChevronUp size={15} className={`transition-transform ${open ? '' : 'rotate-180'}`} />
      </button>

      {open && (
        <div className="max-h-[60vh] flex flex-col">
          {!selected ? (
            // Lista de clínicas
            <div className="overflow-y-auto p-2 space-y-1">
              <p className="text-[11px] text-gray-400 px-1 pb-1">
                Responda como cada clínica pra testar o fluxo (horário, preço, plano):
              </p>
              {active.map((c) => (
                <button
                  key={c.quote_id}
                  onClick={() => setSelected(c.conversation_id)}
                  className="w-full text-left px-2.5 py-2 rounded-lg bg-white/5 hover:bg-white/10 transition-colors"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm text-white truncate">{c.clinic_name}</span>
                    <StatusPill status={c.status} />
                  </div>
                  {c.clinic_phone && <span className="text-[10px] text-gray-500 font-mono">{c.clinic_phone}</span>}
                </button>
              ))}
            </div>
          ) : (
            // Chat da clínica selecionada
            <ChatView
              clinicName={active.find((c) => c.conversation_id === selected)?.clinic_name ?? 'Clínica'}
              messages={messages}
              input={input}
              setInput={setInput}
              onSend={reply}
              sending={sending}
              onBack={() => setSelected(null)}
              bottomRef={bottomRef}
            />
          )}
        </div>
      )}
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const map: Record<string, string> = {
    pending: 'bg-gray-600 text-gray-200',
    offered: 'bg-emerald-700 text-emerald-100',
    selected: 'bg-blue-700 text-blue-100',
    unavailable: 'bg-red-800 text-red-200',
    rejected: 'bg-gray-700 text-gray-400',
    timeout: 'bg-amber-800 text-amber-200',
  };
  const label: Record<string, string> = {
    pending: 'aguardando', offered: 'cotou', selected: 'escolhida',
    unavailable: 'indisponível', rejected: 'recusada', timeout: 'timeout',
  };
  return <span className={`text-[9px] px-1.5 py-0.5 rounded shrink-0 ${map[status] ?? 'bg-gray-600 text-gray-200'}`}>{label[status] ?? status}</span>;
}

function ChatView({
  clinicName, messages, input, setInput, onSend, sending, onBack, bottomRef,
}: {
  clinicName: string;
  messages: ClinicMsg[];
  input: string;
  setInput: (v: string) => void;
  onSend: () => void;
  sending: boolean;
  onBack: () => void;
  bottomRef: React.RefObject<HTMLDivElement>;
}) {
  return (
    <>
      <div className="flex items-center gap-2 px-3 py-2 border-b border-white/10 bg-white/5">
        <button onClick={onBack} className="text-gray-400 hover:text-white"><X size={14} /></button>
        <span className="text-xs text-white font-medium truncate flex-1">{clinicName}</span>
        <span className="text-[9px] text-teal-300">você responde como a clínica</span>
      </div>
      <div className="flex-1 overflow-y-auto p-3 space-y-2 min-h-[200px] max-h-[320px]">
        {messages.length === 0 && (
          <p className="text-[11px] text-gray-500 text-center py-4">A Xarlote ainda não falou nada aqui.</p>
        )}
        {messages.map((m) => {
          // direction 'out' = Xarlote → clínica (esquerda) · 'in' = clínica respondeu (direita)
          const isXarlote = m.direction === 'out';
          return (
            <div key={m.id} className={`flex ${isXarlote ? 'justify-start' : 'justify-end'}`}>
              <div className={`rounded-2xl px-3 py-2 max-w-[80%] text-sm break-words ${
                isXarlote ? 'bg-indigo-700/80 text-white rounded-bl-sm' : 'bg-teal-700/80 text-white rounded-br-sm'
              }`}>
                <p className="text-[9px] opacity-70 mb-0.5">{isXarlote ? '🤖 Xarlote' : '🏥 Você (clínica)'}</p>
                {m.content}
              </div>
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>
      <div className="flex items-center gap-2 p-2 border-t border-white/10">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSend(); } }}
          placeholder="Responder como a clínica… ex: 'Temos quarta 14h, R$250 particular'"
          className="flex-1 bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-xs text-white placeholder-gray-500 focus:outline-none focus:border-teal-500"
        />
        <button
          onClick={onSend}
          disabled={sending || !input.trim()}
          className="rounded-xl bg-teal-600 hover:bg-teal-500 disabled:opacity-40 text-white p-2 transition-colors"
        >
          <Send size={15} />
        </button>
      </div>
    </>
  );
}
