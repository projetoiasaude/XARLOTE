import { randomUUID } from 'crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { buildSimulatedInbound } from '@iasaude/whatsapp';
import { processInboundUser } from '../handlers/inbound-user.js';
import { processInboundSupplier } from '../handlers/inbound-supplier.js';
import { loadPrompts } from '../config/prompts.js';

const SimulateSchema = z.object({
  phone: z.string().min(8),
  name: z.string().optional(),
  contentType: z.enum(['text', 'image', 'audio', 'location', 'document']).default('text'),
  text: z.string().optional(),
  imageBase64: z.string().optional(),
  imageMime: z.string().optional(),
  locationLat: z.number().optional(),
  locationLng: z.number().optional(),
  locationName: z.string().optional(),
});

const PharmacyReplySchema = z.object({
  conversationId: z.string().uuid(),
  text: z.string().min(1),
});

export async function simulateRoute(app: FastifyInstance) {
  // ─── User inbound ─────────────────────────────────────────────────────────────
  app.post('/simulate/inbound', async (req, reply) => {
    const parsed = SimulateSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    // Mesmo gate do webhook real: simulador respeita o interruptor mestre.
    if (!loadPrompts().xarlote_enabled) {
      return reply.code(503).send({
        ok: false,
        skipped: 'xarlote_disabled',
        message: 'Xarlote está desligada no painel — ative o interruptor em /prompts pra voltar a responder.',
      });
    }

    const normalized = buildSimulatedInbound(parsed.data);
    const result = await processInboundUser(normalized);

    return reply.send({ ok: true, traceId: result.traceId, conversationId: result.conversationId });
  });

  // ─── User conversation history ─────────────────────────────────────────────────
  app.get('/simulate/conversation/:phone', async (req, reply) => {
    const { phone } = req.params as { phone: string };
    const phoneE164 = phone.startsWith('+') ? phone : `+${phone}`;

    const { db } = await import('@iasaude/db');
    const { data: conv } = await db
      .from('conversations')
      .select('id, memory_cards, last_message_at, user_id')
      .eq('whatsapp_instance', 'sara')
      .eq('whatsapp_jid', `${phoneE164.replace('+', '')}@s.whatsapp.net`)
      .single();

    if (!conv) return reply.send({ conversation: null, messages: [] });

    const { data: messages } = await db
      .from('messages')
      .select('*')
      .eq('conversation_id', conv.id)
      .order('created_at', { ascending: true })
      .limit(100);

    return reply.send({ conversation: conv, messages: messages ?? [] });
  });

  // ─── Active order for a user conversation ─────────────────────────────────────
  // Returns the most recent non-cancelled order + quotes with supplier & conversation info
  app.get('/simulate/active-order/:conversationId', async (req, reply) => {
    const { conversationId } = req.params as { conversationId: string };
    const { db } = await import('@iasaude/db');

    // Most recent active or recently-completed order for this user conversation
    const { data: order } = await db
      .from('orders')
      .select('id, status, items, created_at, delivery_lat, delivery_lng')
      .eq('conversation_id', conversationId)
      .not('status', 'in', '("cancelled","failed")')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!order) return reply.send({ order: null, quotes: [] });

    // Load quotes with supplier info
    const { data: quotes } = await db
      .from('quotes')
      .select(`
        id, status, total, subtotal, delivery_fee, eta_minutes,
        payment_methods, pix_key, payment_link, notes, distance_km,
        conversation_id, created_at,
        suppliers ( id, name, address, city, state, latitude, longitude, rating )
      `)
      .eq('order_id', order.id)
      .order('distance_km', { ascending: true });

    return reply.send({ order, quotes: quotes ?? [] });
  });

  // ─── Pharmacy conversation messages ───────────────────────────────────────────
  app.get('/simulate/pharmacy-messages/:conversationId', async (req, reply) => {
    const { conversationId } = req.params as { conversationId: string };
    const { db } = await import('@iasaude/db');

    const { data: messages } = await db
      .from('messages')
      .select('id, direction, sender_role, content_type, content, created_at, trace_id')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: true })
      .limit(50);

    return reply.send({ messages: messages ?? [] });
  });

  // ─── Reset: apaga toda a simulação de um número ──────────────────────────────
  // Remove user, conversations (sara + suppliers desse user), messages, orders, quotes,
  // assistant_tasks, prescriptions, addresses, conditions, allergies, medications, consents.
  // Deixa as tabelas suppliers/system_logs intactas (são compartilhadas).
  app.post('/simulate/reset', async (req, reply) => {
    const Body = z.object({ phone: z.string().min(8) });
    const parsed = Body.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

    const phoneE164 = parsed.data.phone.startsWith('+') ? parsed.data.phone : `+${parsed.data.phone}`;
    const { db } = await import('@iasaude/db');

    const { data: user } = await db.from('users').select('id').eq('phone_e164', phoneE164).maybeSingle();
    if (!user) return reply.send({ ok: true, message: 'Nenhum dado para esse número.' });

    const userId = user.id;

    // Conversations do usuário (com sara) e conversations de fornecedor ligadas a orders dele
    const { data: orders } = await db.from('orders').select('id').eq('user_id', userId);
    const orderIds = (orders ?? []).map((o) => o.id);

    const { data: quotes } = orderIds.length
      ? await db.from('quotes').select('id, conversation_id').in('order_id', orderIds)
      : { data: [] as Array<{ id: string; conversation_id: string | null }> };
    const quoteConvIds = (quotes ?? []).map((q) => q.conversation_id).filter(Boolean) as string[];

    const { data: userConvs } = await db.from('conversations').select('id').eq('user_id', userId);
    const userConvIds = (userConvs ?? []).map((c) => c.id);

    const allConvIds = Array.from(new Set([...userConvIds, ...quoteConvIds]));

    // Apaga em ordem segura (filhos antes dos pais)
    if (allConvIds.length) await db.from('messages').delete().in('conversation_id', allConvIds);
    if (orderIds.length) await db.from('quotes').delete().in('order_id', orderIds);
    if (orderIds.length) await db.from('orders').delete().in('id', orderIds);
    await db.from('assistant_tasks').delete().eq('user_id', userId);
    await db.from('prescriptions').delete().eq('user_id', userId);
    await db.from('user_addresses').delete().eq('user_id', userId);
    await db.from('user_health_conditions').delete().eq('user_id', userId);
    await db.from('user_allergies').delete().eq('user_id', userId);
    await db.from('user_medications').delete().eq('user_id', userId);
    await db.from('consent_events').delete().eq('user_id', userId);
    await db.from('reminders').delete().eq('user_id', userId);
    if (allConvIds.length) await db.from('conversations').delete().in('id', allConvIds);
    await db.from('users').delete().eq('id', userId);

    return reply.send({
      ok: true,
      removed: {
        userId,
        conversations: allConvIds.length,
        orders: orderIds.length,
        quotes: quotes?.length ?? 0,
      },
    });
  });

  // ─── Reset ALL: apaga TODOS os dados de teste ────────────────────────────────
  app.post('/simulate/reset-all', async (_req, reply) => {
    const { db } = await import('@iasaude/db');
    // Delete in dependency order (children first)
    await db.from('messages').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    await db.from('quotes').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    await db.from('orders').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    await db.from('assistant_tasks').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    await db.from('reminders').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    await db.from('consent_events').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    await db.from('user_health_conditions').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    await db.from('user_allergies').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    await db.from('user_medications').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    await db.from('user_addresses').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    await db.from('conversations').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    await db.from('users').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    await db.from('system_logs').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    return reply.send({ ok: true });
  });

  // ─── User replies as pharmacy ─────────────────────────────────────────────────
  app.post('/simulate/pharmacy-reply', async (req, reply) => {
    const parsed = PharmacyReplySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    const { conversationId, text } = parsed.data;
    const traceId = randomUUID();

    // Process the pharmacy reply through the Agent LLM pipeline
    await processInboundSupplier({
      conversationId,
      supplierPhone: 'simulated',
      text,
      traceId,
    });

    return reply.send({ ok: true, traceId });
  });

  // ─── SIMULADOR DE CLÍNICA ────────────────────────────────────────────────────
  // Lista as clínicas em negociação de uma consulta (pra você responder como cada uma)
  app.get('/simulate/clinic-conversations/:userConversationId', async (req, reply) => {
    const { userConversationId } = req.params as { userConversationId: string };
    const { db } = await import('@iasaude/db');

    // Acha a consulta ativa dessa conversa de usuário
    const { data: consultation } = await db
      .from('consultations')
      .select('id, status, specialty')
      .eq('conversation_id', userConversationId)
      .in('status', ['searching', 'quoting', 'quoted', 'confirming'])
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!consultation) return reply.send({ consultation: null, clinics: [] });

    // Cotações + clínica + conversa
    const { data: quotes } = await db
      .from('consultation_quotes')
      .select('id, status, conversation_id, proposed_datetime, price_brl, clinic_id, clinics(name, phone_e164)')
      .eq('consultation_id', consultation.id)
      .order('created_at', { ascending: true });

    const clinics = (quotes ?? []).map((q: any) => ({
      quote_id: q.id,
      status: q.status,
      conversation_id: q.conversation_id,
      clinic_name: q.clinics?.name ?? 'Clínica',
      clinic_phone: q.clinics?.phone_e164 ?? null,
      proposed_datetime: q.proposed_datetime,
      price_brl: q.price_brl,
    }));

    return reply.send({ consultation, clinics });
  });

  // Mensagens de uma conversa de clínica específica
  app.get('/simulate/clinic-messages/:conversationId', async (req, reply) => {
    const { conversationId } = req.params as { conversationId: string };
    const { db } = await import('@iasaude/db');
    const { data: messages } = await db
      .from('messages')
      .select('id, direction, sender_role, content_type, content, created_at, trace_id')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: true })
      .limit(50);
    return reply.send({ messages: messages ?? [] });
  });

  // Você responde como a clínica → processa pela pipeline do agent-clinic
  app.post('/simulate/clinic-reply', async (req, reply) => {
    const Body = z.object({ conversationId: z.string().uuid(), text: z.string().min(1) });
    const parsed = Body.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

    const { conversationId, text } = parsed.data;
    const traceId = randomUUID();
    const { processInboundClinic } = await import('../handlers/agent-clinic.js');
    await processInboundClinic({ conversationId, clinicPhone: 'simulated', text, traceId });
    return reply.send({ ok: true, traceId });
  });
}
