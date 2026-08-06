/**
 * Plugin das rotas NOVAS do app do paciente (auth por OTP + API autenticada por JWT).
 *
 * Convive com o plugin legado (`routes/app.ts`, token compartilhado + phone no body)
 * sob o MESMO prefixo `/app` até o web migrar — paths não colidem (a única exceção,
 * /reminders/:id/action, fica no legado com dual-auth). Quando o web /app estiver
 * na API autenticada e a migration 0027 dropar as `anon_read_*`, o legado morre.
 *
 * IMPORTANTE: este plugin NÃO tem preHandler global — auth é POR ROTA (as rotas de
 * OTP são públicas por natureza; todas as demais usam requirePatient).
 */
import type { FastifyInstance } from 'fastify';
import { appAuthRoutes } from './auth.js';
import { appMeRoutes } from './me.js';

export async function appPatientRoutes(app: FastifyInstance): Promise<void> {
  await appAuthRoutes(app);
  await appMeRoutes(app);
}
