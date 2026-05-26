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

async function main() {
  const app = Fastify({
    logger: {
      level: process.env['LOG_LEVEL'] ?? 'info',
      transport:
        process.env['NODE_ENV'] !== 'production'
          ? { target: 'pino-pretty', options: { colorize: true } }
          : undefined,
    },
  });

  await app.register(cors, { origin: true });
  await app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024 } });

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
    setInterval(() => dispatchReminders().catch((e) => app.log.error(e, 'reminder dispatch failed')), 30_000);
    dispatchReminders().catch((e) => app.log.error(e, 'reminder dispatch initial failed'));
    startProfileEnricherWorker();
    setInterval(() => compactStaleConversations().catch((e) => app.log.error(e, 'compactor failed')), 60 * 60 * 1000);
    startInventoryTrackerWorker();
    startAdherenceScorerWorker();
    console.log(`   Workers: reminder-dispatcher (30s), profile-enricher (queue), conversation-compactor (1h), inventory-tracker (6h), adherence-scorer (24h)`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
