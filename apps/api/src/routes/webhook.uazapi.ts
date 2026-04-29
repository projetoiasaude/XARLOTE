import type { FastifyInstance } from 'fastify';
import { normalizeWebhookPayload } from '@iasaude/whatsapp';
import { db } from '@iasaude/db';
import { processInboundUser } from '../handlers/inbound-user.js';
import { processInboundSupplierFromWebhook } from '../handlers/inbound-supplier.js';
import type { UazapiWebhookPayload } from '@iasaude/whatsapp';
import { AGENT_INSTANCE } from '@iasaude/shared';

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
        raw: body,
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
    if (instanceName === AGENT_INSTANCE || instanceName === process.env['UAZAPI_AGENT_INSTANCE']) {
      setImmediate(() => processInboundSupplierFromWebhook(normalized).catch((err) => req.log.error(err)));
    } else {
      setImmediate(() => processInboundUser(normalized).catch((err) => req.log.error(err)));
    }

    return reply.send({ ok: true });
  });
}
