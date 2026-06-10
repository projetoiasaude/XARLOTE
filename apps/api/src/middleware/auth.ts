import { createHash, timingSafeEqual } from 'crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * Auth de admin pra rotas sensíveis (/admin, /api/simulate).
 *
 * Modelo de ameaça (F0): a API roda exposta no Railway; o dashboard é uma
 * ferramenta interna. Sem isto, qualquer um na internet lê todo PII clínico,
 * troca a chave da LLM e pode apagar o banco. Token compartilhado forte é o
 * suficiente pra F0 — F1 troca por Supabase Auth + RBAC por usuário.
 *
 * Comportamento quando ADMIN_API_TOKEN não está setado:
 *   - produção  → NEGA (503 fail-closed): obriga configurar antes de expor.
 *   - dev/local → permite, com aviso no log (pra não travar o desenvolvimento).
 */

function constantTimeEquals(a: string, b: string): boolean {
  // hash em comprimento fixo evita vazar tamanho e satisfaz timingSafeEqual
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

function extractToken(req: FastifyRequest): string | undefined {
  const header = req.headers['x-admin-token'];
  if (typeof header === 'string' && header.length > 0) return header;
  const auth = req.headers['authorization'];
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) return auth.slice(7);
  return undefined;
}

let warnedMissingToken = false;

export async function requireAdminToken(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const expected = process.env['ADMIN_API_TOKEN'];
  const isProd = process.env['NODE_ENV'] === 'production';

  if (!expected) {
    if (isProd) {
      reply.code(503).send({
        error: 'admin_auth_not_configured',
        message: 'ADMIN_API_TOKEN não configurado no servidor. Defina antes de expor o admin.',
      });
      return;
    }
    if (!warnedMissingToken) {
      req.log.warn('⚠️  ADMIN_API_TOKEN não definido — rotas /admin e /api/simulate estão ABERTAS (modo dev). Defina pra travar.');
      warnedMissingToken = true;
    }
    return;
  }

  const provided = extractToken(req);
  if (!provided || !constantTimeEquals(provided, expected)) {
    reply.code(401).send({ error: 'unauthorized', message: 'Token de admin ausente ou inválido.' });
    return;
  }
}

let warnedMissingAppToken = false;

/**
 * Auth das rotas DO APP CLIENTE (`/app`). Diferente do admin: o bundle do app
 * é PÚBLICO (qualquer um baixa o JS), então NÃO pode carregar o token de admin
 * (que apaga banco / troca chave da LLM / lê tudo via /admin). Este gate aceita
 * um `APP_API_TOKEN` dedicado (escopo só /app) — e também o admin, por conveniência
 * em dev/local. Mesmo header (`x-admin-token` / Bearer).
 *
 * Risco residual conhecido (MVP): com o app-token público, dá pra consultar /app
 * por telefone — é o mesmo nível de "auth" do pareamento atual (digitar o número).
 * A blindagem real (Supabase Auth + OTP + RLS por usuário) é a próxima fase.
 */
export async function requireAppToken(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const accepted = [process.env['APP_API_TOKEN'], process.env['ADMIN_API_TOKEN']].filter(
    (t): t is string => typeof t === 'string' && t.length > 0,
  );
  const isProd = process.env['NODE_ENV'] === 'production';

  if (accepted.length === 0) {
    if (isProd) {
      reply.code(503).send({
        error: 'app_auth_not_configured',
        message: 'APP_API_TOKEN não configurado no servidor.',
      });
      return;
    }
    if (!warnedMissingAppToken) {
      req.log.warn('⚠️  APP_API_TOKEN/ADMIN_API_TOKEN não definidos — /app está ABERTO (modo dev).');
      warnedMissingAppToken = true;
    }
    return;
  }

  const provided = extractToken(req);
  if (!provided || !accepted.some((t) => constantTimeEquals(provided, t))) {
    reply.code(401).send({ error: 'unauthorized', message: 'Token do app ausente ou inválido.' });
    return;
  }
}
