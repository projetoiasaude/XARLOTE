import { randomUUID } from 'crypto';
import type { FastifyInstance } from 'fastify';
import { normalizeWebhookPayload } from '@iasaude/whatsapp';
import { db, writeLog, redactPII } from '@iasaude/db';
import { processInboundUser } from '../handlers/inbound-user.js';
import { processInboundSupplierFromWebhook } from '../handlers/inbound-supplier.js';
import type { UazapiWebhookPayload } from '@iasaude/whatsapp';
import { AGENT_INSTANCE, SARA_INSTANCE } from '@iasaude/shared';
import { loadPrompts } from '../config/prompts.js';
import { checkUserRateLimit } from '../middleware/rate-limit.js';
import { dispatchOutbound } from '../queues/outbound.queue.js';
import { captureError } from '../observability/sentry.js';

export async function webhookRoute(app: FastifyInstance) {
  app.post<{ Params: { instance: string } }>('/uazapi/:instance', async (req, reply) => {
    const body = req.body as UazapiWebhookPayload;
    const secret = req.headers['x-uazapi-secret'];

    // F1.B2: traceId único por evento, nascendo aqui no ingresso. Aceita um
    // x-trace-id de entrada (correlação distribuída) ou gera um novo. Vai no
    // header da resposta e desce por todo o pipeline (handlers → filas → workers).
    const incomingTrace = req.headers['x-trace-id'];
    const traceId = (typeof incomingTrace === 'string' && incomingTrace.trim()) || randomUUID();
    reply.header('x-trace-id', traceId);

    // Verify secret when configured
    const expectedSecret = process.env['UAZAPI_WEBHOOK_SECRET'];
    if (expectedSecret && secret !== expectedSecret) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }

    const eventType = body?.EventType;
    const instanceName = body?.instanceName ?? req.params.instance;

    req.log.debug(
      { traceId, eventType, instanceName, fromMe: body?.message?.fromMe, msgType: body?.message?.type },
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
      req.log.info({ traceId, eventType, fromMe: body?.message?.fromMe }, 'uazapi webhook: ignored (fromMe/group/empty)');
      return reply.send({ ok: true, skipped: 'no-normalized' });
    }

    // Roteia: instance do agente (farmácias) vs sara (usuários)
    const isAgentInstance =
      instanceName === AGENT_INSTANCE || instanceName === process.env['UAZAPI_AGENT_INSTANCE'];
    if (isAgentInstance) {
      setImmediate(() =>
        processInboundSupplierFromWebhook(normalized, traceId).catch((err) => {
          req.log.error({ traceId, err }, 'inbound-supplier failed');
          captureError(err, { traceId, phase: 'inbound-supplier' });
        }),
      );
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
      // Rate-limit por usuário (F2.G5): anti-flood. Fail-open; só pega rajada.
      const rl = await checkUserRateLimit(normalized.from.phoneE164);
      if (!rl.allowed) {
        await writeLog('warn', 'webhook', `Rate-limit: ${rl.count} msgs (>${rl.limit}) — descartando`, {
          traceId,
          instance: instanceName,
          phone: normalized.from.phoneE164,
        });
        // Avisa UMA vez por janela (na borda) — sem spammar quem floodou.
        if (rl.count === rl.limit + 1) {
          await dispatchOutbound({
            kind: 'text',
            instance: SARA_INSTANCE,
            phoneE164: normalized.from.phoneE164,
            text: 'Opa, chegaram muitas mensagens de uma vez 😅 me dá um segundinho que já já te respondo!',
            traceId,
          }).catch(() => { /* fila já trata o fallback */ });
        }
        return reply.send({ ok: true, skipped: 'rate_limited' });
      }

      setImmediate(() =>
        processInboundUser(normalized, traceId).catch((err) => {
          req.log.error({ traceId, err }, 'inbound-user failed');
          captureError(err, { traceId, phase: 'inbound-user' });
        }),
      );
    }

    return reply.send({ ok: true });
  });
}
