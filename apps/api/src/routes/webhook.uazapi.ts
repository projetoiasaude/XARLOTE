import type { FastifyInstance } from 'fastify';
import { normalizeWebhookPayload } from '@iasaude/whatsapp';
import { db, writeLog, redactPII } from '@iasaude/db';
import { processInboundUser } from '../handlers/inbound-user.js';
import { processInboundSupplierFromWebhook } from '../handlers/inbound-supplier.js';
import type { UazapiWebhookPayload } from '@iasaude/whatsapp';
import { AGENT_INSTANCE } from '@iasaude/shared';
import { loadPrompts } from '../config/prompts.js';

export async function webhookRoute(app: FastifyInstance) {
  app.post<{ Params: { instance: string } }>('/uazapi/:instance', async (req, reply) => {
    const body = req.body as UazapiWebhookPayload;
    const secret = req.headers['x-uazapi-secret'];

    // Verify secret when configured
    const expectedSecret = process.env['UAZAPI_WEBHOOK_SECRET'];
    if (expectedSecret && secret !== expectedSecret) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }

    const eventType = body?.EventType;
    const instanceName = body?.instanceName ?? req.params.instance;

    req.log.debug(
      { eventType, instanceName, fromMe: body?.message?.fromMe, msgType: body?.message?.type },
      'uazapi webhook received'
    );

    // Só processa eventos de mensagem novos. uazapi também envia "messages_update" (status delivered/read)
    // e "wasSentByApi" (echo das próprias mensagens) — esses devem ser ignorados.
    if (eventType !== 'messages') {
      return reply.send({ ok: true, skipped: eventType });
    }

    // Idempotência por messageid
    const eventId = body?.message?.messageid || body?.message?.id;
    if (eventId) {
      const { error: dupError } = await db.from('webhook_events').insert({
        provider: 'uazapi',
        instance: instanceName,
        external_event_id: eventId,
        event_type: eventType,
        // LGPD (F0.5): não persistir payload bruto com PII — redige antes de gravar.
        raw: redactPII(body),
      });
      if (dupError?.code === '23505') {
        return reply.send({ ok: true, skipped: 'duplicate' });
      }
    }

    const normalized = normalizeWebhookPayload(body);
    if (!normalized) {
      req.log.info({ eventType, fromMe: body?.message?.fromMe }, 'uazapi webhook: ignored (fromMe/group/empty)');
      return reply.send({ ok: true, skipped: 'no-normalized' });
    }

    // Roteia: instance do agente (farmácias) vs sara (usuários)
    const isAgentInstance =
      instanceName === AGENT_INSTANCE || instanceName === process.env['UAZAPI_AGENT_INSTANCE'];
    if (isAgentInstance) {
      setImmediate(() => processInboundSupplierFromWebhook(normalized).catch((err) => req.log.error(err)));
    } else {
      // Interruptor mestre: se a Xarlote estiver desligada no painel, ignora a mensagem do usuário.
      // Devolve 200 OK pro uazapi não retentar; loga pra ficar rastreável no dashboard.
      const cfg = loadPrompts();
      if (!cfg.xarlote_enabled) {
        await writeLog(
          'info',
          'webhook',
          `Xarlote DESLIGADA — mensagem de ${normalized.from.phoneE164} ignorada`,
          {
            instance: instanceName,
            phone: normalized.from.phoneE164,
            contentType: normalized.contentType,
          },
        );
        return reply.send({ ok: true, skipped: 'xarlote_disabled' });
      }
      setImmediate(() => processInboundUser(normalized).catch((err) => req.log.error(err)));
    }

    return reply.send({ ok: true });
  });
}
