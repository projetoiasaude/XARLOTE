/**
 * patient-auth — o middleware que dá IDENTIDADE às rotas do app.
 *
 * Substitui (nas rotas novas) o modelo antigo em que o "quem" era o `phone` do body
 * não-autenticado — o buraco que permitia ler o prontuário de qualquer telefone.
 * Aqui a identidade vem de um access JWT curto (15min) assinado pelo servidor;
 * a revogação dura acontece no refresh (app_sessions).
 *
 * Dois 401 DIFERENTES de propósito:
 *   • `token_expired` → o app faz refresh silencioso e repete a request.
 *   • `unauthorized`  → o app desloga (token forjado/malformado não merece retry).
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import { verifyAppJwt } from '../lib/app-jwt.js';

export interface PatientIdentity {
  userId: string;
  sessionId: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    patient?: PatientIdentity;
  }
}

let warnedMissingSecret = false;

export async function requirePatient(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const secret = process.env['APP_JWT_SECRET'];
  if (!secret) {
    // Fail-closed SEMPRE (até em dev): um secret ausente aqui não pode significar
    // "prontuário aberto" — é a lição do requireAppToken, que abre em dev e já
    // confundiu diagnóstico. Login de dev usa um secret de dev no .env.
    if (!warnedMissingSecret) {
      req.log.error('APP_JWT_SECRET não configurado — TODAS as rotas de paciente vão responder 503.');
      warnedMissingSecret = true;
    }
    reply.code(503).send({ error: 'app_auth_not_configured', message: 'APP_JWT_SECRET ausente no servidor.' });
    return;
  }

  const auth = req.headers['authorization'];
  const token = typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7) : undefined;
  if (!token) {
    reply.code(401).send({ error: 'unauthorized' });
    return;
  }

  const v = verifyAppJwt(token, secret, Date.now());
  if (!v.ok) {
    if (v.reason === 'expired') {
      reply.code(401).send({ error: 'token_expired' });
      return;
    }
    reply.code(401).send({ error: 'unauthorized' });
    return;
  }

  req.patient = { userId: v.claims.sub, sessionId: v.claims.sid };
}
