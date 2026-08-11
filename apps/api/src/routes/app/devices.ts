/**
 * /app/devices — o registro de push do app, agora AUTENTICADO.
 *
 * Substitui `POST /app/push/register` (routes/app.ts), que era um dos buracos da
 * auditoria de 05/08: ele aceitava `{phone, token}` sem autenticação nenhuma. Qualquer
 * pessoa podia registrar o PRÓPRIO aparelho no telefone de outro paciente e passar a
 * receber os lembretes de remédio, as respostas da Xarlote e os avisos de consulta
 * dele — sequestro de notificação clínica, sem precisar de senha.
 *
 * Aqui o `userId` vem do JWT e NUNCA do corpo. É a diferença entre "o cliente diz
 * quem é" e "o servidor sabe quem é".
 *
 * O legado continua no ar até o web migrar (F5); quem morre primeiro é o uso pelo app.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { registerDeviceToken, unregisterDeviceTokenForUser, writeAudit } from '@iasaude/db';
import { requirePatient } from '../../middleware/patient-auth.js';

const RegisterSchema = z.object({
  // Token do FCM. Largo de propósito (eles crescem entre versões do SDK), mas com teto
  // — é chave única numa tabela indexada.
  token: z.string().min(20).max(4096),
  platform: z.enum(['ios', 'android', 'web']),
  appVersion: z.string().max(32).optional(),
});

const UnregisterSchema = z.object({ token: z.string().min(20).max(4096) });

export async function appDevicesRoutes(app: FastifyInstance): Promise<void> {
  app.post('/devices', { preHandler: requirePatient }, async (req, reply) => {
    const parsed = RegisterSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });

    const userId = req.patient!.userId;
    // Upsert por token: reabrir o app com o mesmo token não cria linha nova, e um
    // token que MUDOU de dono (aparelho revendido, conta trocada no mesmo celular)
    // passa a apontar pro dono atual em vez de continuar entregando pro antigo.
    await registerDeviceToken(userId, parsed.data.token, parsed.data.platform, parsed.data.appVersion);

    // Auditoria sem o token (ele é credencial de entrega): só a plataforma.
    await writeAudit({
      actorType: 'user',
      action: 'app.device.registered',
      userId,
      targetTable: 'device_tokens',
      metadata: { platform: parsed.data.platform, appVersion: parsed.data.appVersion ?? null },
    });

    return reply.code(204).send();
  });

  app.delete('/devices', { preHandler: requirePatient }, async (req, reply) => {
    const parsed = UnregisterSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });

    // Escopado pelo dono: sem o `user_id`, conhecer o token de push de alguém
    // permitiria DESLIGAR os lembretes de remédio dessa pessoa.
    await unregisterDeviceTokenForUser(req.patient!.userId, parsed.data.token);
    return reply.code(204).send();
  });
}
