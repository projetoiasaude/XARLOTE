/**
 * GET /app/me — identidade + flags da sessão do paciente.
 *
 * É a primeira chamada do app após login/boot: diz quem é o usuário, se o
 * consentimento do app está pendente (gate das telas) e o estado dos recursos
 * do servidor que mudam a UI (push configurado, Xarlote ligada).
 */
import type { FastifyInstance } from 'fastify';
import { db } from '@iasaude/db';
import { isPushConfigured } from '@iasaude/integrations';
import { requirePatient } from '../../middleware/patient-auth.js';
import { loadPrompts } from '../../config/prompts.js';
import { APP_CONSENT_VERSION } from './auth.js';

export async function appMeRoutes(app: FastifyInstance): Promise<void> {
  app.get('/me', { preHandler: requirePatient }, async (req, reply) => {
    const { userId, sessionId } = req.patient!;

    const [{ data: user }, { data: session }, { data: consent }] = await Promise.all([
      db.from('users')
        .select('id, preferred_name, full_name, phone_e164, created_at, adherence_score_30d, lgpd_consent_at, lgpd_consent_version, deleted_at')
        .eq('id', userId)
        .maybeSingle(),
      db.from('app_sessions')
        .select('id, device_name, platform, created_at')
        .eq('id', sessionId)
        .maybeSingle(),
      db.from('consent_events')
        .select('id')
        .eq('user_id', userId)
        .eq('event_type', 'accept')
        .eq('channel', 'app')
        .eq('policy_version', APP_CONSENT_VERSION)
        .limit(1),
    ]);

    // Conta apagada (forget-me) com sessão ainda viva no aparelho: o app precisa
    // saber que ela morreu — 404 aqui derruba pro logout local.
    if (!user || user.deleted_at) return reply.code(404).send({ error: 'user_gone' });

    return reply.send({
      user: {
        id: user.id,
        preferredName: user.preferred_name ?? null,
        fullName: user.full_name ?? null,
        phoneE164: user.phone_e164,
        createdAt: user.created_at,
        adherenceScore30d: user.adherence_score_30d ?? null,
        lgpdConsentAt: user.lgpd_consent_at ?? null,
        lgpdConsentVersion: user.lgpd_consent_version ?? null,
      },
      consentRequired: (consent ?? []).length === 0,
      session: session
        ? { id: session.id, deviceName: session.device_name ?? null, platform: session.platform, createdAt: session.created_at }
        : null,
      flags: {
        xarloteEnabled: loadPrompts().xarlote_enabled !== false,
        pushConfigured: isPushConfigured(),
      },
    });
  });
}
