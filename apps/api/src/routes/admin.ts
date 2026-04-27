import type { FastifyInstance } from 'fastify';
import { db } from '@iasaude/db';
import { loadPrompts, savePrompts } from '../config/prompts.js';
import { buildSaraSystemPrompt, buildAgentPharmacySystemPrompt } from '@iasaude/llm';

export async function adminRoute(app: FastifyInstance) {
  // List conversations with pagination
  app.get('/conversations', async (req, reply) => {
    const q = req.query as Record<string, string>;
    const page = parseInt(q['page'] ?? '0');
    const limit = parseInt(q['limit'] ?? '20');

    const { data, error } = await db
      .from('conversations')
      .select('*, users(preferred_name, full_name, phone_e164)')
      .eq('party_type', 'user')
      .order('last_message_at', { ascending: false, nullsFirst: false })
      .range(page * limit, (page + 1) * limit - 1);

    if (error) return reply.code(500).send({ error: error.message });
    return reply.send(data);
  });

  // List active orders
  app.get('/orders', async (req, reply) => {
    const q = req.query as Record<string, string>;
    const status = q['status'];

    let query = db.from('orders').select('*, users(preferred_name, phone_e164)').order('created_at', { ascending: false }).limit(50);
    if (status) query = query.eq('status', status);

    const { data, error } = await query;
    if (error) return reply.code(500).send({ error: error.message });
    return reply.send(data);
  });

  // Get order with all quotes
  app.get<{ Params: { id: string } }>('/orders/:id', async (req, reply) => {
    const { id } = req.params;
    const { data: order } = await db.from('orders').select('*').eq('id', id).single();
    if (!order) return reply.code(404).send({ error: 'Not found' });

    const { data: quotes } = await db
      .from('quotes')
      .select('*, suppliers(name, whatsapp_e164)')
      .eq('order_id', id);

    return reply.send({ order, quotes: quotes ?? [] });
  });

  // List users
  app.get('/users', async (req, reply) => {
    const q = req.query as Record<string, string>;
    const limit = parseInt(q['limit'] ?? '50');
    const { data, error } = await db
      .from('users')
      .select('id, phone_e164, preferred_name, full_name, onboarding_status, lgpd_consent_at, created_at')
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) return reply.code(500).send({ error: error.message });
    return reply.send(data);
  });

  // Get user profile 360
  app.get<{ Params: { id: string } }>('/users/:id', async (req, reply) => {
    const { id } = req.params;
    const [u, cond, allg, meds, addr, ords] = await Promise.all([
      db.from('users').select('*').eq('id', id).single(),
      db.from('user_health_conditions').select('*').eq('user_id', id).eq('active', true),
      db.from('user_allergies').select('*').eq('user_id', id),
      db.from('user_medications').select('*').eq('user_id', id).eq('active', true),
      db.from('user_addresses').select('*').eq('user_id', id),
      db.from('orders').select('id, status, items, created_at').eq('user_id', id).order('created_at', { ascending: false }).limit(10),
    ]);
    if (!u.data) return reply.code(404).send({ error: 'Not found' });
    return reply.send({ user: u.data, conditions: cond.data ?? [], allergies: allg.data ?? [], medications: meds.data ?? [], addresses: addr.data ?? [], recentOrders: ords.data ?? [] });
  });

  // List suppliers
  app.get('/suppliers', async (req, reply) => {
    const q = req.query as Record<string, string>;
    const status = q['status'];
    let query = db.from('suppliers').select('*').order('created_at', { ascending: false }).limit(100);
    if (status) query = query.eq('status', status);
    const { data, error } = await query;
    if (error) return reply.code(500).send({ error: error.message });
    return reply.send(data);
  });

  // Get prompts config
  app.get('/prompts', async (_req, reply) => {
    return reply.send(loadPrompts());
  });

  // Get the BASE prompts (read-only preview) — used by the dashboard so admins can
  // see what they're customizing on top of. Renders with placeholder context.
  app.get('/prompts/base', async (_req, reply) => {
    const sara = buildSaraSystemPrompt({
      preferredName: '{{nome do usuário}}',
      conditions: ['{{condição}}'],
      allergies: ['{{alergia}}'],
      medications: ['{{medicamento}}'],
      addresses: [],
      memoryCards: [],
      activeOrderSummary: null,
    });
    const agentQuoting = buildAgentPharmacySystemPrompt({
      items: [{ name: '{{medicamento}}', dosage: '{{dosagem}}', quantity: '{{quantidade}}', substitutes_ok: true }],
      neighborhoodCity: '{{bairro, cidade}}',
    });
    const agentConfirmation = buildAgentPharmacySystemPrompt({
      items: [{ name: '{{medicamento}}', dosage: '{{dosagem}}', quantity: '{{quantidade}}', substitutes_ok: true }],
      neighborhoodCity: '{{bairro, cidade}}',
      isOrderConfirmation: true,
    });
    return reply.send({ sara, agent_quoting: agentQuoting, agent_confirmation: agentConfirmation });
  });

  // Update prompts config
  app.put('/prompts', async (req, reply) => {
    const body = req.body as Record<string, string>;
    const updated = savePrompts({
      sara_suffix: typeof body['sara_suffix'] === 'string' ? body['sara_suffix'] : undefined,
      agent_override: typeof body['agent_override'] === 'string' ? body['agent_override'] : undefined,
      llm_api_key: typeof body['llm_api_key'] === 'string' ? body['llm_api_key'] : undefined,
      llm_model: typeof body['llm_model'] === 'string' ? body['llm_model'] : undefined,
    });
    return reply.send(updated);
  });

  // Reset all dev/test data — messages, conversations, orders, quotes, users, logs
  app.post('/reset-dev', async (_req, reply) => {
    const uuidTables = ['assistant_tasks', 'consent_events', 'reminders', 'prescriptions', 'quotes', 'messages', 'orders', 'conversations', 'users'];
    const bigintTables = ['system_logs'];
    for (const table of bigintTables) {
      const { error } = await db.from(table as any).delete().gt('id', 0);
      if (error) return reply.code(500).send({ error: `Failed on ${table}: ${error.message}` });
    }
    for (const table of uuidTables) {
      const { error } = await db.from(table as any).delete().neq('id', '00000000-0000-0000-0000-000000000000');
      if (error) return reply.code(500).send({ error: `Failed on ${table}: ${error.message}` });
    }
    return reply.send({ ok: true, cleared: [...bigintTables, ...uuidTables] });
  });

  // System logs
  app.get('/logs', async (req, reply) => {
    const q = req.query as Record<string, string>;
    const limit = parseInt(q['limit'] ?? '100');
    const level = q['level'];

    let query = db
      .from('system_logs')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit);

    if (level) query = query.eq('level', level);

    const { data, error } = await query;
    if (error) return reply.code(500).send({ error: error.message });
    return reply.send(data);
  });
}
