/**
 * O link do médico — criar, listar e revogar. Tudo autenticado pelo paciente.
 *
 * A rota PÚBLICA que o médico abre é outra (`routes/share-public.ts`): separá-las é o que
 * garante que ninguém confunda "quem cria" com "quem consome". Aqui só entra o dono.
 *
 * ## O token aparece UMA vez
 *
 * A resposta da criação é o único momento em que o token existe em texto claro. O banco
 * guarda só o hash, e a listagem devolve metadados — nunca o token. Se o paciente perder
 * o link, ele gera outro; não há como recuperar, e isso é a propriedade, não um limite.
 */
import type { FastifyInstance } from 'fastify';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { db, writeAudit } from '@iasaude/db';
import { requirePatient } from '../../middleware/patient-auth.js';
import {
  SHARE_TTL_MAX_H,
  SHARE_TTL_PADRAO_H,
  expiraEm,
  hashPin,
  hashShareToken,
  montarResumo,
  novoShareToken,
  pinValido,
} from '../../lib/share-grants.js';

const CriarSchema = z.object({
  /** 1 a 168 horas. O clamp real está em `expiraEm` — aqui é só a borda do contrato. */
  horas: z.number().int().min(1).max(SHARE_TTL_MAX_H).optional(),
  /** 4 dígitos, ou ausente para link sem PIN. */
  pin: z.string().optional(),
});

/** Quantos links ATIVOS um paciente pode ter ao mesmo tempo. */
const MAX_ATIVOS = 5;

export async function appSharesRoutes(app: FastifyInstance): Promise<void> {
  // ─── POST /app/shares ─────────────────────────────────────────────────────
  app.post('/shares', { preHandler: requirePatient }, async (req, reply) => {
    const parsed = CriarSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });

    const { horas, pin } = parsed.data;
    if (pin !== undefined && pin !== '' && !pinValido(pin)) {
      return reply.code(400).send({ error: 'pin_invalido', message: 'O PIN precisa ter 4 números.' });
    }

    const userId = req.patient!.userId;
    const agora = Date.now();

    // Teto de links vivos: cada um é uma porta aberta pro prontuário, e um app com bug de
    // toque duplo não pode virar uma fábrica de portas.
    const { count: ativos } = await db
      .from('share_grants')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId)
      .is('revoked_at', null)
      .gt('expires_at', new Date(agora).toISOString());

    if ((ativos ?? 0) >= MAX_ATIVOS) {
      return reply.code(409).send({
        error: 'muitos_links',
        message: `Você já tem ${MAX_ATIVOS} links ativos. Revoga algum antes de criar outro.`,
      });
    }

    const token = novoShareToken(randomBytes);
    const salt = pin && pinValido(pin) ? randomBytes(16).toString('hex') : null;

    // O resumo é congelado AQUI e guardado no grant.
    //
    // Duas razões: a página do médico abre sem tocar no prontuário vivo (uma superfície
    // pública a menos consultando dado clínico), e o que o médico vê é o que o paciente
    // decidiu mostrar no momento em que compartilhou — não o estado de amanhã, que ele
    // não autorizou.
    const [{ data: user }, { data: alergias }, { data: medicamentos }, { data: condicoes }, { data: exames }] =
      await Promise.all([
        db.from('users').select('preferred_name, full_name, birth_date, adherence_score_30d').eq('id', userId).maybeSingle(),
        db.from('user_allergies').select('substance, reaction, severity').eq('user_id', userId),
        db.from('user_medications').select('medication_name, dosage, frequency').eq('user_id', userId).eq('active', true),
        db.from('user_health_conditions').select('name, onset_date').eq('user_id', userId),
        db.from('user_exam_results').select('exam_type, title, exam_date, summary, findings').eq('user_id', userId).order('exam_date', { ascending: false, nullsFirst: false }).limit(10),
      ]);

    if (!user) return reply.code(404).send({ error: 'user_gone' });

    const resumo = montarResumo(
      {
        user,
        alergias: alergias ?? [],
        medicamentos: medicamentos ?? [],
        condicoes: condicoes ?? [],
        exames: exames ?? [],
      },
      agora,
    );

    const expira = expiraEm(horas, agora);
    const { data: criado, error } = await db
      .from('share_grants')
      .insert({
        user_id: userId,
        token_hash: hashShareToken(token),
        pin_hash: salt && pin ? hashPin(pin, salt) : null,
        pin_salt: salt,
        summary_cache: resumo as unknown as Record<string, unknown>,
        expires_at: expira.toISOString(),
      })
      .select('id, expires_at, created_at')
      .single();

    if (error || !criado) return reply.code(500).send({ error: 'share_failed' });

    void writeAudit({
      actorType: 'user',
      action: 'share.created',
      userId,
      targetTable: 'share_grants',
      targetId: criado.id as string,
      reason: 'paciente compartilhou resumo com profissional',
      // Sem token e sem PIN no audit: é o próprio segredo.
      metadata: { com_pin: !!salt, horas: horas ?? SHARE_TTL_PADRAO_H },
    });

    const base = process.env['WEB_PUBLIC_URL']?.replace(/\/+$/, '') ?? '';
    return reply.code(201).send({
      id: criado.id,
      // ÚNICA vez que o token existe em claro. O banco só tem o hash.
      token,
      url: base ? `${base}/s/${token}` : null,
      expiresAt: criado.expires_at,
      comPin: !!salt,
    });
  });

  // ─── GET /app/shares ──────────────────────────────────────────────────────
  app.get('/shares', { preHandler: requirePatient }, async (req, reply) => {
    const { data } = await db
      .from('share_grants')
      // Sem `token_hash`: nem o dono precisa dele, e o que não sai não vaza.
      .select('id, expires_at, revoked_at, access_count, last_accessed_at, created_at, pin_hash')
      .eq('user_id', req.patient!.userId)
      .order('created_at', { ascending: false })
      .limit(20);

    return reply.send({
      shares: (data ?? []).map((s) => ({
        id: s.id,
        expiresAt: s.expires_at,
        revokedAt: s.revoked_at,
        acessos: s.access_count,
        ultimoAcesso: s.last_accessed_at,
        criadoEm: s.created_at,
        comPin: s.pin_hash !== null,
      })),
    });
  });

  // ─── DELETE /app/shares/:id ───────────────────────────────────────────────
  app.delete<{ Params: { id: string } }>('/shares/:id', { preHandler: requirePatient }, async (req, reply) => {
    const userId = req.patient!.userId;

    // `eq('user_id')` no UPDATE, não um SELECT antes: revogar o link de outro paciente
    // por id adivinhado não pode ser possível nem por uma janela de corrida.
    const { data, error } = await db
      .from('share_grants')
      .update({ revoked_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .eq('user_id', userId)
      .is('revoked_at', null)
      .select('id');

    if (error) return reply.code(500).send({ error: 'revoke_failed' });
    if (!data || data.length === 0) return reply.code(404).send({ error: 'not_found' });

    void writeAudit({
      actorType: 'user',
      action: 'share.revoked',
      userId,
      targetTable: 'share_grants',
      targetId: req.params.id,
      reason: 'paciente revogou o link',
    });

    return reply.send({ ok: true });
  });
}
