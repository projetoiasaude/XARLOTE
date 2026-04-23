'use client';
import { useState, useEffect, useRef, useCallback } from 'react';
import {
  Send, MapPin, Image as ImageIcon, Phone, RefreshCw,
  Store, ChevronRight, Clock, CheckCircle, XCircle, Loader2,
} from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { apiUrl, formatTime } from '@/lib/utils';
import type { RealtimeChannel } from '@supabase/supabase-js';

// ─── Types ───────────────────────────────────────────────────────────────────

interface Message {
  id: string;
  direction: 'in' | 'out';
  sender_role: string;
  content_type: string;
  content: string | null;
  location_lat?: number | null;
  location_lng?: number | null;
  llm_model?: string | null;
  llm_latency_ms?: number | null;
  created_at: string;
}

interface Supplier {
  id: string;
  name: string;
  address: string;
  city: string;
  state: string;
  latitude: number | null;
  longitude: number | null;
  rating: number | null;
}

interface PharmacyQuote {
  id: string;
  status: string;
  total: number | null;
  subtotal: number | null;
  delivery_fee: number | null;
  eta_minutes: number | null;
  payment_methods: string[] | null;
  pix_key: string | null;
  distance_km: number | null;
  conversation_id: string | null;
  suppliers: Supplier | null;
  messages: Message[];
}

interface ActiveOrder {
  id: string;
  status: string;
  items: Array<{ name: string; dosage?: string; quantity?: string }>;
  created_at: string;
  delivery_lat: number | null;
  delivery_lng: number | null;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const DEMO_PHONES = ['+5511999990001', '+5511999990002', '+5511999990003'];

const STATUS_LABELS: Record<string, string> = {
  pending: 'Aguardando',
  contacting: 'Contatando',
  negotiating: 'Negociando',
  quoted: 'Cotado ✓',
  unavailable: 'Indisponível',
  timeout: 'Timeout',
};

const STATUS_COLORS: Record<string, string> = {
  pending: 'bg-gray-600 text-gray-200',
  contacting: 'bg-yellow-600 text-yellow-100',
  negotiating: 'bg-blue-600 text-blue-100',
  quoted: 'bg-green-600 text-green-100',
  unavailable: 'bg-red-700 text-red-100',
  timeout: 'bg-orange-700 text-orange-100',
};

// ─── Main component ───────────────────────────────────────────────────────────

export function WhatsAppSimulator() {
  const [activeTab, setActiveTab] = useState<'user' | 'pharmacies'>('user');
  const [phone, setPhone] = useState(DEMO_PHONES[0] ?? '+5511999990001');
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [locationMode, setLocationMode] = useState(false);
  const [latInput, setLatInput] = useState('-23.5614');
  const [lngInput, setLngInput] = useState('-46.6558');

  // Pharmacy state
  const [activeOrder, setActiveOrder] = useState<ActiveOrder | null>(null);
  const [pharmacyQuotes, setPharmacyQuotes] = useState<PharmacyQuote[]>([]);
  const [selectedPharmacyConvId, setSelectedPharmacyConvId] = useState<string | null>(null);
  const [pharmacyInput, setPharmacyInput] = useState('');
  const [pharmacyLoading, setPharmacyLoading] = useState(false);

  const channelRef = useRef<RealtimeChannel | null>(null);
  const pharmacyChannelsRef = useRef<RealtimeChannel[]>([]);
  const orderChannelRef = useRef<RealtimeChannel | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const pharmacyBottomRef = useRef<HTMLDivElement>(null);

  // ─── Load user conversation ─────────────────────────────────────────────

  const loadConversation = useCallback(async (p: string) => {
    setMessages([]);
    setConversationId(null);
    setActiveOrder(null);
    setPharmacyQuotes([]);
    setSelectedPharmacyConvId(null);
    try {
      const res = await fetch(apiUrl(`/api/simulate/conversation/${encodeURIComponent(p)}`));
      const data = await res.json();
      if (data.conversation) {
        setConversationId(data.conversation.id);
        setMessages(data.messages ?? []);
      }
    } catch { /* api not running */ }
  }, []);

  useEffect(() => { loadConversation(phone); }, [phone, loadConversation]);

  // ─── Realtime: user messages ────────────────────────────────────────────

  useEffect(() => {
    if (!conversationId) return;
    channelRef.current?.unsubscribe();
    const ch = supabase
      .channel(`sim:user:${conversationId}`)
      .on('postgres_changes', {
        event: 'INSERT', schema: 'public', table: 'messages',
        filter: `conversation_id=eq.${conversationId}`,
      }, (payload) => {
        setMessages((prev) => {
          if (prev.some((m) => m.id === payload.new['id'])) return prev;
          return [...prev, payload.new as Message];
        });
      })
      .subscribe();
    channelRef.current = ch;
    return () => { ch.unsubscribe(); };
  }, [conversationId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // ─── Realtime: pharmacy messages ────────────────────────────────────────

  const subscribeToPharmacyConversations = useCallback((quotes: PharmacyQuote[]) => {
    pharmacyChannelsRef.current.forEach((ch) => ch.unsubscribe());
    pharmacyChannelsRef.current = [];

    for (const q of quotes) {
      if (!q.conversation_id) continue;
      const convId = q.conversation_id;
      const ch = supabase
        .channel(`sim:pharmacy:${convId}`)
        .on('postgres_changes', {
          event: 'INSERT', schema: 'public', table: 'messages',
          filter: `conversation_id=eq.${convId}`,
        }, (payload) => {
          const newMsg = payload.new as Message;
          setPharmacyQuotes((prev) =>
            prev.map((pq) =>
              pq.conversation_id === convId
                ? { ...pq, messages: pq.messages.some((m) => m.id === newMsg.id) ? pq.messages : [...pq.messages, newMsg] }
                : pq
            )
          );
        })
        .subscribe();
      pharmacyChannelsRef.current.push(ch);
    }
  }, []);

  useEffect(() => {
    return () => {
      pharmacyChannelsRef.current.forEach((ch) => ch.unsubscribe());
    };
  }, []);

  useEffect(() => {
    pharmacyBottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [pharmacyQuotes, selectedPharmacyConvId]);

  // ─── Realtime: quote status updates ─────────────────────────────────────

  const subscribeToOrderQuotes = useCallback((orderId: string) => {
    orderChannelRef.current?.unsubscribe();
    const ch = supabase
      .channel(`sim:quotes:${orderId}`)
      .on('postgres_changes', {
        event: 'UPDATE', schema: 'public', table: 'quotes',
        filter: `order_id=eq.${orderId}`,
      }, (payload) => {
        const updated = payload.new as { id: string; status: string; total?: number; delivery_fee?: number; eta_minutes?: number; payment_methods?: string[]; pix_key?: string };
        setPharmacyQuotes((prev) =>
          prev.map((q) =>
            q.id === updated.id
              ? { ...q, status: updated.status, total: updated.total ?? q.total, delivery_fee: updated.delivery_fee ?? q.delivery_fee, eta_minutes: updated.eta_minutes ?? q.eta_minutes, payment_methods: updated.payment_methods ?? q.payment_methods, pix_key: updated.pix_key ?? q.pix_key }
              : q
          )
        );
      })
      .subscribe();
    orderChannelRef.current = ch;
  }, []);

  // ─── Poll for active order ───────────────────────────────────────────────

  const loadActiveOrder = useCallback(async (convId: string) => {
    try {
      const res = await fetch(apiUrl(`/api/simulate/active-order/${convId}`));
      const data = await res.json();
      if (!data.order) return;

      setActiveOrder(data.order);

      // Load messages for each pharmacy conversation
      const quotesWithMessages: PharmacyQuote[] = await Promise.all(
        (data.quotes as PharmacyQuote[]).map(async (q: PharmacyQuote) => {
          if (!q.conversation_id) return { ...q, messages: [] };
          try {
            const msgRes = await fetch(apiUrl(`/api/simulate/pharmacy-messages/${q.conversation_id}`));
            const msgData = await msgRes.json();
            return { ...q, messages: msgData.messages ?? [] };
          } catch {
            return { ...q, messages: [] };
          }
        })
      );

      setPharmacyQuotes(quotesWithMessages);

      // Auto-select first pharmacy with a conversation
      if (!selectedPharmacyConvId) {
        const firstWithConv = quotesWithMessages.find((q) => q.conversation_id);
        if (firstWithConv?.conversation_id) {
          setSelectedPharmacyConvId(firstWithConv.conversation_id);
        }
      }

      subscribeToPharmacyConversations(quotesWithMessages);
      subscribeToOrderQuotes(data.order.id);

      // Switch tab to pharmacies when order appears
      if (quotesWithMessages.some((q) => q.conversation_id)) {
        setActiveTab('pharmacies');
      }
    } catch { /* ignore */ }
  }, [selectedPharmacyConvId, subscribeToPharmacyConversations, subscribeToOrderQuotes]);

  // Poll for active order every 3s after a message is sent
  const startPolling = useCallback((convId: string) => {
    if (pollTimerRef.current) clearInterval(pollTimerRef.current);
    let attempts = 0;
    const timer = setInterval(async () => {
      attempts++;
      await loadActiveOrder(convId);
      if (attempts >= 20) clearInterval(timer); // stop after 60s
    }, 3000);
    pollTimerRef.current = timer;
    return () => clearInterval(timer);
  }, [loadActiveOrder]);

  // ─── Send user message ───────────────────────────────────────────────────

  async function send(payload: Record<string, unknown>) {
    setLoading(true);
    try {
      const res = await fetch(apiUrl('/api/simulate/inbound'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone, ...payload }),
      });
      const data = await res.json();
      if (data.conversationId) {
        if (!conversationId) {
          setConversationId(data.conversationId);
          await loadConversation(phone);
        }
        startPolling(data.conversationId);
      }
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }

  async function sendText() {
    if (!input.trim()) return;
    const text = input;
    setInput('');
    await send({ contentType: 'text', text });
  }

  async function sendLocation() {
    await send({
      contentType: 'location',
      locationLat: parseFloat(latInput),
      locationLng: parseFloat(lngInput),
      locationName: 'Localização compartilhada',
    });
    setLocationMode(false);
  }

  async function sendImage(file: File) {
    const reader = new FileReader();
    reader.onload = async (e) => {
      const base64 = (e.target?.result as string).split(',')[1];
      await send({ contentType: 'image', imageBase64: base64, imageMime: file.type });
    };
    reader.readAsDataURL(file);
  }

  function handleKey(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendText(); }
  }

  // ─── Send pharmacy reply ─────────────────────────────────────────────────

  async function sendPharmacyReply() {
    if (!pharmacyInput.trim() || !selectedPharmacyConvId) return;
    const text = pharmacyInput;
    setPharmacyInput('');
    setPharmacyLoading(true);
    try {
      await fetch(apiUrl('/api/simulate/pharmacy-reply'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversationId: selectedPharmacyConvId, text }),
      });
      // Refresh messages for this conversation
      const res = await fetch(apiUrl(`/api/simulate/pharmacy-messages/${selectedPharmacyConvId}`));
      const data = await res.json();
      const msgs: Message[] = data.messages ?? [];
      setPharmacyQuotes((prev) =>
        prev.map((q) => q.conversation_id === selectedPharmacyConvId ? { ...q, messages: msgs } : q)
      );
    } catch (err) {
      console.error(err);
    } finally {
      setPharmacyLoading(false);
    }
  }

  function handlePharmacyKey(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendPharmacyReply(); }
  }

  // ─── Refresh pharmacy data ───────────────────────────────────────────────

  async function refreshPharmacies() {
    if (conversationId) await loadActiveOrder(conversationId);
  }

  // ─── Helpers ────────────────────────────────────────────────────────────

  const selectedQuote = pharmacyQuotes.find((q) => q.conversation_id === selectedPharmacyConvId);
  const activeQuoteCount = pharmacyQuotes.filter((q) => q.conversation_id).length;
  const quotedCount = pharmacyQuotes.filter((q) => q.status === 'quoted').length;

  // ─── Render ──────────────────────────────────────────────────────────────

  return (
    <div className="flex h-screen bg-wa-bg overflow-hidden">
      {/* ── Left: phone selector ─────────────────────────────────────────── */}
      <div className="w-56 bg-wa-panel border-r border-wa-border flex flex-col shrink-0">
        <div className="p-3 border-b border-wa-border">
          <p className="text-xs text-gray-400 mb-2 font-semibold uppercase tracking-wider">Número</p>
          <div className="space-y-1">
            {DEMO_PHONES.map((p) => (
              <button
                key={p}
                onClick={() => setPhone(p)}
                className={`w-full text-left px-2 py-1.5 rounded-lg text-xs transition-colors ${phone === p ? 'bg-brand-500 text-white' : 'text-gray-400 hover:bg-wa-bubble_in/50 hover:text-white'}`}
              >
                <Phone size={10} className="inline mr-1.5" />
                {p.slice(-8)}
              </button>
            ))}
          </div>
          <input
            type="text"
            placeholder="+55 XX XXXXX-XXXX"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            className="mt-2 w-full bg-wa-input border border-wa-border rounded-lg px-2 py-1 text-xs text-white placeholder-gray-500 focus:outline-none focus:border-brand-500"
          />
        </div>

        {/* Quick tips */}
        <div className="p-3 mt-1">
          <p className="text-xs text-gray-500 mb-1 font-medium">Dicas:</p>
          <ul className="text-xs text-gray-600 space-y-0.5">
            <li>• "oi" → boas vindas + LGPD</li>
            <li>• qualquer msg → aceite</li>
            <li>• "quero dipirona" → pedir</li>
            <li>• 📍 localização → cotação</li>
          </ul>
        </div>

        {/* Order status summary */}
        {activeOrder && (
          <div className="p-3 mt-auto border-t border-wa-border">
            <p className="text-xs text-gray-400 font-semibold mb-1">Pedido ativo</p>
            <p className="text-xs text-white truncate">
              {(activeOrder.items as Array<{ name: string }>).map((i) => i.name).join(', ')}
            </p>
            <div className="flex items-center gap-1 mt-1">
              <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${
                activeOrder.status === 'quoted' ? 'bg-green-700 text-green-100' :
                activeOrder.status === 'handed_off' ? 'bg-purple-700 text-purple-100' :
                activeOrder.status === 'confirming' ? 'bg-blue-700 text-blue-100' :
                'bg-yellow-700 text-yellow-100'
              }`}>
                {activeOrder.status === 'quoting' ? 'Cotando...' :
                 activeOrder.status === 'quoted' ? 'Cotado!' :
                 activeOrder.status === 'confirming' ? 'Confirmando...' :
                 activeOrder.status === 'handed_off' ? '🚀 Pedido feito!' :
                 activeOrder.status}
              </span>
              {activeOrder.status === 'quoting' && (
                <span className="text-[10px] text-gray-500">{quotedCount}/{activeQuoteCount} resp.</span>
              )}
            </div>
          </div>
        )}

        <div className="p-3 border-t border-wa-border">
          <button onClick={() => loadConversation(phone)} className="flex items-center gap-1.5 text-xs text-gray-400 hover:text-white">
            <RefreshCw size={11} /> Recarregar
          </button>
        </div>
      </div>

      {/* ── Center/Right: tab panels ──────────────────────────────────────── */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Tab bar */}
        <div className="bg-wa-panel border-b border-wa-border px-4 flex items-center gap-0 shrink-0">
          <TabButton
            active={activeTab === 'user'}
            onClick={() => setActiveTab('user')}
            icon={<Phone size={13} />}
            label="Usuário (Xarlote)"
          />
          <TabButton
            active={activeTab === 'pharmacies'}
            onClick={() => setActiveTab('pharmacies')}
            icon={<Store size={13} />}
            label={`Farmácias${activeQuoteCount > 0 ? ` (${activeQuoteCount})` : ''}`}
            badge={activeOrder?.status === 'quoting' ? quotedCount : undefined}
            badgeTotal={activeOrder?.status === 'quoting' ? activeQuoteCount : undefined}
          />
          <div className="ml-auto">
            <button onClick={refreshPharmacies} title="Atualizar farmácias" className="p-2 text-gray-500 hover:text-white transition-colors">
              <RefreshCw size={13} />
            </button>
          </div>
        </div>

        {/* ── User chat tab ─────────────────────────────────────────────── */}
        {activeTab === 'user' && (
          <div className="flex-1 flex flex-col min-h-0">
            {/* Header */}
            <div className="bg-wa-panel/60 px-4 py-2.5 flex items-center gap-3 shrink-0 border-b border-wa-border/50">
              <div className="w-8 h-8 rounded-full bg-brand-500 flex items-center justify-center text-white font-bold text-sm shrink-0">X</div>
              <div>
                <p className="text-white font-medium text-sm">Xarlote — IA da Saúde</p>
                <p className="text-xs text-green-400">online · simulador</p>
              </div>
              <div className="ml-auto text-xs text-gray-500">{phone}</div>
            </div>

            {/* Messages */}
            <div className="flex-1 overflow-y-auto scrollbar-thin px-4 py-3 space-y-1" style={{ backgroundImage: CHAT_BG }}>
              {messages.length === 0 && (
                <div className="flex items-center justify-center h-full">
                  <div className="text-center">
                    <p className="text-gray-500 text-sm">Nenhuma mensagem ainda.</p>
                    <p className="text-gray-600 text-xs mt-1">Digite uma mensagem para começar.</p>
                  </div>
                </div>
              )}
              {messages.map((msg) => <MessageBubble key={msg.id} msg={msg} />)}
              {loading && <TypingIndicator />}
              <div ref={bottomRef} />
            </div>

            {/* Location picker */}
            {locationMode && (
              <div className="bg-wa-panel border-t border-wa-border px-4 py-2.5 flex items-center gap-2 flex-wrap">
                <MapPin size={14} className="text-green-400 shrink-0" />
                <input type="text" value={latInput} onChange={(e) => setLatInput(e.target.value)} placeholder="Latitude" className="w-28 bg-wa-input border border-wa-border rounded px-2 py-1 text-xs text-white focus:outline-none" />
                <input type="text" value={lngInput} onChange={(e) => setLngInput(e.target.value)} placeholder="Longitude" className="w-28 bg-wa-input border border-wa-border rounded px-2 py-1 text-xs text-white focus:outline-none" />
                <button onClick={sendLocation} className="bg-brand-500 hover:bg-brand-600 text-white px-3 py-1 rounded text-xs font-medium">
                  Enviar
                </button>
                <button onClick={() => setLocationMode(false)} className="text-gray-500 hover:text-white text-xs">Cancelar</button>
                <span className="text-xs text-gray-500">Padrão: SP Centro (-23.5614, -46.6558)</span>
              </div>
            )}

            {/* Input bar */}
            <div className="bg-wa-panel border-t border-wa-border px-4 py-3 flex items-end gap-2 shrink-0">
              <button onClick={() => setLocationMode((v) => !v)} title="Compartilhar localização"
                className={`p-2 rounded-full transition-colors ${locationMode ? 'bg-green-600 text-white' : 'text-gray-400 hover:text-white hover:bg-wa-bubble_in'}`}>
                <MapPin size={18} />
              </button>
              <label title="Enviar imagem" className="p-2 rounded-full text-gray-400 hover:text-white hover:bg-wa-bubble_in cursor-pointer transition-colors">
                <ImageIcon size={18} />
                <input type="file" accept="image/*" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) sendImage(f); e.target.value = ''; }} />
              </label>
              <div className="flex-1 bg-wa-input border border-wa-border rounded-2xl px-4 py-2">
                <textarea value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={handleKey}
                  placeholder="Digite uma mensagem…" rows={1}
                  className="w-full bg-transparent text-white text-sm placeholder-gray-500 resize-none focus:outline-none leading-5"
                  style={{ maxHeight: '120px' }} />
              </div>
              <button onClick={sendText} disabled={loading || !input.trim()}
                className="p-2.5 rounded-full bg-brand-500 hover:bg-brand-600 text-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors shrink-0">
                <Send size={16} />
              </button>
            </div>
          </div>
        )}

        {/* ── Pharmacy tab ─────────────────────────────────────────────────── */}
        {activeTab === 'pharmacies' && (
          <div className="flex-1 flex min-h-0 overflow-hidden">
            {/* Pharmacy list (left column) */}
            <div className="w-72 bg-wa-panel border-r border-wa-border flex flex-col shrink-0 overflow-y-auto">
              {!activeOrder ? (
                <div className="flex-1 flex items-center justify-center p-6">
                  <div className="text-center">
                    <Store size={32} className="text-gray-600 mx-auto mb-3" />
                    <p className="text-gray-500 text-sm">Nenhum pedido ativo.</p>
                    <p className="text-gray-600 text-xs mt-1">Peça um medicamento na aba <strong className="text-gray-400">Usuário</strong>.</p>
                  </div>
                </div>
              ) : (
                <>
                  {/* Order info */}
                  <div className="p-3 border-b border-wa-border">
                    <p className="text-xs text-gray-400 font-semibold uppercase tracking-wider mb-1">Pedido</p>
                    <p className="text-xs text-white font-medium">
                      {(activeOrder.items as Array<{ name: string; dosage?: string }>).map((i) => `${i.name}${i.dosage ? ` ${i.dosage}` : ''}`).join(', ')}
                    </p>
                    {activeOrder.delivery_lat && (
                      <p className="text-xs text-gray-500 mt-0.5">
                        📍 {activeOrder.delivery_lat.toFixed(4)}, {activeOrder.delivery_lng?.toFixed(4)}
                      </p>
                    )}
                    <div className="flex items-center gap-2 mt-1">
                      <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${
                        activeOrder.status === 'quoted' ? 'bg-green-700 text-green-100' :
                        activeOrder.status === 'confirming' ? 'bg-blue-700 text-blue-100' :
                        activeOrder.status === 'handed_off' ? 'bg-purple-700 text-purple-100' :
                        'bg-yellow-700 text-yellow-100'
                      }`}>
                        {activeOrder.status === 'quoting' ? '⏳ Cotando' :
                         activeOrder.status === 'quoted' ? '✅ Cotado' :
                         activeOrder.status === 'confirming' ? '🔄 Confirmando' :
                         activeOrder.status === 'handed_off' ? '🚀 Pedido feito!' :
                         activeOrder.status}
                      </span>
                    </div>
                  </div>

                  {/* Pharmacy list */}
                  <div className="p-2 space-y-1">
                    {pharmacyQuotes.length === 0 && (
                      <div className="p-4 text-center">
                        <Loader2 size={20} className="animate-spin text-gray-500 mx-auto mb-2" />
                        <p className="text-xs text-gray-500">Iniciando conversas...</p>
                      </div>
                    )}
                    {pharmacyQuotes.map((q) => (
                      <PharmacyListItem
                        key={q.id}
                        quote={q}
                        isSelected={q.conversation_id === selectedPharmacyConvId}
                        onClick={() => {
                          if (q.conversation_id) setSelectedPharmacyConvId(q.conversation_id);
                        }}
                      />
                    ))}
                  </div>

                  {/* Legend */}
                  <div className="mt-auto p-3 border-t border-wa-border">
                    <p className="text-[10px] text-gray-600 font-semibold mb-1">Como usar:</p>
                    <p className="text-[10px] text-gray-600">Selecione uma farmácia e responda como se fosse o atendente dela. O agente IA processará sua resposta e continuará a negociação.</p>
                  </div>
                </>
              )}
            </div>

            {/* Selected pharmacy conversation (right column) */}
            <div className="flex-1 flex flex-col min-h-0 min-w-0">
              {!selectedQuote ? (
                <div className="flex-1 flex items-center justify-center">
                  <div className="text-center">
                    <ChevronRight size={32} className="text-gray-600 mx-auto mb-2" />
                    <p className="text-gray-500 text-sm">Selecione uma farmácia à esquerda</p>
                  </div>
                </div>
              ) : (
                <>
                  {/* Pharmacy header */}
                  <div className="bg-wa-panel/60 px-4 py-2.5 flex items-center gap-3 border-b border-wa-border/50 shrink-0">
                    <div className="w-8 h-8 rounded-full bg-orange-600 flex items-center justify-center text-white font-bold text-sm shrink-0">
                      {selectedQuote.suppliers?.name?.charAt(0) ?? 'F'}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-white font-medium text-sm truncate">{selectedQuote.suppliers?.name ?? 'Farmácia'}</p>
                      <p className="text-xs text-gray-400 truncate">{selectedQuote.suppliers?.address}</p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      {selectedQuote.suppliers?.rating && (
                        <span className="text-xs text-yellow-400">★ {selectedQuote.suppliers.rating.toFixed(1)}</span>
                      )}
                      {selectedQuote.distance_km && (
                        <span className="text-xs text-gray-500">{selectedQuote.distance_km.toFixed(1)}km</span>
                      )}
                      <StatusBadge status={selectedQuote.status} />
                    </div>
                  </div>

                  {/* Quote info (when quoted) */}
                  {selectedQuote.status === 'quoted' && selectedQuote.total != null && (
                    <div className="bg-green-900/30 border-b border-green-800/40 px-4 py-2 flex items-center gap-4 text-xs shrink-0">
                      <span className="text-green-300 font-semibold">💰 R$ {selectedQuote.total.toFixed(2)}</span>
                      {selectedQuote.delivery_fee != null && (
                        <span className="text-gray-400">Frete: {selectedQuote.delivery_fee === 0 ? 'grátis' : `R$ ${selectedQuote.delivery_fee.toFixed(2)}`}</span>
                      )}
                      {selectedQuote.eta_minutes && <span className="text-gray-400">⏱ ~{selectedQuote.eta_minutes}min</span>}
                      {selectedQuote.payment_methods?.length && <span className="text-gray-400">{selectedQuote.payment_methods.join('/')}</span>}
                    </div>
                  )}

                  {/* Messages */}
                  <div className="flex-1 overflow-y-auto scrollbar-thin px-4 py-3 space-y-1" style={{ backgroundImage: CHAT_BG }}>
                    {selectedQuote.messages.length === 0 && (
                      <div className="flex items-center justify-center h-full">
                        <div className="text-center">
                          <Loader2 size={24} className="animate-spin text-gray-500 mx-auto mb-2" />
                          <p className="text-gray-500 text-sm">Aguardando mensagem do agente...</p>
                        </div>
                      </div>
                    )}
                    {selectedQuote.messages.map((msg) => (
                      <PharmacyMessageBubble key={msg.id} msg={msg} />
                    ))}
                    {pharmacyLoading && <TypingIndicator label="Agente processando..." />}
                    <div ref={pharmacyBottomRef} />
                  </div>

                  {/* Pharmacy reply input — enabled during negotiation AND post-order confirmation */}
                  {selectedQuote.conversation_id && !['unavailable', 'timeout'].includes(selectedQuote.status) ? (
                    <div className="bg-wa-panel border-t border-wa-border px-4 py-3 flex items-end gap-2 shrink-0">
                      <div className="flex-1 bg-wa-input border border-wa-border rounded-2xl px-4 py-2">
                        <textarea
                          value={pharmacyInput}
                          onChange={(e) => setPharmacyInput(e.target.value)}
                          onKeyDown={handlePharmacyKey}
                          placeholder={`Responder como ${selectedQuote.suppliers?.name ?? 'farmácia'}…`}
                          rows={1}
                          className="w-full bg-transparent text-white text-sm placeholder-gray-500 resize-none focus:outline-none leading-5"
                          style={{ maxHeight: '100px' }}
                        />
                      </div>
                      <button
                        onClick={sendPharmacyReply}
                        disabled={pharmacyLoading || !pharmacyInput.trim()}
                        className="p-2.5 rounded-full bg-orange-600 hover:bg-orange-700 text-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors shrink-0"
                      >
                        {pharmacyLoading ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
                      </button>
                    </div>
                  ) : (
                    <div className="bg-wa-panel border-t border-wa-border px-4 py-3 shrink-0">
                      <p className="text-xs text-gray-500 text-center">
                        {selectedQuote.status === 'quoted' ? '✅ Cotação registrada — conversa finalizada.' : '⚠️ Conversa encerrada.'}
                      </p>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function TabButton({
  active, onClick, icon, label, badge, badgeTotal,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  badge?: number;
  badgeTotal?: number;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1.5 px-4 py-3 text-sm border-b-2 transition-colors ${
        active ? 'border-brand-500 text-white' : 'border-transparent text-gray-400 hover:text-white'
      }`}
    >
      {icon}
      {label}
      {badge !== undefined && badgeTotal !== undefined && (
        <span className={`text-[10px] px-1.5 py-0.5 rounded-full ml-1 ${badge === badgeTotal ? 'bg-green-700 text-green-100' : 'bg-yellow-700 text-yellow-100'}`}>
          {badge}/{badgeTotal}
        </span>
      )}
    </button>
  );
}

function PharmacyListItem({
  quote, isSelected, onClick,
}: { quote: PharmacyQuote; isSelected: boolean; onClick: () => void }) {
  const lastMsg = quote.messages.at(-1);

  return (
    <button
      onClick={onClick}
      disabled={!quote.conversation_id}
      className={`w-full text-left px-3 py-2.5 rounded-xl transition-colors ${
        isSelected ? 'bg-wa-bubble_in' : 'hover:bg-wa-bubble_in/60'
      } ${!quote.conversation_id ? 'opacity-50 cursor-not-allowed' : ''}`}
    >
      <div className="flex items-center gap-2">
        <div className="w-8 h-8 rounded-full bg-orange-700 flex items-center justify-center text-white text-xs font-bold shrink-0">
          {quote.suppliers?.name?.charAt(0) ?? 'F'}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1 justify-between">
            <span className="text-xs text-white font-medium truncate">{quote.suppliers?.name ?? 'Farmácia'}</span>
            {quote.distance_km && (
              <span className="text-[10px] text-gray-500 shrink-0">{quote.distance_km.toFixed(1)}km</span>
            )}
          </div>
          <div className="flex items-center gap-1 mt-0.5">
            <StatusBadge status={quote.status} small />
            {quote.total != null && (
              <span className="text-[10px] text-green-400 ml-1">R${quote.total.toFixed(2)}</span>
            )}
          </div>
          {lastMsg && (
            <p className="text-[10px] text-gray-500 truncate mt-0.5">
              {lastMsg.direction === 'out' ? '🤖 ' : '💬 '}
              {lastMsg.content ?? '...'}
            </p>
          )}
        </div>
        {!quote.conversation_id && (
          <Loader2 size={12} className="animate-spin text-gray-500 shrink-0" />
        )}
      </div>
    </button>
  );
}

function StatusBadge({ status, small }: { status: string; small?: boolean }) {
  const color = STATUS_COLORS[status] ?? 'bg-gray-600 text-gray-200';
  const label = STATUS_LABELS[status] ?? status;
  return (
    <span className={`${small ? 'text-[9px] px-1 py-0.5' : 'text-[10px] px-1.5 py-0.5'} rounded-full font-medium ${color}`}>
      {label}
    </span>
  );
}

function MessageBubble({ msg }: { msg: Message }) {
  const isOut = msg.direction === 'out';

  if (msg.content_type === 'location') {
    return (
      <div className={`flex ${isOut ? 'justify-end' : 'justify-start'}`}>
        <div className={`rounded-xl px-3 py-2 max-w-xs ${isOut ? 'bg-wa-bubble_out' : 'bg-wa-bubble_in'}`}>
          <div className="flex items-center gap-2">
            <MapPin size={14} className="text-green-400" />
            <span className="text-sm text-white">{msg.location_lat?.toFixed(4)}, {msg.location_lng?.toFixed(4)}</span>
          </div>
          <p className="text-xs text-gray-400 text-right mt-1">{formatTime(msg.created_at)}</p>
        </div>
      </div>
    );
  }

  return (
    <div className={`flex ${isOut ? 'justify-end' : 'justify-start'} group`}>
      {!isOut && (
        <div className="w-7 h-7 rounded-full bg-brand-500 flex items-center justify-center text-white text-xs font-bold mr-2 shrink-0 mt-auto mb-1">X</div>
      )}
      <div className={`rounded-2xl px-3 py-2 max-w-[72%] break-words ${isOut ? 'bg-wa-bubble_out rounded-br-sm' : 'bg-wa-bubble_in rounded-bl-sm'}`}>
        <p className="text-sm text-white whitespace-pre-wrap">{msg.content}</p>
        <div className="flex items-center gap-2 mt-0.5 justify-end">
          {msg.llm_model && (
            <span className="text-[10px] text-gray-500 hidden group-hover:inline">{msg.llm_model.split('/')[1] ?? msg.llm_model} · {msg.llm_latency_ms}ms</span>
          )}
          <span className="text-[10px] text-gray-400">{formatTime(msg.created_at)}</span>
          {isOut && <span className="text-[10px] text-blue-400">✓✓</span>}
        </div>
      </div>
    </div>
  );
}

function PharmacyMessageBubble({ msg }: { msg: Message }) {
  // direction 'out' = agent sent (left side), direction 'in' = pharmacy replied (right side)
  const isPharmacy = msg.direction === 'in';

  return (
    <div className={`flex ${isPharmacy ? 'justify-end' : 'justify-start'} group`}>
      {!isPharmacy && (
        <div className="w-7 h-7 rounded-full bg-indigo-600 flex items-center justify-center text-white text-xs font-bold mr-2 shrink-0 mt-auto mb-1" title="Agente IA da Saúde">
          A
        </div>
      )}
      <div className={`rounded-2xl px-3 py-2 max-w-[72%] break-words ${isPharmacy ? 'bg-orange-700/80 rounded-br-sm' : 'bg-indigo-700/80 rounded-bl-sm'}`}>
        <div className="flex items-center gap-1 mb-0.5">
          <span className="text-[10px] text-gray-300 font-medium">
            {isPharmacy ? '🏪 Farmácia' : '🤖 Agente IA'}
          </span>
        </div>
        <p className="text-sm text-white whitespace-pre-wrap">{msg.content}</p>
        <div className="flex items-center justify-end gap-1 mt-0.5">
          <span className="text-[10px] text-gray-400">{formatTime(msg.created_at)}</span>
        </div>
      </div>
      {isPharmacy && (
        <div className="w-7 h-7 rounded-full bg-orange-700 flex items-center justify-center text-white text-xs font-bold ml-2 shrink-0 mt-auto mb-1" title="Farmácia">
          🏪
        </div>
      )}
    </div>
  );
}

function TypingIndicator({ label }: { label?: string }) {
  return (
    <div className="flex justify-start items-center gap-2">
      <div className="w-7 h-7 rounded-full bg-brand-500 flex items-center justify-center text-white text-xs font-bold shrink-0">X</div>
      <div className="bg-wa-bubble_in rounded-xl px-4 py-2">
        <div className="flex gap-1 items-center h-4">
          <span className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
          <span className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
          <span className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
          {label && <span className="text-[10px] text-gray-500 ml-1">{label}</span>}
        </div>
      </div>
    </div>
  );
}

// WhatsApp-style background pattern
const CHAT_BG = `url("data:image/svg+xml,%3Csvg width='60' height='60' viewBox='0 0 60 60' xmlns='http://www.w3.org/2000/svg'%3E%3Cg fill='none' fill-rule='evenodd'%3E%3Cg fill='%23ffffff' fill-opacity='0.03'%3E%3Cpath d='M36 34v-4h-2v4h-4v2h4v4h2v-4h4v-2h-4zm0-30V0h-2v4h-4v2h4v4h2V6h4V4h-4zM6 34v-4H4v4H0v2h4v4h2v-4h4v-2H6zM6 4V0H4v4H0v2h4v4h2V6h4V4H6z'/%3E%3C/g%3E%3C%2Fg%3E%3C/svg%3E")`;
