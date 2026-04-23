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

    if (body.event !== 'messages.upsert') {
      return reply.send({ ok: true });
    }

    // Idempotency check
    const eventId = body.data?.key?.id;
    if (eventId) {
      const { error: dupError } = await db.from('webhook_events').insert({
        provider: 'uazapi',
        instance: body.instance,
        external_event_id: eventId,
        event_type: body.event,
        raw: body,
      });
      if (dupError?.code === '23505') {
        return reply.send({ ok: true, skipped: true });
      }
    }

    const normalized = normalizeWebhookPayload(body);
    if (!normalized) return reply.send({ ok: true });

    // Route based on instance: agent instance handles supplier inbound
    if (body.instance === AGENT_INSTANCE) {
      setImmediate(() => processInboundSupplierFromWebhook(normalized).catch(console.error));
    } else {
      setImmediate(() => processInboundUser(normalized).catch(console.error));
    }

    return reply.send({ ok: true });
  });
}
