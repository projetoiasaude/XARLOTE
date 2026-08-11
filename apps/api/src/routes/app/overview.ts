/**
 * GET /app/overview — a Saúde 360 do paciente, autenticada.
 *
 * A rota legada equivalente resolvia o usuário pelo TELEFONE mandado no corpo. Era o
 * pior buraco da auditoria de 05/08: digitar um número devolvia prontuário completo —
 * condições, alergias, medicamentos, exames, memória clínica. Aqui o usuário vem do
 * JWT, e o telefone nem aparece no contrato.
 *
 * **A leitura é AUDITADA.** Prontuário é dado sensível (LGPD art. 11): a lei espera que
 * exista rastro de quem acessou o quê. `writeEvent` não bloqueia a resposta (`void`) —
 * auditoria que atrasa a tela acabaria sendo removida por alguém, e aí não há rastro
 * nenhum.
 */
import type { FastifyInstance } from 'fastify';
import { db, writeEvent } from '@iasaude/db';
import { requirePatient } from '../../middleware/patient-auth.js';
import { buildOverview, type OverviewUser } from '../../lib/app-overview.js';

export async function appOverviewRoutes(app: FastifyInstance): Promise<void> {
  app.get('/overview', { preHandler: requirePatient }, async (req, reply) => {
    const userId = req.patient!.userId;

    const { data: user } = await db
      .from('users')
      .select('*')
      .eq('id', userId)
      .maybeSingle();

    // Conta apagada (forget-me) com sessão ainda viva no aparelho: 404 derruba o app
    // pro logout local em vez de devolver um prontuário meio-apagado.
    if (!user || (user as { deleted_at?: string | null }).deleted_at) {
      return reply.code(404).send({ error: 'user_gone' });
    }

    const overview = await buildOverview(user as OverviewUser);

    void writeEvent({
      eventName: 'app.overview_read',
      userId,
      // Sem PII e sem conteúdo clínico: só o tamanho de cada seção, que serve pra
      // entender uso e detectar leitura anômala.
      payload: {
        channel: 'xarlote_app',
        exames: (overview['examResults'] as unknown[]).length,
        lembretes: (overview['reminders'] as unknown[]).length,
        memoria: (overview['memoryCards'] as unknown[]).length,
      },
    });

    return reply.send(overview);
  });
}
