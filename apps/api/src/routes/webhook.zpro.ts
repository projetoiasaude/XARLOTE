import { randomUUID } from 'crypto';
import type { FastifyInstance } from 'fastify';
import { normalizeZproWebhook, zproEventId } from '@iasaude/whatsapp';
import { db, writeLog, redactPII } from '@iasaude/db';
import { processInboundUser } from '../handlers/inbound-user.js';
import { SARA_INSTANCE } from '@iasaude/shared';
import { loadPrompts } from '../config/prompts.js';
import { checkUserRateLimit } from '../middleware/rate-limit.js';
import { dispatchOutbound } from '../queues/outbound.queue.js';
import { captureError } from '../observability/sentry.js';

/**
 * Webhook de ENTRADA do zpro (WhatsApp Business API oficial) — leg da Xarlote
 * (usuário). O leg das farmácias (agent) segue no uazapi.
 *
 * Configurar no painel do zpro (API → Webhooks → mensagens):
 *   https://<api>/webhook/zpro/sara?key=<ZPRO_WEBHOOK_SECRET>
 *
 * Como o zpro NÃO documenta o payload de entrada, esta rota CAPTURA o shape
 * (redatado, sem PII) em system_logs/webhook_events na primeira passada, pra
 * gente apertar o normalizador contra o payload real.
 */
export async function webhookZproRoute(app: FastifyInstance) {
  app.post<{ Params: { instance: string }; Querystring: { key?: string } }>(
    '/zpro/:instance',
    async (req, reply) => {
      const instanceName = req.params.instance || SARA_INSTANCE;

      const incomingTrace = req.headers['x-trace-id'];
      const traceId = (typeof incomingTrace === 'string' && incomingTrace.trim()) || randomUUID();
      reply.header('x-trace-id', traceId);

      // Auth: segredo na URL (?key=) ou header x-zpro-secret. O painel do zpro
      // costuma só deixar colar uma URL, então a query é o caminho confiável.
      const expectedSecret = process.env['ZPRO_WEBHOOK_SECRET'];
      if (expectedSecret) {
        const provided = req.query?.key || req.headers['x-zpro-secret'];
        if (provided !== expectedSecret) {
          return reply.code(401).send({ error: 'Unauthorized' });
        }
      }

      // zpro pode mandar um objeto único ou um array de eventos — pega o 1º.
      const rawBody = req.body as unknown;
      const body = Array.isArray(rawBody) ? rawBody[0] : rawBody;

      const normalized = normalizeZproWebhook(body, instanceName);

      // Idempotência + CAPTURA do shape (redatado — regra LGPD #3). Grava mesmo
      // quando não normaliza, pra termos o payload real pra ajustar o parser.
      const eventId = normalized?.externalId ?? zproEventId(body);
      if (eventId) {
        const { error: dupError } = await db.from('webhook_events').insert({
          provider: 'zpro',
          instance: instanceName,
          external_event_id: eventId,
          event_type: normalized?.contentType ?? 'unknown',
          raw: redactPII(body),
        });
        if (dupError?.code === '23505') {
          return reply.send({ ok: true, skipped: 'duplicate' });
        }
      }

      if (!normalized) {
        // Aprendizado: registra as chaves de topo (sem valores) pra eu finalizar
        // o normalizador. Não loga PII — só nomes de campo + tipos.
        const keys =
          body && typeof body === 'object' && !Array.isArray(body)
            ? Object.keys(body as Record<string, unknown>).join(',')
            : typeof body;
        await writeLog(
          'warn',
          'webhook',
          `zpro webhook não normalizado (aprendizado de shape): topo=[${keys}]`,
          { traceId, instance: instanceName, rawRedacted: redactPII(body) },
        );
        return reply.send({ ok: true, skipped: 'no-normalized' });
      }

      // Interruptor mestre: Xarlote desligada no painel → ignora (200 pra não retentar).
      const cfg = loadPrompts();
      if (!cfg.xarlote_enabled) {
        await writeLog('info', 'webhook', `Xarlote DESLIGADA — msg de ${normalized.from.phoneE164} ignorada`, {
          traceId,
          instance: instanceName,
          phone: normalized.from.phoneE164,
          contentType: normalized.contentType,
        });
        return reply.send({ ok: true, skipped: 'xarlote_disabled' });
      }

      // Rate-limit por usuário (anti-flood). Fail-open.
      const rl = await checkUserRateLimit(normalized.from.phoneE164);
      if (!rl.allowed) {
        await writeLog('warn', 'webhook', `Rate-limit: ${rl.count} msgs (>${rl.limit}) — descartando`, {
          traceId,
          instance: instanceName,
          phone: normalized.from.phoneE164,
        });
        if (rl.count === rl.limit + 1) {
          await dispatchOutbound({
            kind: 'text',
            instance: SARA_INSTANCE,
            phoneE164: normalized.from.phoneE164,
            text: 'Opa, chegaram muitas mensagens de uma vez 😅 me dá um segundinho que já já te respondo!',
            traceId,
          }).catch(() => {
            /* fila já trata o fallback */
          });
        }
        return reply.send({ ok: true, skipped: 'rate_limited' });
      }

      setImmediate(() =>
        processInboundUser(normalized, traceId).catch((err) => {
          req.log.error({ traceId, err }, 'inbound-user (zpro) failed');
          captureError(err, { traceId, phase: 'inbound-user-zpro' });
        }),
      );

      return reply.send({ ok: true });
    },
  );
}
