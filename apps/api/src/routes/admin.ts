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

  // Get user profile 360 (now: + memória semântica + lembretes ativos + adesão)
  app.get<{ Params: { id: string } }>('/users/:id', async (req, reply) => {
    const { id } = req.params;
    const [u, cond, allg, meds, addr, ords, mem, rem] = await Promise.all([
      db.from('users').select('*').eq('id', id).single(),
      db.from('user_health_conditions').select('*').eq('user_id', id).eq('active', true).order('created_at', { ascending: false }),
      db.from('user_allergies').select('*').eq('user_id', id).order('created_at', { ascending: false }),
      db.from('user_medications').select('*').eq('user_id', id).eq('active', true).order('created_at', { ascending: false }),
      db.from('user_addresses').select('*').eq('user_id', id).order('created_at', { ascending: false }),
      db.from('orders').select('id, status, items, created_at').eq('user_id', id).order('created_at', { ascending: false }).limit(10),
      // memory_cards_index pode não existir se a migration não rodou — try/catch tolerante
      db.from('memory_cards_index').select('id, kind, text, tags, confidence, source, last_seen_at, created_at').eq('user_id', id).order('last_seen_at', { ascending: false }).limit(80).then((r) => r, () => ({ data: [] as unknown[], error: null })),
      db.from('reminders').select('id, type, title, body, scheduled_at, rrule, next_run_at, status, medication_id, created_at').eq('user_id', id).in('status', ['pending', 'sent', 'snoozed']).order('next_run_at', { ascending: true, nullsFirst: false }).limit(50),
    ]);
    if (!u.data) return reply.code(404).send({ error: 'Not found' });
    return reply.send({
      user: u.data,
      conditions: cond.data ?? [],
      allergies: allg.data ?? [],
      medications: meds.data ?? [],
      addresses: addr.data ?? [],
      recentOrders: ords.data ?? [],
      memoryCards: mem.data ?? [],
      reminders: rem.data ?? [],
    });
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
    const body = req.body as Record<string, unknown>;
    const updated = savePrompts({
      sara_suffix: typeof body['sara_suffix'] === 'string' ? (body['sara_suffix'] as string) : undefined,
      agent_override: typeof body['agent_override'] === 'string' ? (body['agent_override'] as string) : undefined,
      llm_api_key: typeof body['llm_api_key'] === 'string' ? (body['llm_api_key'] as string) : undefined,
      llm_model: typeof body['llm_model'] === 'string' ? (body['llm_model'] as string) : undefined,
      vision_model: typeof body['vision_model'] === 'string' ? (body['vision_model'] as string) : undefined,
      audio_model: typeof body['audio_model'] === 'string' ? (body['audio_model'] as string) : undefined,
      xarlote_enabled: typeof body['xarlote_enabled'] === 'boolean' ? (body['xarlote_enabled'] as boolean) : undefined,
      tts_enabled: typeof body['tts_enabled'] === 'boolean' ? (body['tts_enabled'] as boolean) : undefined,
      tts_api_key: typeof body['tts_api_key'] === 'string' ? (body['tts_api_key'] as string) : undefined,
      tts_voice_id: typeof body['tts_voice_id'] === 'string' ? (body['tts_voice_id'] as string) : undefined,
      tts_model: typeof body['tts_model'] === 'string' ? (body['tts_model'] as string) : undefined,
    });
    return reply.send(updated);
  });

  // List voices disponíveis na conta ElevenLabs (usa key do prompts.json ou .env)
  app.get('/tts/voices', async (_req, reply) => {
    const cfg = loadPrompts();
    const apiKey = cfg.tts_api_key || process.env['ELEVENLABS_API_KEY'] || '';
    if (!apiKey) return reply.send({ voices: [], error: 'sem_api_key' });
    const { listVoices } = await import('@iasaude/integrations');
    const voices = await listVoices(apiKey);
    return reply.send({ voices });
  });

  // Reseta a flag `audio_intro_sent` de um user pra ele receber o áudio na próxima msg.
  // Útil quando o gatilho falhou (deploy sem TTS, erro LLM no turno crítico, etc).
  app.post('/users/:id/reset-audio-intro', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { data: user } = await db.from('users').select('id, metadata').eq('id', id).single();
    if (!user) return reply.code(404).send({ error: 'user not found' });
    const meta = (user.metadata as Record<string, unknown> | null) ?? {};
    delete meta['audio_intro_sent'];
    delete meta['audio_intro_at'];
    const { error } = await db.from('users').update({ metadata: meta }).eq('id', id);
    if (error) return reply.code(500).send({ error: error.message });
    return reply.send({ ok: true, userId: id });
  });

  // Preview rápido — sintetiza um texto curto e devolve o MP3 (audio/mpeg).
  // Usa voice_id/model do body se vier, senão cai pro default do prompts.json.
  app.post('/tts/test', async (req, reply) => {
    const cfg = loadPrompts();
    const apiKey = cfg.tts_api_key || process.env['ELEVENLABS_API_KEY'] || '';
    if (!apiKey) return reply.code(400).send({ error: 'ElevenLabs API key não configurada' });

    const body = (req.body ?? {}) as { text?: string; voiceId?: string; modelId?: string; name?: string };
    const greetingName = (body.name || 'Hiago').trim();
    const text = (body.text && body.text.trim().length > 0)
      ? body.text.trim()
      : `Prazer, ${greetingName}! Me conta, o que você precisa hoje? Quer ajuda com algum remédio, dúvida de saúde, ou algo nesse sentido?`;

    try {
      const { synthesizeSpeech } = await import('@iasaude/integrations');
      const result = await synthesizeSpeech(text, {
        apiKey,
        voiceId: body.voiceId || cfg.tts_voice_id,
        modelId: body.modelId || cfg.tts_model,
        languageCode: 'pt',
        timeoutMs: 30_000,
      });
      reply.header('Content-Type', result.mime);
      reply.header('X-TTS-Model', result.model);
      reply.header('X-TTS-Voice', result.voiceId);
      reply.header('X-TTS-Chars', String(result.charsBilled));
      return reply.send(result.buffer);
    } catch (err) {
      return reply.code(502).send({ error: String(err).slice(0, 300) });
    }
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

  // Debug: lista os últimos webhook_events crus, pra inspecionar payloads
  // (especialmente útil quando algo chega da uazapi e não é reconhecido pelo normalize).
  app.get('/webhook-events', async (req, reply) => {
    const q = req.query as Record<string, string>;
    const limit = parseInt(q['limit'] ?? '20');
    const { data, error } = await db
      .from('webhook_events')
      .select('id, provider, instance, event_type, external_event_id, raw, received_at')
      .order('received_at', { ascending: false })
      .limit(limit);
    if (error) return reply.code(500).send({ error: error.message });
    return reply.send(data);
  });
}
