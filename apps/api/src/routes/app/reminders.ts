/**
 * Lembretes do paciente — a lista e as três ações (feito / adiar / cancelar).
 *
 * ## Por que a ação vive AQUI e não no plugin legado
 *
 * Os dois plugins montam sob o mesmo prefixo `/app`, e Fastify não registra dois
 * handlers para `/app/reminders/:id/action`. Como o web legado ainda chama essa rota
 * com token compartilhado + telefone no corpo, e o app nativo chama com JWT, a rota
 * é ÚNICA e reconhece as duas credenciais — o "dual-auth" previsto no plano.
 *
 * A ordem importa e é deliberada: **tenta o JWT primeiro**. `requireAppToken` leria o
 * mesmo header `Authorization: Bearer`, acharia um JWT onde esperava o token do app e
 * responderia 401 — o app nativo nunca conseguiria confirmar um remédio.
 *
 * O que NÃO acontece aqui: o JWT valer como credencial nas outras rotas legadas. Um
 * paciente autenticado não ganha `POST /app/overview` com telefone arbitrário — é
 * exatamente o buraco que a F0 fechou. A exceção é uma rota só, e por um motivo
 * mecânico (colisão de path), não por conveniência.
 *
 * ## Autorização é por DONO, sempre
 *
 * Nos dois caminhos o lembrete é comparado com o usuário resolvido (`user_id`) antes
 * do patch. Sem isso, um id de lembrete adivinhado deixaria alguém cancelar o
 * remédio de outra pessoa — a cadeia de ataque que a auditoria de 05/08 documentou.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { db, findUserByPhone, writeEvent } from '@iasaude/db';
import { brPhoneVariants, nextOccurrence, reminderActionPatch } from '@iasaude/shared';
import { requirePatient, tryPatient } from '../../middleware/patient-auth.js';
import { requireAppToken } from '../../middleware/auth.js';
import { checkUserRateLimit } from '../../middleware/rate-limit.js';

/** As colunas que o app desenha. `select('*')` traria campos internos sem uso. */
const REMINDER_COLUMNS =
  'id, type, title, body, scheduled_at, rrule, next_run_at, status, payload, medication_id, created_at, last_confirmed_at';

const ActionSchema = z.object({
  /** Só no caminho legado — no caminho JWT o telefone é ignorado se vier. */
  phone: z.string().min(8).max(20).optional(),
  action: z.enum(['done', 'snooze', 'cancel']),
  minutes: z.number().int().min(5).max(24 * 60).optional(),
});

async function findUserByAnyVariant(phoneRaw: string) {
  const trimmed = phoneRaw.replace(/[^\d+]/g, '');
  const e164 = trimmed.startsWith('+') ? trimmed : `+${trimmed}`;
  if (!/^\+\d{10,15}$/.test(e164)) return null;
  for (const candidate of brPhoneVariants(e164)) {
    const user = await findUserByPhone(candidate);
    if (user) return user;
  }
  return null;
}

/**
 * Quem está pedindo — JWT do app, ou token compartilhado + telefone (web legado).
 *
 * Devolve `null` quando já respondeu (401/429/404): quem chama só precisa sair.
 */
async function resolveOwner(
  req: FastifyRequest,
  reply: FastifyReply,
  phone: string | undefined,
): Promise<string | null> {
  const patient = tryPatient(req);
  if (patient) {
    /**
     * Marcar `req.patient` NÃO é decoração — é o que a auditoria lê.
     *
     * A primeira versão devolvia só o `userId`, e o `writeEvent` logo abaixo grava
     * `via: req.patient ? 'jwt' : 'legacy_token'`. Sem esta linha, TODA ação vinda do app
     * nativo era registrada como `legacy_token`. Peguei no primeiro toque real: o
     * lembrete foi adiado com sucesso pelo JWT e o log disse que veio do token do web.
     *
     * O campo existe pra sustentar UMA decisão específica — no F5, provar que ninguém
     * mais chega por telefone antes de remover a rota legada. Um campo que sempre diz
     * "legado" faria essa decisão em cima de dado falso, e a rota antiga ficaria viva
     * pra sempre (ou seria removida às cegas). Detecção que não propaga é pior que
     * ausência de detecção.
     */
    req.patient = patient;
    return patient.userId;
  }

  // Caminho legado. O plugin novo não tem hook global, então os dois guardas que o
  // legado aplicava (token do app + anti-flood) são chamados à mão — tirá-los junto
  // com a mudança de arquivo transformaria um refactor em regressão de segurança.
  await requireAppToken(req, reply);
  if (reply.sent) return null;

  if (!phone) {
    await reply.code(401).send({ error: 'unauthorized' });
    return null;
  }

  const rl = await checkUserRateLimit(`app:${phone}`);
  if (!rl.allowed) {
    await reply
      .code(429)
      .send({ error: 'rate_limited', message: 'Calma! Muitas ações em sequência. Tenta de novo em alguns segundos.' });
    return null;
  }

  const user = await findUserByAnyVariant(phone);
  if (!user) {
    await reply.code(404).send({ error: 'user_not_found' });
    return null;
  }
  return user.id;
}

export async function appRemindersRoutes(app: FastifyInstance): Promise<void> {
  /**
   * A lista. O overview já traz lembretes, mas a tela de Lembretes recarrega sozinha
   * (voltou do background, confirmou uma dose) — e puxar as 14 consultas do prontuário
   * inteiro pra atualizar uma lista seria desperdício numa rede móvel.
   */
  app.get('/reminders', { preHandler: requirePatient }, async (req, reply) => {
    const { data, error } = await db
      .from('reminders')
      .select(REMINDER_COLUMNS)
      .eq('user_id', req.patient!.userId)
      // `nullsFirst: false` porque lembrete sem próxima execução (concluído, cancelado)
      // tem que ir pro fim: o topo da tela é o que ainda vai acontecer.
      .order('next_run_at', { ascending: true, nullsFirst: false })
      .limit(120);

    if (error) return reply.code(500).send({ error: 'query_failed' });
    return reply.send({ reminders: data ?? [] });
  });

  app.post<{ Params: { id: string } }>('/reminders/:id/action', async (req, reply) => {
    const parsed = ActionSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

    const userId = await resolveOwner(req, reply, parsed.data.phone);
    if (userId === null) return reply; // resolveOwner já respondeu

    const { data: reminder } = await db
      .from('reminders')
      .select('id, user_id, status, next_run_at, rrule')
      .eq('id', req.params.id)
      .maybeSingle();

    if (!reminder) return reply.code(404).send({ error: 'reminder_not_found' });
    if (reminder.user_id !== userId) return reply.code(403).send({ error: 'forbidden' });

    const nextRecurring = reminder.rrule ? nextOccurrence(reminder.rrule) : null;
    const decision = reminderActionPatch(
      {
        status: reminder.status as string,
        rrule: reminder.rrule as string | null,
        nextRecurringIso: nextRecurring?.toISOString() ?? null,
      },
      parsed.data.action,
      parsed.data.minutes,
      Date.now(),
    );
    if (decision.kind === 'reject') return reply.code(409).send({ error: 'reminder_cancelled' });

    const { error } = await db.from('reminders').update(decision.patch).eq('id', reminder.id);
    if (error) return reply.code(500).send({ error: error.message });

    void writeEvent({
      eventName: 'app.reminder_action',
      userId,
      payload: {
        reminder_id: reminder.id,
        action: parsed.data.action,
        minutes: parsed.data.minutes ?? null,
        // Qual credencial agiu: quando o web migrar (F5), este campo é o que prova que
        // ninguém mais chega por telefone antes de a rota legada ser removida.
        via: req.patient ? 'jwt' : 'legacy_token',
      },
    });

    // Devolve a linha inteira já atualizada: a tela substitui o estado otimista pelo
    // real sem um segundo round-trip, e sem ter que adivinhar o que o servidor decidiu
    // (um "feito" em lembrete recorrente volta `pending` com outra data, não `done`).
    const { data: updated } = await db
      .from('reminders')
      .select(REMINDER_COLUMNS)
      .eq('id', reminder.id)
      .single();

    return reply.send({ ok: true, reminder: updated });
  });
}
