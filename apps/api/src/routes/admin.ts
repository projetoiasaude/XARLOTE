import type { FastifyInstance } from 'fastify';
import { db, writeAudit } from '@iasaude/db';
import { loadPrompts, savePrompts } from '../config/prompts.js';
import { buildXarloteSystemPrompt, buildAgentPharmacySystemPrompt } from '@iasaude/llm';

/** Redacta valores sensíveis em config — não loga keys cruas no audit_log */
function redactConfig(cfg: Record<string, unknown>): Record<string, unknown> {
  const out = { ...cfg };
  for (const k of Object.keys(out)) {
    if (k.endsWith('_api_key') || k.endsWith('_token') || k.endsWith('_secret')) {
      const v = out[k];
      if (typeof v === 'string' && v.length > 0) {
        out[k] = v.slice(0, 8) + '…(redacted)';
      }
    }
  }
  return out;
}

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

  // Set/update emergency contact (usado pelo dashboard pra cadastro manual)
  app.patch<{ Params: { id: string }; Body: { emergency_contact_name?: string; emergency_contact_phone_e164?: string; emergency_contact_relation?: string } }>(
    '/users/:id/emergency-contact',
    async (req, reply) => {
      const { id } = req.params;
      const { emergency_contact_name, emergency_contact_phone_e164, emergency_contact_relation } = req.body ?? {};

      if (emergency_contact_phone_e164 && !emergency_contact_phone_e164.startsWith('+')) {
        return reply.code(400).send({ error: 'phone deve estar em formato E.164 (com +)' });
      }

      const { error } = await db.from('users').update({
        emergency_contact_name: emergency_contact_name?.trim().slice(0, 120) ?? null,
        emergency_contact_phone_e164: emergency_contact_phone_e164 ?? null,
        emergency_contact_relation: emergency_contact_relation?.trim().slice(0, 40) ?? null,
      }).eq('id', id);

      if (error) return reply.code(500).send({ error: error.message });
      return reply.send({ ok: true });
    },
  );

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
    const sara = buildXarloteSystemPrompt({
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

  // Update prompts config (com audit log)
  app.put('/prompts', async (req, reply) => {
    const body = req.body as Record<string, unknown>;
    const before = loadPrompts();
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
      tts_speed: typeof body['tts_speed'] === 'number' ? (body['tts_speed'] as number) : undefined,
    });
    // Audit: diff before/after, com keys redactadas
    const beforeRedacted = redactConfig(before as unknown as Record<string, unknown>);
    const afterRedacted = redactConfig(updated as unknown as Record<string, unknown>);
    const changedKeys = Object.keys(afterRedacted).filter((k) => JSON.stringify(beforeRedacted[k]) !== JSON.stringify(afterRedacted[k]));
    await writeAudit({
      actorType: 'admin',
      action: 'prompts.config.updated',
      reason: 'dashboard_save',
      before: Object.fromEntries(changedKeys.map((k) => [k, beforeRedacted[k]])),
      after: Object.fromEntries(changedKeys.map((k) => [k, afterRedacted[k]])),
      metadata: { changed_keys: changedKeys },
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
  // Body opcional: { fullFlow: true } também deleta msgs da conversa e
  // volta status pra 'not_started' (passa pelo consent + nome de novo).
  app.post('/users/:id/reset-audio-intro', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { fullFlow?: boolean };

    const { data: user } = await db.from('users').select('id, metadata').eq('id', id).single();
    if (!user) return reply.code(404).send({ error: 'user not found' });
    const meta = (user.metadata as Record<string, unknown> | null) ?? {};
    delete meta['audio_intro_sent'];
    delete meta['audio_intro_at'];

    const updates: Record<string, unknown> = { metadata: meta };
    let deletedMessages = 0;
    if (body.fullFlow) {
      // Apaga msgs e enriquecimento ligado a esse user — força fluxo zerado
      updates['onboarding_status'] = 'not_started';
      updates['preferred_name'] = null;
      const { data: convs } = await db.from('conversations').select('id').eq('user_id', id);
      const convIds = (convs ?? []).map((c) => c.id);
      for (const cid of convIds) {
        const { count } = await db.from('messages').delete({ count: 'exact' }).eq('conversation_id', cid);
        deletedMessages += count ?? 0;
      }
      await db.from('memory_cards_index').delete().eq('user_id', id);
    }
    const { error } = await db.from('users').update(updates).eq('id', id);
    if (error) return reply.code(500).send({ error: error.message });
    return reply.send({ ok: true, userId: id, deletedMessages, fullFlow: !!body.fullFlow });
  });

  // Preview rápido — sintetiza um texto curto e devolve o MP3 (audio/mpeg).
  // Usa voice_id/model do body se vier, senão cai pro default do prompts.json.
  app.post('/tts/test', async (req, reply) => {
    const cfg = loadPrompts();
    const apiKey = cfg.tts_api_key || process.env['ELEVENLABS_API_KEY'] || '';
    if (!apiKey) return reply.code(400).send({ error: 'ElevenLabs API key não configurada' });

    const body = (req.body ?? {}) as { text?: string; voiceId?: string; modelId?: string; name?: string; speed?: number };
    const greetingName = (body.name || 'Hiago').trim();
    const text = (body.text && body.text.trim().length > 0)
      ? body.text.trim()
      : `Prazer ${greetingName}! Me conta, como posso te ajudar hoje? Quer cotar algum remédio, tirar uma dúvida, o que posso fazer por você hoje?`;

    try {
      const { synthesizeSpeech } = await import('@iasaude/integrations');
      const result = await synthesizeSpeech(text, {
        apiKey,
        voiceId: body.voiceId || cfg.tts_voice_id,
        modelId: body.modelId || cfg.tts_model,
        languageCode: 'pt',
        speed: typeof body.speed === 'number' ? body.speed : cfg.tts_speed,
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

  // Audit log — mudanças de estado em entidades (LGPD, debug, melhoria contínua)
  app.get('/audit', async (req, reply) => {
    const q = req.query as Record<string, string>;
    const limit = Math.min(parseInt(q['limit'] ?? '100'), 500);
    const userId = q['user_id'];
    const action = q['action'];      // ex: 'user.onboarding.advanced'
    const actorType = q['actor_type'];
    const traceId = q['trace_id'];
    const targetTable = q['target_table'];

    let query = db.from('audit_log').select('*').order('occurred_at', { ascending: false }).limit(limit);
    if (userId) query = query.eq('user_id', userId);
    if (action) query = query.ilike('action', `${action}%`); // prefix match
    if (actorType) query = query.eq('actor_type', actorType);
    if (traceId) query = query.eq('trace_id', traceId);
    if (targetTable) query = query.eq('target_table', targetTable);

    const { data, error } = await query;
    if (error) return reply.code(500).send({ error: error.message });
    return reply.send(data);
  });

  // ─── Timeline unificada — audit_log + event_log + system_logs ──────────────
  // Pra acompanhar EM TEMPO REAL cada decisão/ação da IA num feed só.
  // Cada item normalizado: { source, ts, level, actor, title, detail, trace_id, user_id }
  app.get('/timeline', async (req, reply) => {
    const q = req.query as Record<string, string>;
    const limit = Math.min(parseInt(q['limit'] ?? '120'), 400);
    const userId = q['user_id'];
    const sinceId = q['since_log_id']; // pra polling incremental dos system_logs

    // Busca as 3 fontes em paralelo
    const [auditRes, eventRes, logRes] = await Promise.all([
      (() => {
        let aq = db.from('audit_log')
          .select('id, occurred_at, actor_type, action, reason, metadata, before, after, trace_id, user_id, target_table, target_id')
          .order('occurred_at', { ascending: false }).limit(limit);
        if (userId) aq = aq.eq('user_id', userId);
        return aq;
      })(),
      (() => {
        let eq = db.from('event_log')
          .select('id, occurred_at, event_name, severity, duration_ms, payload, trace_id, user_id')
          .order('occurred_at', { ascending: false }).limit(limit);
        if (userId) eq = eq.eq('user_id', userId);
        return eq;
      })(),
      (() => {
        let lq = db.from('system_logs')
          .select('id, created_at, level, category, message, metadata, trace_id')
          .order('created_at', { ascending: false }).limit(limit);
        return lq;
      })(),
    ]);

    interface TimelineItem {
      source: 'audit' | 'event' | 'log';
      uid: string;
      ts: string;
      level: string;
      actor: string;
      title: string;
      detail: Record<string, unknown> | null;
      trace_id: string | null;
      user_id: string | null;
    }

    const items: TimelineItem[] = [];

    for (const a of auditRes.data ?? []) {
      items.push({
        source: 'audit', uid: `a${a.id}`, ts: a.occurred_at,
        level: String(a.action).includes('red_flag') || String(a.action).includes('failed') ? 'critical' : 'state',
        actor: a.actor_type, title: a.action,
        detail: { reason: a.reason, before: a.before, after: a.after, metadata: a.metadata, target: a.target_table ? `${a.target_table}/${a.target_id ?? ''}` : null },
        trace_id: a.trace_id, user_id: a.user_id,
      });
    }
    for (const e of eventRes.data ?? []) {
      items.push({
        source: 'event', uid: `e${e.id}`, ts: e.occurred_at,
        level: e.severity, actor: 'system', title: e.event_name,
        detail: { duration_ms: e.duration_ms, payload: e.payload },
        trace_id: e.trace_id, user_id: e.user_id,
      });
    }
    for (const l of logRes.data ?? []) {
      // Filtra ruído: debug logs não entram na timeline (poluem)
      if (l.level === 'debug') continue;
      items.push({
        source: 'log', uid: `l${l.id}`, ts: l.created_at,
        level: l.level, actor: l.category, title: l.message,
        detail: l.metadata && Object.keys(l.metadata).length ? l.metadata : null,
        trace_id: l.trace_id, user_id: null,
      });
    }

    // Ordena por timestamp desc, corta no limit
    items.sort((x, y) => new Date(y.ts).getTime() - new Date(x.ts).getTime());

    return reply.send(items.slice(0, limit));
  });

  // Audit log agregado — útil pro dashboard mostrar "ações por dia"
  app.get('/audit/summary', async (req, reply) => {
    const q = req.query as Record<string, string>;
    const days = Math.min(parseInt(q['days'] ?? '7'), 90);
    const { data, error } = await db
      .from('audit_log')
      .select('action, actor_type, occurred_at')
      .gte('occurred_at', new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString());
    if (error) return reply.code(500).send({ error: error.message });

    // Agrupa por action no app (Supabase não tem GROUP BY trivial via REST)
    const byAction = new Map<string, number>();
    const byActor = new Map<string, number>();
    for (const row of (data ?? []) as Array<{ action: string; actor_type: string }>) {
      byAction.set(row.action, (byAction.get(row.action) ?? 0) + 1);
      byActor.set(row.actor_type, (byActor.get(row.actor_type) ?? 0) + 1);
    }
    return reply.send({
      total: data?.length ?? 0,
      by_action: Object.fromEntries(byAction),
      by_actor: Object.fromEntries(byActor),
      window_days: days,
    });
  });

  // Event log — telemetria/observabilidade granular
  app.get('/events', async (req, reply) => {
    const q = req.query as Record<string, string>;
    const limit = Math.min(parseInt(q['limit'] ?? '200'), 1000);
    const eventName = q['event_name'];
    const severity = q['severity'];
    const userId = q['user_id'];
    const traceId = q['trace_id'];

    let query = db.from('event_log').select('*').order('occurred_at', { ascending: false }).limit(limit);
    if (eventName) query = query.ilike('event_name', `${eventName}%`);
    if (severity) query = query.eq('severity', severity);
    if (userId) query = query.eq('user_id', userId);
    if (traceId) query = query.eq('trace_id', traceId);

    const { data, error } = await query;
    if (error) return reply.code(500).send({ error: error.message });
    return reply.send(data);
  });

  // ─── Treatments (admin view) ─────────────────────────────────────────────
  app.get('/treatments', async (req, reply) => {
    const q = req.query as Record<string, string>;
    const limit = Math.min(parseInt(q['limit'] ?? '100'), 500);
    const status = q['status'] ?? 'active';

    let query = db
      .from('treatments')
      .select('id, user_id, name, status, condition_id, started_at, ended_at, users(full_name, preferred_name), user_health_conditions(name)')
      .order('started_at', { ascending: false })
      .limit(limit);

    if (status && status !== 'all') {
      query = query.eq('status', status);
    }

    const { data, error } = await query;
    if (error) {
      // Tabela ainda não existe (migration 0003 não rodou) → devolve vazio
      if (error.message?.includes('does not exist')) return reply.send([]);
      return reply.code(500).send({ error: error.message });
    }

    const ids = (data ?? []).map((t: any) => t.id);
    let medCounts: Record<string, number> = {};
    let inventoryFlags: Record<string, boolean> = {};
    let adherenceMap: Record<string, number | null> = {};

    if (ids.length > 0) {
      const { data: meds } = await db.from('user_medications').select('treatment_id').in('treatment_id', ids);
      medCounts = (meds ?? []).reduce((acc: Record<string, number>, m: any) => {
        if (m.treatment_id) acc[m.treatment_id] = (acc[m.treatment_id] ?? 0) + 1;
        return acc;
      }, {});

      const userIds = Array.from(new Set((data ?? []).map((t: any) => t.user_id)));
      const { data: usersWithScore } = await db.from('users').select('id, adherence_score_30d').in('id', userIds);
      adherenceMap = (usersWithScore ?? []).reduce((acc: Record<string, number | null>, u: any) => {
        acc[u.id] = u.adherence_score_30d ?? null;
        return acc;
      }, {});

      // Inventory low check
      const { data: invs } = await db
        .from('medication_inventory')
        .select('treatment_id')
        .in('treatment_id', ids)
        .not('reorder_offered_at', 'is', null);
      inventoryFlags = (invs ?? []).reduce((acc: Record<string, boolean>, i: any) => {
        if (i.treatment_id) acc[i.treatment_id] = true;
        return acc;
      }, {});
    }

    const result = (data ?? []).map((t: any) => ({
      id: t.id,
      user_id: t.user_id,
      user_name: t.users?.preferred_name ?? t.users?.full_name ?? null,
      name: t.name,
      status: t.status,
      condition_name: t.user_health_conditions?.name ?? null,
      started_at: t.started_at,
      ended_at: t.ended_at,
      medication_count: medCounts[t.id] ?? 0,
      adherence_score_30d: adherenceMap[t.user_id] ?? null,
      inventory_low: inventoryFlags[t.id] ?? false,
    }));

    return reply.send(result);
  });

  // ─── Consultations (admin view) ──────────────────────────────────────────
  app.get('/consultations', async (req, reply) => {
    const q = req.query as Record<string, string>;
    const limit = Math.min(parseInt(q['limit'] ?? '100'), 500);
    const status = q['status'] ?? 'active';

    let query = db
      .from('consultations')
      .select('id, user_id, status, specialty, urgency, modality, city, scheduled_at, scheduled_clinic_id, user_rating, created_at, users(full_name, preferred_name), clinics:scheduled_clinic_id(name)')
      .order('created_at', { ascending: false })
      .limit(limit);

    if (status === 'active') {
      query = query.in('status', ['searching', 'quoting', 'quoted', 'confirming']);
    } else if (status === 'scheduled') {
      query = query.eq('status', 'scheduled');
    } else if (status === 'completed') {
      query = query.eq('status', 'completed');
    }
    // 'all' → sem filtro

    const { data, error } = await query;
    if (error) {
      if (error.message?.includes('does not exist')) return reply.send([]);
      return reply.code(500).send({ error: error.message });
    }

    const ids = (data ?? []).map((c: any) => c.id);
    const quotesByConsult: Record<string, { offered: number; total: number }> = {};
    if (ids.length > 0) {
      const { data: quotes } = await db
        .from('consultation_quotes')
        .select('consultation_id, status')
        .in('consultation_id', ids);
      for (const q of quotes ?? []) {
        const cid = (q as any).consultation_id;
        if (!cid) continue;
        if (!quotesByConsult[cid]) quotesByConsult[cid] = { offered: 0, total: 0 };
        quotesByConsult[cid].total++;
        if ((q as any).status === 'offered') quotesByConsult[cid].offered++;
      }
    }

    const result = (data ?? []).map((c: any) => ({
      id: c.id,
      user_id: c.user_id,
      user_name: c.users?.preferred_name ?? c.users?.full_name ?? null,
      status: c.status,
      specialty: c.specialty,
      urgency: c.urgency,
      modality: c.modality,
      city: c.city,
      scheduled_at: c.scheduled_at,
      scheduled_clinic_name: c.clinics?.name ?? null,
      user_rating: c.user_rating,
      quotes_offered: quotesByConsult[c.id]?.offered ?? 0,
      quotes_total: quotesByConsult[c.id]?.total ?? 0,
      created_at: c.created_at,
    }));

    return reply.send(result);
  });

  // ─── Clinics directory ───────────────────────────────────────────────────
  app.get('/clinics', async (req, reply) => {
    const q = req.query as Record<string, string>;
    const limit = Math.min(parseInt(q['limit'] ?? '200'), 1000);

    const { data, error } = await db
      .from('clinics')
      .select('id, name, type, specialties, city, state, address, phone_e164, whatsapp_e164, rating, total_consultations, response_rate, last_contacted_at, blacklist_reason, created_at')
      .order('total_consultations', { ascending: false })
      .limit(limit);

    if (error) {
      if (error.message?.includes('does not exist')) return reply.send([]);
      return reply.code(500).send({ error: error.message });
    }
    return reply.send(data);
  });

  // ─── Daily metrics ───────────────────────────────────────────────────────
  app.get('/metrics', async (req, reply) => {
    const q = req.query as Record<string, string>;
    const days = Math.min(parseInt(q['days'] ?? '14'), 90);

    const { data, error } = await db
      .from('daily_metrics')
      .select('*')
      .order('day', { ascending: false })
      .limit(days);

    if (error) {
      if (error.message?.includes('does not exist')) return reply.send([]);
      return reply.code(500).send({ error: error.message });
    }
    return reply.send(data);
  });

  // System logs (existente)
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
