import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import { healthRoute } from './routes/health.js';
import { simulateRoute } from './routes/simulate.js';
import { webhookRoute } from './routes/webhook.uazapi.js';
import { adminRoute } from './routes/admin.js';

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
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
