/**
 * /app/consent — o aceite específico de DADOS DE SAÚDE feito dentro do app.
 *
 * Por que existe separado do aceite por WhatsApp (`buildConsentEvent`, channel
 * 'whatsapp'): a LGPD trata dado de saúde como categoria especial (art. 11) e exige
 * consentimento **destacado e específico** — não vale herdar o "aceito" que a pessoa
 * mandou pra iniciar uma conversa. Além disso a Apple pede um aceite in-app pra
 * qualquer app de saúde. Daí `channel='app'` + `policy_version=APP_CONSENT_VERSION`,
 * que é o par exato que /app/me e o verify consultam pra decidir `consentRequired`.
 *
 * O registro é PROVA: guarda o texto aceito, a versão, o IP e o user-agent. Ele
 * sobrevive ao forget-me de propósito (é o que demonstra que houve base legal).
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db, writeAudit, writeEvent } from '@iasaude/db';
import { requirePatient } from '../../middleware/patient-auth.js';
import { APP_CONSENT_VERSION } from './auth.js';

/** O que o paciente leu ao tocar em "Aceito" — vira evidência no banco. */
export const APP_CONSENT_SUMMARY =
  'Autorizo a Xarlote a coletar e tratar meus dados de saúde (mensagens, exames, ' +
  'medicamentos, lembretes e histórico clínico) para me acompanhar, lembrar de ' +
  'tratamentos, cotar medicamentos e agendar consultas. Posso revogar, exportar ou ' +
  'apagar tudo a qualquer momento pelo próprio app.';

const AcceptSchema = z.object({
  /** O app manda a versão que EXIBIU — aceite de tela velha não vale pela nova. */
  policyVersion: z.string().min(1).max(32),
});

export async function appConsentRoutes(app: FastifyInstance): Promise<void> {
  app.get('/consent', { preHandler: requirePatient }, async (req, reply) => {
    const { data } = await db
      .from('consent_events')
      .select('id, policy_version, created_at')
      .eq('user_id', req.patient!.userId)
      .eq('event_type', 'accept')
      .eq('channel', 'app')
      .eq('policy_version', APP_CONSENT_VERSION)
      .order('created_at', { ascending: false })
      .limit(1);

    const accepted = (data ?? [])[0];
    return reply.send({
      required: !accepted,
      version: APP_CONSENT_VERSION,
      text: APP_CONSENT_SUMMARY,
      acceptedAt: accepted?.created_at ?? null,
    });
  });

  app.post('/consent', { preHandler: requirePatient }, async (req, reply) => {
    const parsed = AcceptSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });

    // Aceite de uma versão que já não é a corrente não fecha o gate: a tela do app
    // ficou aberta enquanto a política mudou. Devolver a versão nova faz o app
    // reexibir o texto certo em vez de destravar com base num aceite obsoleto.
    if (parsed.data.policyVersion !== APP_CONSENT_VERSION) {
      return reply.code(409).send({ error: 'stale_policy_version', version: APP_CONSENT_VERSION });
    }

    const userId = req.patient!.userId;
    const nowIso = new Date().toISOString();

    const { error } = await db.from('consent_events').insert({
      user_id: userId,
      event_type: 'accept',
      policy_version: APP_CONSENT_VERSION,
      channel: 'app',
      evidence_text: APP_CONSENT_SUMMARY,
      ip: req.ip,
      user_agent: String(req.headers['user-agent'] ?? '').slice(0, 200),
    });
    if (error) return reply.code(503).send({ error: 'consent_write_failed' });

    // Espelha no usuário pra perna do WhatsApp enxergar. O onboarding só AVANÇA
    // quando ainda estava travado no consentimento — quem já passou pra profiling ou
    // active não pode ser jogado pra trás por um aceite no app.
    const { data: current } = await db
      .from('users')
      .select('onboarding_status')
      .eq('id', userId)
      .maybeSingle();

    await db
      .from('users')
      .update({
        lgpd_consent_at: nowIso,
        lgpd_consent_version: APP_CONSENT_VERSION,
        lgpd_consent_source: 'app',
        ...(current?.onboarding_status === 'consent_pending' || current?.onboarding_status === 'not_started'
          ? { onboarding_status: 'profiling' }
          : {}),
      })
      .eq('id', userId);

    await writeAudit({
      actorType: 'user',
      action: 'app.consent.accepted',
      userId,
      targetTable: 'consent_events',
      metadata: { policyVersion: APP_CONSENT_VERSION },
    });
    void writeEvent({ eventName: 'app.consent_accepted', userId, payload: { version: APP_CONSENT_VERSION } });

    return reply.send({ ok: true, version: APP_CONSENT_VERSION, acceptedAt: nowIso });
  });
}
