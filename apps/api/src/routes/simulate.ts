import { randomUUID } from 'crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { buildSimulatedInbound } from '@iasaude/whatsapp';
import { processInboundUser } from '../handlers/inbound-user.js';
import { processInboundSupplier } from '../handlers/inbound-supplier.js';

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
}
