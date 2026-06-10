import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db, findUserByPhone, writeEvent } from '@iasaude/db';
import { buildSimulatedInbound } from '@iasaude/whatsapp';
import { SARA_INSTANCE } from '@iasaude/shared';
import { processInboundUser } from '../handlers/inbound-user.js';
import { loadPrompts } from '../config/prompts.js';
import { requireAdminToken } from '../middleware/auth.js';

/**
 * Rotas do XARLOTE APP (cliente final) — chat espelhado do WhatsApp + saúde 360 +
 * lembretes + atividade. Diferente do /api/simulate (ferramenta de dev, 404 em prod),
 * estas rotas são DE PRODUTO e ficam ativas em produção.
 *
 * Auth: mesmo token compartilhado do dashboard (F0). Quando nascer a auth de usuário
 * final (Supabase Auth + OTP via WhatsApp), troca-se só este preHandler.
 */

function normalizePhone(raw: string): string {
  const trimmed = raw.replace(/[^\d+]/g, '');
  return trimmed.startsWith('+') ? trimmed : `+${trimmed}`;
}

const InboundSchema = z.object({
  phone: z.string().min(8),
  text: z.string().min(1).max(4000),
});

const ReminderActionSchema = z.object({
  phone: z.string().min(8),
  action: z.enum(['done', 'snooze', 'cancel']),
  minutes: z.number().int().min(5).max(24 * 60).optional(),
});

export async function appRoute(app: FastifyInstance) {
  app.addHook('preHandler', requireAdminToken);

  // ─── Overview agregado: tudo que as telas do app precisam, em 1 round-trip ────
  app.get<{ Params: { phone: string } }>('/overview/:phone', async (req, reply) => {
    const phoneE164 = normalizePhone(req.params.phone);
    const user = await findUserByPhone(phoneE164);
    if (!user) return reply.code(404).send({ error: 'user_not_found' });

    const uid = user.id;
    // Tabelas que podem não existir em ambientes parciais → fallback tolerante,
    // mesmo padrão do /admin/users/:id.
    const safe = <T>(p: PromiseLike<{ data: T | null }>): Promise<{ data: T | null }> =>
      Promise.resolve(p).then(
        (r) => r,
        () => ({ data: null }),
      );

    const [
      conv,
      cond,
      allg,
      meds,
      inv,
      treat,
      presc,
      rem,
      ords,
      consults,
      mem,
      sympt,
      medlog,
    ] = await Promise.all([
      safe(
        db
          .from('conversations')
          .select('id')
          .eq('party_type', 'user')
          .eq('user_id', uid)
          .eq('whatsapp_instance', SARA_INSTANCE)
          .order('last_message_at', { ascending: false, nullsFirst: false })
          .limit(1)
          .maybeSingle(),
      ),
      safe(db.from('user_health_conditions').select('*').eq('user_id', uid).order('created_at', { ascending: false })),
      safe(db.from('user_allergies').select('*').eq('user_id', uid).order('created_at', { ascending: false })),
      safe(db.from('user_medications').select('*').eq('user_id', uid).eq('active', true).order('created_at', { ascending: false })),
      safe(db.from('medication_inventory').select('*').eq('user_id', uid).order('updated_at', { ascending: false }).limit(40)),
      safe(db.from('treatments').select('*').eq('user_id', uid).order('created_at', { ascending: false }).limit(20)),
      safe(db.from('prescribers').select('id, name, crm, crm_state, specialty, clinic_id, created_at').eq('user_id', uid).order('created_at', { ascending: false }).limit(20)),
      safe(
        db
          .from('reminders')
          .select('id, type, title, body, scheduled_at, rrule, next_run_at, status, payload, medication_id, created_at')
          .eq('user_id', uid)
          .order('next_run_at', { ascending: true, nullsFirst: false })
          .limit(60),
      ),
      safe(
        db
          .from('orders')
          .select(
            `id, status, items, payment_method, delivery_address, created_at, updated_at, selected_quote_id,
             quotes ( id, status, total, subtotal, delivery_fee, eta_minutes, payment_methods, pix_key,
                      payment_link, notes, distance_km, conversation_id, created_at,
                      suppliers ( id, name, address, city, state, rating ) )`,
          )
          .eq('user_id', uid)
          .order('created_at', { ascending: false })
          .limit(10),
      ),
      safe(
        db
          .from('consultations')
          .select(
            `id, status, specialty, urgency, modality, city, scheduled_at, created_at,
             consultation_quotes ( id, status, proposed_datetime, price_brl, modality, notes, created_at,
                                   clinics ( id, name, city, rating ) )`,
          )
          .eq('user_id', uid)
          .order('created_at', { ascending: false })
          .limit(5),
      ),
      safe(
        db
          .from('memory_cards_index')
          .select('id, kind, text, tags, confidence, source, last_seen_at, created_at')
          .eq('user_id', uid)
          .order('last_seen_at', { ascending: false })
          .limit(80),
      ),
      safe(db.from('symptoms_log').select('id, name, intensity, duration_hours, context, red_flag_triggered, created_at').eq('user_id', uid).order('created_at', { ascending: false }).limit(20)),
      safe(db.from('medication_log').select('id, status, scheduled_at, responded_at, medication_id, created_at').eq('user_id', uid).order('created_at', { ascending: false }).limit(30)),
    ]);

    return reply.send({
      user,
      conversationId: (conv.data as { id: string } | null)?.id ?? null,
      conditions: cond.data ?? [],
      allergies: allg.data ?? [],
      medications: meds.data ?? [],
      inventory: inv.data ?? [],
      treatments: treat.data ?? [],
      prescribers: presc.data ?? [],
      reminders: rem.data ?? [],
      orders: ords.data ?? [],
      consultations: consults.data ?? [],
      memoryCards: mem.data ?? [],
      symptoms: sympt.data ?? [],
      medicationLog: medlog.data ?? [],
    });
  });

  // ─── Enviar mensagem pelo app → MESMO pipeline do WhatsApp ────────────────────
  app.post('/inbound', async (req, reply) => {
    const parsed = InboundSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

    if (!loadPrompts().xarlote_enabled) {
      return reply.code(503).send({
        ok: false,
        skipped: 'xarlote_disabled',
        message: 'A Xarlote está temporariamente desligada. Tente de novo em instantes.',
      });
    }

    const phoneE164 = normalizePhone(parsed.data.phone);
    // name omitido de propósito: pushName só é usado na CRIAÇÃO de usuário novo;
    // pra quem já existe, nada é sobrescrito.
    const normalized = buildSimulatedInbound({
      phone: phoneE164,
      contentType: 'text',
      text: parsed.data.text,
    });
    delete normalized.from.pushName;

    const result = await processInboundUser(normalized);

    void writeEvent({
      eventName: 'app.message_sent',
      userId: undefined,
      conversationId: result.conversationId,
      traceId: result.traceId,
      payload: { channel: 'xarlote_app', length: parsed.data.text.length },
    });

    return reply.send({ ok: true, traceId: result.traceId, conversationId: result.conversationId });
  });

  // ─── Ações em lembretes (feito / adiar / cancelar) ────────────────────────────
  app.post<{ Params: { id: string } }>('/reminders/:id/action', async (req, reply) => {
    const parsed = ReminderActionSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

    const phoneE164 = normalizePhone(parsed.data.phone);
    const user = await findUserByPhone(phoneE164);
    if (!user) return reply.code(404).send({ error: 'user_not_found' });

    const { data: reminder } = await db
      .from('reminders')
      .select('id, user_id, status, next_run_at')
      .eq('id', req.params.id)
      .maybeSingle();

    if (!reminder) return reply.code(404).send({ error: 'reminder_not_found' });
    if (reminder.user_id !== user.id) return reply.code(403).send({ error: 'forbidden' });

    const action = parsed.data.action;
    const patch: Record<string, unknown> =
      action === 'done'
        ? { status: 'acknowledged' }
        : action === 'cancel'
          ? { status: 'cancelled' }
          : {
              status: 'pending',
              next_run_at: new Date(Date.now() + (parsed.data.minutes ?? 30) * 60_000).toISOString(),
            };

    const { error } = await db.from('reminders').update(patch).eq('id', reminder.id);
    if (error) return reply.code(500).send({ error: error.message });

    void writeEvent({
      eventName: 'app.reminder_action',
      userId: user.id,
      payload: { reminder_id: reminder.id, action, minutes: parsed.data.minutes ?? null },
    });

    const { data: updated } = await db
      .from('reminders')
      .select('id, type, title, body, scheduled_at, rrule, next_run_at, status, payload, medication_id, created_at')
      .eq('id', reminder.id)
      .single();

    return reply.send({ ok: true, reminder: updated });
  });
}
