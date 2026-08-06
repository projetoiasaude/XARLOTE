/**
 * /app/auth/* — login do PACIENTE por OTP via WhatsApp + sessão com refresh rotativo.
 *
 * É a peça que fecha o buraco da auditoria de 05/08 (digitar um telefone = prontuário).
 * Decisões de segurança e os PORQUÊS estão nos módulos puros:
 *   lib/otp.ts (hash pepper+salt, TTL, tentativas) · lib/refresh-token.ts (rotação,
 *   graça de 60s, detecção de reuso) · lib/app-jwt.ts (access 15min).
 *
 * Anti-enumeração: /otp/request responde IGUAL exista ou não o telefone — o usuário
 * só nasce no /otp/verify com código certo (possuir o WhatsApp É a prova de posse).
 *
 * Envio SEMPRE pela fila outbound (CLAUDE.md §5): janela de 24h aberta → texto;
 * fechada → template AUTHENTICATION (buildOtpTemplate). O código NUNCA é espelhado
 * em `messages` (não pertence ao histórico clínico) e NUNCA aparece em log.
 */
import { randomBytes, randomInt, randomUUID } from 'crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db, findUserByPhone, writeAudit, writeEvent, writeLog } from '@iasaude/db';
import { SARA_INSTANCE, brPhoneVariants, isWabaWindowOpen, whatsappJidVariants } from '@iasaude/shared';
import { dispatchOutbound } from '../../queues/outbound.queue.js';
import { buildOtpTemplate } from '../../config/template-registry.js';
import { checkKeyedRateLimit } from '../../middleware/rate-limit.js';
import { requirePatient } from '../../middleware/patient-auth.js';
import { constantTimeEquals } from '../../middleware/auth.js';
import { generateOtpCode, hashOtp, evaluateOtpAttempt, OTP_TTL_MS, OTP_MAX_ATTEMPTS } from '../../lib/otp.js';
import { newRefreshToken, hashRefreshToken, decideRefresh, REFRESH_GRACE_MS } from '../../lib/refresh-token.js';
import { signAppJwt, APP_ACCESS_TTL_S } from '../../lib/app-jwt.js';

export const APP_CONSENT_VERSION = process.env['APP_CONSENT_VERSION'] ?? '1.0-app';

const RequestSchema = z.object({ phone: z.string().min(8).max(20) });
const VerifySchema = z.object({
  phone: z.string().min(8).max(20),
  code: z.string().regex(/^\d{6}$/),
  deviceName: z.string().max(64).optional(),
  platform: z.enum(['ios', 'android', 'web']),
});
const RefreshSchema = z.object({ refreshToken: z.string().min(32).max(128) });
const LogoutSchema = z.object({ pushToken: z.string().min(10).max(4096).optional() }).optional();

function normalizePhone(raw: string): string {
  const trimmed = raw.replace(/[^\d+]/g, '');
  return trimmed.startsWith('+') ? trimmed : `+${trimmed}`;
}

function isValidPhone(phoneE164: string): boolean {
  return /^\+\d{10,15}$/.test(phoneE164);
}

async function findAppUser(phoneE164: string): Promise<{ id: string; phone_e164: string; preferred_name?: string | null; full_name?: string | null } | null> {
  for (const candidate of brPhoneVariants(phoneE164)) {
    const user = await findUserByPhone(candidate);
    if (user) return user as { id: string; phone_e164: string; preferred_name?: string | null; full_name?: string | null };
  }
  return null;
}

/** A janela de 24h do paciente está aberta? (sem usuário/conversa = fechada.) */
async function patientWindowOpen(phoneE164: string): Promise<boolean> {
  const jids = whatsappJidVariants(phoneE164);
  const { data: convs } = await db
    .from('conversations')
    .select('id')
    .eq('whatsapp_instance', SARA_INSTANCE)
    .in('whatsapp_jid', jids)
    .limit(1);
  const conv = convs?.[0];
  if (!conv) return false;
  // Mesmo filtro do reminder-dispatcher: inbound sintético (app/simulador) NÃO abre
  // a janela da Meta — contar ele mandaria texto livre que a Meta rejeita.
  const { data: last } = await db
    .from('messages')
    .select('created_at')
    .eq('conversation_id', conv.id)
    .eq('direction', 'in')
    .or('external_id.is.null,external_id.not.like.sim-*')
    .order('created_at', { ascending: false })
    .limit(1);
  const lastMs = last?.[0]?.created_at ? Date.parse(last[0].created_at as string) : null;
  return isWabaWindowOpen(lastMs, Date.now());
}

function demoPhone(): string | null {
  const raw = process.env['APP_DEMO_PHONE']?.trim();
  return raw ? normalizePhone(raw) : null;
}

/** `consentRequired` = ainda não aceitou a versão corrente do consentimento do APP. */
async function consentRequired(userId: string): Promise<boolean> {
  const { data } = await db
    .from('consent_events')
    .select('id')
    .eq('user_id', userId)
    .eq('event_type', 'accept')
    .eq('channel', 'app')
    .eq('policy_version', APP_CONSENT_VERSION)
    .limit(1);
  return (data ?? []).length === 0;
}

async function createSession(userId: string, platform: string, deviceName: string | undefined) {
  const refreshToken = newRefreshToken(randomBytes);
  const { data: session, error } = await db.from('app_sessions').insert({
    user_id: userId,
    refresh_hash: hashRefreshToken(refreshToken),
    device_name: deviceName ?? null,
    platform,
  }).select('id').single();
  if (error || !session) return null;
  return { sessionId: session.id as string, refreshToken };
}

export async function appAuthRoutes(app: FastifyInstance): Promise<void> {
  // ─── 1. Pedir código ─────────────────────────────────────────────────────────
  app.post('/auth/otp/request', async (req, reply) => {
    const parsed = RequestSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_phone' });
    const phone = normalizePhone(parsed.data.phone);
    if (!isValidPhone(phone)) return reply.code(400).send({ error: 'invalid_phone' });

    // Tetos de segurança (fail-closed): 3 códigos/15min e 6/24h por telefone; 10/h por IP.
    const [p15, p24, ip] = await Promise.all([
      checkKeyedRateLimit(`otp:p15:${phone}`, { max: 3, windowS: 15 * 60 }),
      checkKeyedRateLimit(`otp:p24:${phone}`, { max: 6, windowS: 24 * 3600 }),
      checkKeyedRateLimit(`otp:ip:${req.ip}`, { max: 10, windowS: 3600 }),
    ]);
    if (!p15.allowed || !p24.allowed || !ip.allowed) {
      return reply.code(429).send({ error: 'rate_limited', message: 'Muitos pedidos de código. Aguarda uns minutos e tenta de novo.' });
    }

    // Conta demo do revisor da loja: nunca envia nada, aceita só o código fixo no verify.
    if (demoPhone() && phone === demoPhone()) {
      return reply.send({ ok: true, expiresInS: OTP_TTL_MS / 1000, channel: 'whatsapp' });
    }

    const pepper = process.env['OTP_PEPPER'];
    if (!pepper) {
      // Fail-closed: sem pepper o hash não protege nada — melhor login indisponível.
      await writeLog('error', 'app-auth', 'OTP_PEPPER não configurado — login do app indisponível', {});
      return reply.code(503).send({ error: 'otp_unavailable' });
    }

    const code = generateOtpCode(randomInt);
    const salt = randomUUID();
    const { error: insErr } = await db.from('otp_codes').insert({
      phone_e164: phone,
      code_hash: hashOtp(code, salt, pepper),
      salt,
      max_attempts: OTP_MAX_ATTEMPTS,
      request_ip: req.ip,
      expires_at: new Date(Date.now() + OTP_TTL_MS).toISOString(),
    });
    if (insErr) {
      await writeLog('error', 'app-auth', `otp_codes insert falhou: ${insErr.message.slice(0, 120)}`, {});
      return reply.code(503).send({ error: 'otp_unavailable' });
    }

    const texto = `🔐 Seu código de acesso ao app da Xarlote: ${code}\n\nVale por 5 minutos. Se não foi você, é só ignorar.`;
    const windowOpen = await patientWindowOpen(phone);
    if (windowOpen) {
      await dispatchOutbound({ kind: 'text', instance: SARA_INSTANCE, phoneE164: phone, text: texto });
    } else {
      const tpl = buildOtpTemplate(code);
      if (!tpl) {
        // Janela fechada e template ainda não aprovado na Meta: não há canal. A
        // orientação abre a janela em 1 mensagem do paciente — e aí o texto passa.
        return reply.code(503).send({
          error: 'otp_unavailable',
          message: 'Manda um "oi" pra Xarlote no WhatsApp e tenta entrar de novo em seguida 💙',
        });
      }
      await dispatchOutbound({
        kind: 'template', instance: SARA_INSTANCE, phoneE164: phone,
        templateName: tpl.name, templateLanguage: tpl.language, templateVariables: tpl.variables, text: tpl.text,
      });
    }

    // Auditoria SEM o código e SEM correlacionar existência de usuário na resposta.
    void writeEvent({ eventName: 'app.otp_sent', payload: { channel: windowOpen ? 'text' : 'template' } });
    return reply.send({ ok: true, expiresInS: OTP_TTL_MS / 1000, channel: 'whatsapp' });
  });

  // ─── 2. Verificar código → sessão ────────────────────────────────────────────
  app.post('/auth/otp/verify', async (req, reply) => {
    const parsed = VerifySchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_code' });
    const phone = normalizePhone(parsed.data.phone);
    if (!isValidPhone(phone)) return reply.code(400).send({ error: 'invalid_phone' });

    const ipGate = await checkKeyedRateLimit(`otpv:ip:${req.ip}`, { max: 30, windowS: 3600 });
    if (!ipGate.allowed) return reply.code(429).send({ error: 'rate_limited' });

    const isDemo = demoPhone() !== null && phone === demoPhone();
    if (isDemo) {
      const expected = process.env['APP_DEMO_OTP'] ?? '';
      if (!expected || !constantTimeEquals(parsed.data.code, expected)) {
        return reply.code(400).send({ error: 'invalid_code' });
      }
    } else {
      const pepper = process.env['OTP_PEPPER'];
      if (!pepper) return reply.code(503).send({ error: 'otp_unavailable' });

      const { data: rows } = await db
        .from('otp_codes')
        .select('id, code_hash, salt, attempts, max_attempts, expires_at, consumed_at')
        .eq('phone_e164', phone)
        .is('consumed_at', null)
        .order('created_at', { ascending: false })
        .limit(1);
      const row = rows?.[0];
      if (!row) return reply.code(400).send({ error: 'invalid_code' });

      // Incrementa ANTES de comparar, por CAS: dois requests paralelos nunca ganham
      // duas tentativas "de graça" (transição de estado crítico = CAS, regra do projeto).
      const { data: bumped } = await db
        .from('otp_codes')
        .update({ attempts: (row.attempts as number) + 1 })
        .eq('id', row.id)
        .eq('attempts', row.attempts)
        .is('consumed_at', null)
        .select('id');
      if (!bumped || bumped.length === 0) {
        // Corrida com outro verify — conta como tentativa gasta.
        return reply.code(429).send({ error: 'too_many_attempts' });
      }

      const verdict = evaluateOtpAttempt(
        { ...row, attempts: (row.attempts as number) + 1 } as Parameters<typeof evaluateOtpAttempt>[0],
        { code: parsed.data.code, pepper, nowMs: Date.now() },
      );
      if (verdict === 'expired') return reply.code(410).send({ error: 'code_expired' });
      if (verdict === 'exhausted') return reply.code(429).send({ error: 'too_many_attempts' });
      if (verdict !== 'ok') return reply.code(400).send({ error: 'invalid_code' });

      await db.from('otp_codes').update({ consumed_at: new Date().toISOString() }).eq('id', row.id).is('consumed_at', null);
    }

    // Possuir o WhatsApp do número É a prova de posse → agora sim o usuário pode nascer.
    let user: { id: string; phone_e164: string; preferred_name?: string | null; full_name?: string | null } | null =
      await findAppUser(phone);
    if (!user) {
      const { data: created, error: createErr } = await db
        .from('users')
        .insert({ phone_e164: phone })
        .select('id, phone_e164, preferred_name, full_name')
        .single();
      if (createErr || !created) {
        await writeLog('error', 'app-auth', `criação de usuário no verify falhou: ${createErr?.message.slice(0, 120)}`, {});
        return reply.code(503).send({ error: 'otp_unavailable' });
      }
      user = created as NonNullable<typeof user>;
    }

    const session = await createSession(user!.id, parsed.data.platform, parsed.data.deviceName);
    if (!session) return reply.code(503).send({ error: 'otp_unavailable' });

    const secret = process.env['APP_JWT_SECRET'];
    if (!secret) return reply.code(503).send({ error: 'app_auth_not_configured' });
    const accessToken = signAppJwt({ userId: user!.id, sessionId: session.sessionId }, secret, Date.now());

    await writeAudit({
      actorType: 'user', action: 'app.session.created', userId: user!.id,
      targetTable: 'app_sessions', targetId: session.sessionId,
      metadata: { platform: parsed.data.platform, demo: isDemo },
    });
    void writeEvent({ eventName: 'app.login', userId: user!.id, payload: { platform: parsed.data.platform } });

    return reply.send({
      accessToken,
      accessExpiresInS: APP_ACCESS_TTL_S,
      refreshToken: session.refreshToken,
      user: { id: user!.id, preferredName: user!.preferred_name ?? user!.full_name ?? null, phoneE164: user!.phone_e164 },
      consentRequired: await consentRequired(user!.id),
    });
  });

  // ─── 3. Refresh (rotação com graça e detecção de reuso) ──────────────────────
  app.post('/auth/refresh', async (req, reply) => {
    const parsed = RefreshSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(401).send({ error: 'invalid_refresh' });
    const providedHash = hashRefreshToken(parsed.data.refreshToken);

    const { data: sessions } = await db
      .from('app_sessions')
      .select('id, user_id, refresh_hash, prev_refresh_hash, prev_valid_until, revoked_at, created_at')
      .or(`refresh_hash.eq.${providedHash},prev_refresh_hash.eq.${providedHash}`)
      .limit(1);
    const session = sessions?.[0];
    if (!session) return reply.code(401).send({ error: 'invalid_refresh' });

    const verdict = decideRefresh(session as Parameters<typeof decideRefresh>[0], providedHash, Date.now());

    if (verdict === 'invalid') return reply.code(401).send({ error: 'invalid_refresh' });

    if (verdict === 'reuse') {
      // Token ANTERIOR fora da graça = vazou/replay → mata a sessão inteira.
      await db.from('app_sessions').update({ revoked_at: new Date().toISOString() }).eq('id', session.id);
      await writeAudit({
        actorType: 'system', action: 'app.session.refresh_reuse', userId: session.user_id as string,
        targetTable: 'app_sessions', targetId: session.id as string,
      });
      return reply.code(401).send({ error: 'invalid_refresh' });
    }

    // 'rotate' e 'grace' emitem par NOVO. No grace (retry de rede móvel, o cliente
    // NUNCA recebeu o par da primeira rotação), rotacionar de novo órfã aquele par —
    // inofensivo por construção: quem re-tentou é porque não o tem. O que NÃO dá é
    // devolver "o par vigente": só guardamos o hash dele.
    const nextRefresh = newRefreshToken(randomBytes);
    // CAS no hash VIGENTE lido há instantes: se outra rotação entrou no meio,
    // refresh_hash mudou → 0 linhas → 401 (o cliente re-tenta com o token novo dele).
    // Vale pros dois vereditos — no 'grace' o vigente é o da primeira rotação, e é
    // exatamente ele que não pode ter mudado.
    const { data: rotated } = await db
      .from('app_sessions')
      .update({
        refresh_hash: hashRefreshToken(nextRefresh),
        prev_refresh_hash: providedHash,
        prev_valid_until: new Date(Date.now() + REFRESH_GRACE_MS).toISOString(),
        last_used_at: new Date().toISOString(),
      })
      .eq('id', session.id)
      .eq('refresh_hash', session.refresh_hash)
      .is('revoked_at', null)
      .select('id');
    if (!rotated || rotated.length === 0) return reply.code(401).send({ error: 'invalid_refresh' });

    const secret = process.env['APP_JWT_SECRET'];
    if (!secret) return reply.code(503).send({ error: 'app_auth_not_configured' });
    const accessToken = signAppJwt({ userId: session.user_id as string, sessionId: session.id as string }, secret, Date.now());
    return reply.send({ accessToken, accessExpiresInS: APP_ACCESS_TTL_S, refreshToken: nextRefresh });
  });

  // ─── 4. Logout ────────────────────────────────────────────────────────────────
  app.post('/auth/logout', { preHandler: requirePatient }, async (req, reply) => {
    const parsed = LogoutSchema.safeParse(req.body ?? {});
    const pushToken = parsed.success ? parsed.data?.pushToken : undefined;
    await db.from('app_sessions').update({ revoked_at: new Date().toISOString() }).eq('id', req.patient!.sessionId);
    if (pushToken) {
      await db.from('device_tokens').delete().eq('token', pushToken).eq('user_id', req.patient!.userId);
    }
    return reply.code(204).send();
  });
}
