import { db } from './client.js';
import type { User, Conversation, Message, Order, Quote, Supplier } from '@iasaude/shared';

// ─── Users ──────────────────────────────────────────────────────────────────

export async function findUserByPhone(phoneE164: string): Promise<User | null> {
  const { data } = await db
    .from('users')
    .select('*')
    .eq('phone_e164', phoneE164)
    .single();
  return data;
}

export async function upsertUser(phoneE164: string, patch: Partial<User> = {}): Promise<User> {
  const { data, error } = await db
    .from('users')
    .upsert({ phone_e164: phoneE164, ...patch }, { onConflict: 'phone_e164' })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function updateUser(id: string, patch: Partial<User>): Promise<void> {
  const { error } = await db.from('users').update(patch).eq('id', id);
  if (error) throw error;
}

// ─── Conversations ───────────────────────────────────────────────────────────

export async function findOrCreateConversation(
  instance: string,
  jid: string,
  partyType: 'user' | 'supplier',
  userId?: string | null,
  supplierId?: string | null
): Promise<Conversation> {
  const { data: existing } = await db
    .from('conversations')
    .select('*')
    .eq('whatsapp_instance', instance)
    .eq('whatsapp_jid', jid)
    .single();
  if (existing) return existing;

  const { data, error } = await db
    .from('conversations')
    .insert({
      party_type: partyType,
      user_id: userId ?? null,
      supplier_id: supplierId ?? null,
      whatsapp_instance: instance,
      whatsapp_jid: jid,
      status: 'active',
      memory_cards: [],
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function getConversationMessages(
  conversationId: string,
  limit = 30
): Promise<Message[]> {
  const { data, error } = await db
    .from('messages')
    .select('*')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []).reverse();
}

export async function insertMessage(msg: Omit<Message, 'id' | 'created_at'>): Promise<Message> {
  const { data, error } = await db.from('messages').insert(msg).select().single();
  if (error) throw error;
  return data;
}

// ─── Orders ─────────────────────────────────────────────────────────────────

export async function createOrder(order: Omit<Order, 'id' | 'created_at' | 'updated_at'>): Promise<Order> {
  const { data, error } = await db.from('orders').insert(order).select().single();
  if (error) throw error;
  return data;
}

export async function updateOrder(id: string, patch: Partial<Order>): Promise<void> {
  const { error } = await db.from('orders').update(patch).eq('id', id);
  if (error) throw error;
}

export async function getOrderWithQuotes(orderId: string): Promise<{ order: Order; quotes: Quote[] } | null> {
  const { data: order } = await db.from('orders').select('*').eq('id', orderId).single();
  if (!order) return null;
  const { data: quotes } = await db.from('quotes').select('*').eq('order_id', orderId);
  return { order, quotes: quotes ?? [] };
}

// ─── Quotes ──────────────────────────────────────────────────────────────────

export async function createQuote(quote: Omit<Quote, 'id' | 'created_at' | 'updated_at'>): Promise<Quote> {
  const { data, error } = await db.from('quotes').insert(quote).select().single();
  if (error) throw error;
  return data;
}

export async function updateQuote(id: string, patch: Partial<Quote>): Promise<void> {
  const { error } = await db.from('quotes').update(patch).eq('id', id);
  if (error) throw error;
}

// ─── Suppliers ───────────────────────────────────────────────────────────────

export async function upsertSupplier(supplier: Partial<Supplier> & { name: string }): Promise<Supplier> {
  const { data, error } = await db
    .from('suppliers')
    .upsert(supplier, { onConflict: 'google_place_id' })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function findSupplierByWhatsApp(phoneE164: string): Promise<Supplier | null> {
  const { data } = await db
    .from('suppliers')
    .select('*')
    .eq('whatsapp_e164', phoneE164)
    .eq('status', 'active')
    .single();
  return data;
}

// ─── Logs ────────────────────────────────────────────────────────────────────

export async function writeLog(
  level: string,
  category: string,
  message: string,
  meta: Record<string, unknown> = {}
): Promise<void> {
  await db.from('system_logs').insert({ level, category, message, metadata: meta });
}
