import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import { healthRoute } from './routes/health.js';
import { simulateRoute } from './routes/simulate.js';
import { webhookRoute } from './routes/webhook.uazapi.js';
import { webhookZproRoute } from './routes/webhook.zpro.js';
import { adminRoute } from './routes/admin.js';
import { appRoute } from './routes/app.js';
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
    // Inclui IPs privados (192.168.x / 10.x) pra testar o app no celular via Wi-Fi local.
    return [
      /^http:\/\/localhost:\d+$/,
      /^http:\/\/127\.0\.0\.1:\d+$/,
      /^http:\/\/192\.168\.\d{1,3}\.\d{1,3}:\d+$/,
      /^http:\/\/10\.\d{1,3}\.\d{1,3}\.\d{1,3}:\d+$/,
    ];
  }
  return false;
}

async function main() {
  initSentry();

  // 🛡️ TRAVA DE STAGING: quando APP_ENV=staging, o processo se RECUSA a subir se
  // estiver apontando pro banco de PRODUÇÃO ou fora do modo simulador. Impossível
  // um staging mal-configurado tocar dados reais ou disparar WhatsApp de verdade.
  // (Só dispara com APP_ENV=staging — produção nunca seta isso, então nunca é afetada.)
  if ((process.env['APP_ENV'] ?? '').toLowerCase() === 'staging') {
    const PROD_DB_REF = 'niqmxiybiwrfkvdfojcq';
    const supaUrl = process.env['SUPABASE_URL'] ?? '';
    const mode = process.env['WHATSAPP_MODE'] ?? '';
    const problems: string[] = [];
    if (supaUrl.includes(PROD_DB_REF)) problems.push(`SUPABASE_URL aponta pro banco de PRODUÇÃO (${PROD_DB_REF})`);
    if (mode !== 'simulator') problems.push(`WHATSAPP_MODE="${mode}" — staging DEVE usar "simulator" (nada de envio real)`);
    if (problems.length) {
      console.error('\n🛑 BOOT DE STAGING BLOQUEADO — proteção contra tocar produção:');
      for (const p of problems) console.error(`   • ${p}`);
      console.error('   Corrija o .env do staging (SUPABASE_URL de um banco isolado + WHATSAPP_MODE=simulator) e suba de novo.\n');
      process.exit(1);
    }
    console.log('✅ Staging validado: banco isolado + modo simulador (sem envio real).');
  }

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
      // Telefone aparece em paths tipo /app/overview/+55... — mascara qualquer
      // sequência longa de dígitos na URL logada (LGPD / CLAUDE.md regra 3).
      serializers: {
        req(req: { method: string; url: string; headers: Record<string, unknown>; socket?: { remoteAddress?: string } }) {
          return {
            method: req.method,
            url: req.url.replace(/\d{8,}/g, (m) => `${m.slice(0, 4)}…${m.slice(-2)}`),
            remoteAddress: req.socket?.remoteAddress,
          };
        },
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
    app.register(webhookZproRoute, { prefix: '/webhook' });
    app.register(adminRoute, { prefix: '/admin' });
    // Rotas do Xarlote App (cliente final) — ativas também em produção.
    app.register(appRoute, { prefix: '/app' });
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
