import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { db, findUserByPhone, writeEvent, registerDeviceToken, unregisterDeviceToken } from '@iasaude/db';
import { buildSimulatedInbound } from '@iasaude/whatsapp';
import { SARA_INSTANCE, nextOccurrence } from '@iasaude/shared';
import { processInboundUser } from '../handlers/inbound-user.js';
import { loadPrompts } from '../config/prompts.js';
import { requireAppToken } from '../middleware/auth.js';
import { checkUserRateLimit } from '../middleware/rate-limit.js';

/**
 * Rotas do XARLOTE APP (cliente final) — chat espelhado do WhatsApp + saúde 360 +
 * lembretes + atividade. Diferente do /api/simulate (ferramenta de dev, 404 em prod),
 * estas rotas são DE PRODUTO e ficam ativas em produção.
 *
 * Auth: token dedicado do app (F0). Quando nascer a auth de usuário final
 * (Supabase Auth + OTP via WhatsApp), troca-se só este preHandler.
 */

function normalizePhone(raw: string): string {
  const trimmed = raw.replace(/[^\d+]/g, '');
  return trimmed.startsWith('+') ? trimmed : `+${trimmed}`;
}

/** E.164 plausível: + e 10–15 dígitos. Barra lixo antes de tocar no banco. */
function isValidPhone(phoneE164: string): boolean {
  return /^\+\d{10,15}$/.test(phoneE164);
}

/**
 * Variantes do 9º dígito BR: o WhatsApp às vezes registra o celular SEM o 9
 * (+55 62 8345024x) enquanto a pessoa digita COM o 9 (+55 62 9 8345024x) — e
 * vice-versa. Sem isso, o login no app dá user_not_found pra um usuário real.
 */
function brPhoneVariants(phoneE164: string): string[] {
  const variants = [phoneE164];
  const m = phoneE164.match(/^\+55(\d{2})(\d+)$/);
  if (m) {
    const [, ddd, subscriber] = m;
    if (subscriber!.length === 9 && subscriber!.startsWith('9')) {
      variants.push(`+55${ddd}${subscriber!.slice(1)}`); // remove o 9
    } else if (subscriber!.length === 8) {
      variants.push(`+55${ddd}9${subscriber}`); // insere o 9
    }
  }
  return variants;
}

async function findAppUser(phoneE164: string) {
  for (const candidate of brPhoneVariants(phoneE164)) {
    const user = await findUserByPhone(candidate);
    if (user) return user;
  }
  return null;
}

/** Anti-flood: o token do app é público (bundle) — sem isso, /inbound vira torneira de custo LLM. */
async function appRateLimit(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const body = req.body as { phone?: string } | undefined;
  const params = req.params as { phone?: string } | undefined;
  const key = body?.phone ?? params?.phone ?? req.ip;
  const result = await checkUserRateLimit(`app:${key}`);
  if (!result.allowed) {
    await reply.code(429).send({ error: 'rate_limited', message: 'Calma! Muitas mensagens em sequência. Tenta de novo em alguns segundos.' });
  }
}

const PhoneSchema = z.object({ phone: z.string().min(8).max(20) });

const InboundSchema = z.object({
  phone: z.string().min(8).max(20),
  text: z.string().min(1).max(4000),
});

const ReminderActionSchema = z.object({
  phone: z.string().min(8).max(20),
  action: z.enum(['done', 'snooze', 'cancel']),
  minutes: z.number().int().min(5).max(24 * 60).optional(),
});

const PushRegisterSchema = z.object({
  phone: z.string().min(8).max(20),
  token: z.string().min(10).max(4096),
  platform: z.enum(['ios', 'android', 'web']),
  appVersion: z.string().max(40).optional(),
});

const PushUnregisterSchema = z.object({
  token: z.string().min(10).max(4096),
});

export async function appRoute(app: FastifyInstance) {
  // Gate dedicado do app (NÃO o token de admin — bundle é público). Ver requireAppToken.
  app.addHook('preHandler', requireAppToken);
  app.addHook('preHandler', appRateLimit);

  // ─── Overview agregado: tudo que as telas do app precisam, em 1 round-trip ────
  // POST com phone no body (telefone na URL vazaria pros access logs — LGPD).
  // O GET /overview/:phone segue como alias deprecado até o front 100% migrado.
  const overviewHandler = async (phoneRaw: string, reply: FastifyReply) => {
    const phoneE164 = normalizePhone(phoneRaw);
    if (!isValidPhone(phoneE164)) return reply.code(400).send({ error: 'invalid_phone' });
    const user = await findAppUser(phoneE164);
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
  };

  app.post('/overview', async (req, reply) => {
    const parsed = PhoneSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    return overviewHandler(parsed.data.phone, reply);
  });

  // DEPRECADO (telefone na URL): remover quando o front estiver 100% no POST.
  app.get<{ Params: { phone: string } }>('/overview/:phone', async (req, reply) =>
    overviewHandler(req.params.phone, reply),
  );

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

    let phoneE164 = normalizePhone(parsed.data.phone);
    if (!isValidPhone(phoneE164)) return reply.code(400).send({ error: 'invalid_phone' });
    // Canonicaliza pro telefone do usuário JÁ EXISTENTE (variante do 9º dígito BR)
    // — senão o app criaria um usuário duplicado descolado da conversa real.
    const existing = await findAppUser(phoneE164);
    if (existing?.phone_e164) phoneE164 = existing.phone_e164;

    // name omitido de propósito: pushName só é usado na CRIAÇÃO de usuário novo;
    // pra quem já existe, nada é sobrescrito.
    const normalized = buildSimulatedInbound({
      phone: phoneE164,
      contentType: 'text',
      text: parsed.data.text,
    });
    delete normalized.from.pushName;

    let result: { traceId: string; conversationId: string };
    try {
      result = await processInboundUser(normalized);
    } catch (err) {
      req.log.error({ err }, 'processInboundUser falhou no /app/inbound');
      return reply.code(502).send({
        ok: false,
        error: 'processing_failed',
        message: 'Não consegui processar sua mensagem agora. Tenta de novo em instantes.',
      });
    }

    void writeEvent({
      eventName: 'app.message_sent',
      userId: existing?.id,
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
    if (!isValidPhone(phoneE164)) return reply.code(400).send({ error: 'invalid_phone' });
    const user = await findAppUser(phoneE164);
    if (!user) return reply.code(404).send({ error: 'user_not_found' });

    const { data: reminder } = await db
      .from('reminders')
      .select('id, user_id, status, next_run_at, rrule')
      .eq('id', req.params.id)
      .maybeSingle();

    if (!reminder) return reply.code(404).send({ error: 'reminder_not_found' });
    if (reminder.user_id !== user.id) return reply.code(403).send({ error: 'forbidden' });

    const action = parsed.data.action;
    // Cancelado é terminal: done/snooze não ressuscitam (cancel de novo é no-op OK).
    if (reminder.status === 'cancelled' && action !== 'cancel') {
      return reply.code(409).send({ error: 'reminder_cancelled' });
    }
    // "done" num recorrente = concluiu o de HOJE → reagenda o próximo e segue
    // pending (acknowledged mataria a recorrência). One-shot → acknowledged.
    const nextRecurring = reminder.rrule ? nextOccurrence(reminder.rrule) : null;
    const patch: Record<string, unknown> =
      action === 'done'
        // last_confirmed_at (0020): botão "done" = confirmação → destrava o gate do backup condicional.
        ? nextRecurring
          ? { status: 'pending', next_run_at: nextRecurring.toISOString(), last_run_at: new Date().toISOString(), last_confirmed_at: new Date().toISOString() }
          : { status: 'acknowledged', last_confirmed_at: new Date().toISOString() }
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

  // ─── Push: registrar token do aparelho (app nativo) ───────────────────────────
  app.post('/push/register', async (req, reply) => {
    const parsed = PushRegisterSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

    const phoneE164 = normalizePhone(parsed.data.phone);
    if (!isValidPhone(phoneE164)) return reply.code(400).send({ error: 'invalid_phone' });
    const user = await findAppUser(phoneE164);
    if (!user) return reply.code(404).send({ error: 'user_not_found' });

    await registerDeviceToken(user.id, parsed.data.token, parsed.data.platform, parsed.data.appVersion);
    return reply.send({ ok: true });
  });

  // ─── Push: dar baixa num token (logout / desinstalação) ───────────────────────
  app.post('/push/unregister', async (req, reply) => {
    const parsed = PushUnregisterSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    await unregisterDeviceToken(parsed.data.token);
    return reply.send({ ok: true });
  });
}
