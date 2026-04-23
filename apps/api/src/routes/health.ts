import type { FastifyInstance } from 'fastify';
import { db } from '@iasaude/db';

export async function healthRoute(app: FastifyInstance) {
  app.get('/health', async (_req, reply) => {
    let dbOk = false;
    try {
      const { error } = await db.from('users').select('id').limit(1);
      dbOk = !error;
    } catch { /* ok */ }

    return reply.send({
      ok: true,
      db: dbOk ? 'ok' : 'error',
      whatsapp_mode: process.env['WHATSAPP_MODE'] ?? 'uazapi',
      ts: new Date().toISOString(),
    });
  });
}
