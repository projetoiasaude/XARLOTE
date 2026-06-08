import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import { healthRoute } from './routes/health.js';
import { simulateRoute } from './routes/simulate.js';
import { webhookRoute } from './routes/webhook.uazapi.js';
import { adminRoute } from './routes/admin.js';
import { startAllWorkers } from './workers/start-all.js';
import { closeOutbound } from './queues/outbound.queue.js';
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

  // ROLE define o que este processo roda (F1.A1 — separação api/worker):
  //   all (default) → HTTP + workers no mesmo processo (dev / single-box)
  //   api           → só HTTP (service "api" no Railway)
  //   worker        → só workers (service "worker" dedicado no Railway)
  // Em qualquer role o HTTP sobe (nem que seja só pra /health do Railway/UptimeRobot).
  const role = (process.env['ROLE'] ?? 'all').toLowerCase();
  const runApi = role === 'all' || role === 'api';
  const runWorkers = role === 'all' || role === 'worker';
  if (!runApi && !runWorkers) {
    console.error(`ROLE inválido: "${role}" — use all | api | worker`);
    process.exit(1);
  }

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

  // /health e /ready em TODOS os roles (Railway healthcheck + UptimeRobot batem
  // até no service worker).
  app.register(healthRoute);

  // Rotas de negócio só no role de API (webhook/admin/simulate). No worker elas
  // nem existem → superfície de ataque menor e zero risco de processar inbound
  // em duplicidade.
  if (runApi) {
    app.register(simulateRoute, { prefix: '/api' });
    app.register(webhookRoute, { prefix: '/webhook' });
    app.register(adminRoute, { prefix: '/admin' });
  }

  const port = Number(process.env['PORT'] ?? 3001);

  try {
    await app.listen({ port, host: '0.0.0.0' });
    console.log(`\n🚀 ${runApi ? 'API' : 'Worker'} up on http://localhost:${port} (ROLE=${role})`);
    console.log(`   Mode: ${process.env['WHATSAPP_MODE'] ?? 'uazapi'}`);

    // Graceful shutdown (F1.A5): Railway manda SIGTERM em todo redeploy.
    // Ordem: HTTP primeiro (para de aceitar + drena in-flight) → workers (crons +
    // enricher, registrados dentro de startAllWorkers) → outbound → Redis → Sentry.
    onShutdown('http server (drena in-flight)', () => app.close());

    // Workers: só neste processo se ROLE incluir worker. Registram seus próprios
    // disposers (cron intervals, enricher) via onShutdown, na ordem certa.
    if (runWorkers) {
      startAllWorkers(app.log);
    } else {
      console.log('   Workers: OFF (rodando em service dedicado — ROLE=worker)');
    }

    onShutdown('outbound workers + filas', () => closeOutbound());
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
