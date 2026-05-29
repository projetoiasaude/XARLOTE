import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import { healthRoute } from './routes/health.js';
import { simulateRoute } from './routes/simulate.js';
import { webhookRoute } from './routes/webhook.uazapi.js';
import { adminRoute } from './routes/admin.js';
import { dispatchReminders } from './workers/reminder-dispatcher.worker.js';
import { startProfileEnricherWorker } from './workers/profile-enricher.worker.js';
import { compactStaleConversations } from './workers/conversation-compactor.worker.js';
import { startInventoryTrackerWorker } from './workers/inventory-tracker.worker.js';
import { startAdherenceScorerWorker } from './workers/adherence-scorer.worker.js';
import { startConsultationFeedbackWorker } from './workers/consultation-feedback.worker.js';
import { startConsultationDispatcherWorker } from './workers/consultation-dispatcher.worker.js';
import { startKnowledgeGraphBuilderWorker } from './workers/knowledge-graph-builder.worker.js';
import { startSkillExtractorWorker } from './workers/skill-extractor.worker.js';
import { startAnomalyDetectorWorker } from './workers/anomaly-detector.worker.js';
import { startMetricsAggregatorWorker } from './workers/metrics-aggregator.worker.js';
import { startOutboundWorkers, closeOutbound } from './queues/outbound.queue.js';
import { startRedFlagEscalatorWorker } from './workers/red-flag-escalator.worker.js';
import { installShutdownHandlers, onShutdown } from './lifecycle.js';
import { closeRedisClient } from './queue-config.js';
import { initSentry, captureError, closeSentry } from './observability/sentry.js';

/**
 * Allowlist de CORS. O dashboard é o único consumidor browser; webhooks da
 * uazapi são server-to-server (não passam por CORS). Default seguro:
 *   - CORS_ORIGINS (lista separada por vírgula) tem prioridade
 *   - dev: qualquer localhost
 *   - prod sem config: nega cross-origin de browser (false)
 */
function corsOrigins(): boolean | Array<string | RegExp> {
  const env = process.env['CORS_ORIGINS'];
  if (env) return env.split(',').map((s) => s.trim()).filter(Boolean);
  if (process.env['NODE_ENV'] !== 'production') {
    return [/^http:\/\/localhost:\d+$/, /^http:\/\/127\.0\.0\.1:\d+$/];
  }
  return false;
}

async function main() {
  initSentry();
  const app = Fastify({
    logger: {
      level: process.env['LOG_LEVEL'] ?? 'info',
      // Nunca logar segredos/cabeçalhos sensíveis no logger HTTP do Fastify.
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers["x-admin-token"]',
          'req.headers.cookie',
          'req.headers["x-api-key"]',
        ],
        censor: '[redacted]',
      },
      transport:
        process.env['NODE_ENV'] !== 'production'
          ? { target: 'pino-pretty', options: { colorize: true } }
          : undefined,
    },
  });

  await app.register(cors, { origin: corsOrigins() });
  await app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024 } });

  // Sentry (F1.B1): captura toda exceção de request/webhook (no-op se sem DSN).
  app.addHook('onError', async (request, _reply, error) => {
    captureError(error, { reqId: request.id, url: request.url, method: request.method });
  });

  app.register(healthRoute);
  app.register(simulateRoute, { prefix: '/api' });
  app.register(webhookRoute, { prefix: '/webhook' });
  app.register(adminRoute, { prefix: '/admin' });

  const port = Number(process.env['PORT'] ?? 3001);

  try {
    await app.listen({ port, host: '0.0.0.0' });
    console.log(`\n🚀 API running on http://localhost:${port}`);
    console.log(`   Mode: ${process.env['WHATSAPP_MODE'] ?? 'uazapi'}`);

    // Bootstrap workers no MESMO processo da API (Railway tem 1 container só).
    // Antes ficavam no apps/worker via concurrently, mas isso quebrava o
    // healthcheck do Railway (que olhava `/health` e não recebia resposta).
    const reminderTimer = setInterval(() => dispatchReminders().catch((e) => app.log.error(e, 'reminder dispatch failed')), 30_000);
    dispatchReminders().catch((e) => app.log.error(e, 'reminder dispatch initial failed'));
    const enricherWorker = startProfileEnricherWorker();
    const compactorTimer = setInterval(() => compactStaleConversations().catch((e) => app.log.error(e, 'compactor failed')), 60 * 60 * 1000);
    startInventoryTrackerWorker();
    startAdherenceScorerWorker();
    startConsultationFeedbackWorker();
    startConsultationDispatcherWorker();
    startKnowledgeGraphBuilderWorker();
    startSkillExtractorWorker();
    startAnomalyDetectorWorker();
    startMetricsAggregatorWorker();
    startRedFlagEscalatorWorker();
    startOutboundWorkers();
    console.log(`   Workers: reminder-dispatcher (30s), profile-enricher (queue), conversation-compactor (1h), inventory-tracker (6h), adherence-scorer (24h), consultation-feedback (1h), kg-builder (6h), skill-extractor (24h), anomaly-detector (10min), metrics-aggregator (1h), red-flag-escalator (10s), outbound-whatsapp (queue)`);

    // Graceful shutdown (F1.A5): Railway manda SIGTERM em todo redeploy.
    // Ordem: para HTTP (drena in-flight) → para crons → fecha workers/filas →
    // fecha Redis. Os demais crons (start*Worker via setInterval) são scans
    // idempotentes; perder um tick num redeploy é inofensivo (re-roda depois).
    onShutdown('http server (drena in-flight)', () => app.close());
    onShutdown('cron intervals', () => { clearInterval(reminderTimer); clearInterval(compactorTimer); });
    onShutdown('outbound workers + filas', () => closeOutbound());
    onShutdown('profile-enricher worker', () => enricherWorker.close());
    onShutdown('redis client', () => closeRedisClient());
    onShutdown('sentry flush', () => closeSentry());
    installShutdownHandlers(app);
  } catch (err) {
    captureError(err, { phase: 'boot' });
    app.log.error(err);
    process.exit(1);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
