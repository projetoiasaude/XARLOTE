/**
 * `POST /share/resolve` — a única rota PÚBLICA que devolve dado clínico.
 *
 * Ela existe para o médico: o paciente manda um endereço, o médico abre no navegador, e a
 * página chama isto para buscar o resumo. Sem app, sem cadastro, sem login.
 *
 * Por ser pública e clínica, cada decisão aqui é defensiva:
 *
 * · **O token vai no CORPO, nunca na query.** Query string vira access log de proxy, de
 *   CDN e de navegador — é onde credencial some sem ninguém notar.
 * · **Uma única forma de recusa.** Inexistente, expirado, revogado e PIN travado
 *   respondem o MESMO `indisponivel`. Distinguir confirmaria ao atacante que o token
 *   existiu, transformando a busca num jogo com feedback.
 * · **Rate limit por IP**, porque não há usuário autenticado para limitar.
 * · **`X-Robots-Tag: noindex`** na resposta e na página: um prontuário indexado por
 *   buscador é o pior desfecho possível deste recurso.
 * · **O resumo vem do CACHE do grant**, congelado na criação — esta rota nunca toca no
 *   prontuário vivo. O médico vê o que o paciente decidiu mostrar, não o estado de hoje.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db, writeAudit, writeLog } from '@iasaude/db';
import { avaliarShare, hashShareToken } from '../lib/share-grants.js';
import { checkKeyedRateLimit, rateLimiterBlind } from '../middleware/rate-limit.js';

const ResolveSchema = z.object({
  token: z.string().min(20).max(200),
  pin: z.string().max(8).optional(),
});

/** A MESMA resposta para todos os motivos de recusa. Ver o cabeçalho. */
const INDISPONIVEL = {
  error: 'indisponivel',
  message: 'Este link não está mais disponível. Peça um novo ao paciente.',
} as const;

export async function sharePublicRoutes(app: FastifyInstance): Promise<void> {
  app.post('/share/resolve', async (req, reply) => {
    void reply.header('X-Robots-Tag', 'noindex, nofollow');

    const parsed = ResolveSchema.safeParse(req.body);
    // Corpo inválido responde igual ao token inexistente: um 400 distinto já contaria ao
    // atacante que o formato do token dele está certo.
    if (!parsed.success) return reply.code(404).send(INDISPONIVEL);

    // 20 tentativas por IP a cada 10 min. Não há usuário para limitar aqui.
    const rl = await checkKeyedRateLimit(`share:${req.ip}`, { max: 20, windowS: 600 });
    if (rateLimiterBlind(rl)) {
      // Fail-closed com a causa CERTA: o limitador é cego (Redis fora), e dizer "muitas
      // tentativas" a quem não fez nenhuma esconderia uma queda de infra como abuso.
      await writeLog('error', 'share', 'limitador cego no /share/resolve — Redis indisponível', {});
      return reply.code(503).send({ error: 'unavailable', message: 'Indisponível agora. Tenta em instantes.' });
    }
    if (!rl.allowed) {
      return reply.code(429).send({ error: 'rate_limited', message: 'Muitas tentativas. Espera uns minutos.' });
    }

    const { data: grant } = await db
      .from('share_grants')
      .select('id, user_id, expires_at, revoked_at, pin_hash, pin_salt, pin_attempts, summary_cache, access_count')
      .eq('token_hash', hashShareToken(parsed.data.token))
      .maybeSingle();

    if (!grant) return reply.code(404).send(INDISPONIVEL);

    const veredicto = avaliarShare(
      {
        expires_at: grant.expires_at as string,
        revoked_at: grant.revoked_at as string | null,
        pin_hash: grant.pin_hash as string | null,
        pin_salt: grant.pin_salt as string | null,
        pin_attempts: (grant.pin_attempts as number) ?? 0,
      },
      parsed.data.pin,
      Date.now(),
    );

    if (veredicto.kind === 'indisponivel') return reply.code(404).send(INDISPONIVEL);

    if (veredicto.kind === 'pin_necessario') {
      // Só incrementa quando um PIN foi de fato TENTADO. Abrir a página sem digitar nada
      // não pode consumir tentativa — senão o link se autodestrói ao ser aberto 5 vezes.
      if (parsed.data.pin) {
        await db
          .from('share_grants')
          .update({ pin_attempts: ((grant.pin_attempts as number) ?? 0) + 1 })
          .eq('id', grant.id as string);
      }
      return reply.code(401).send({
        error: 'pin_necessario',
        message: parsed.data.pin ? 'PIN incorreto.' : 'Este link pede um PIN de 4 números.',
        tentativasRestantes: veredicto.tentativasRestantes,
      });
    }

    // ── Liberado ──────────────────────────────────────────────────────────
    await db
      .from('share_grants')
      .update({
        access_count: ((grant.access_count as number) ?? 0) + 1,
        last_accessed_at: new Date().toISOString(),
        // Acerto zera o contador: o médico que erra o PIN duas vezes e acerta na terceira
        // não deve chegar mais perto da trava a cada consulta.
        pin_attempts: 0,
      })
      .eq('id', grant.id as string);

    // O paciente tem o direito de saber que alguém abriu o prontuário dele.
    void writeAudit({
      actorType: 'webhook',
      action: 'share.accessed',
      userId: grant.user_id as string,
      targetTable: 'share_grants',
      targetId: grant.id as string,
      reason: 'profissional abriu o resumo compartilhado',
      // Sem IP e sem token: o que interessa ao paciente é QUE foi aberto, e quando.
      metadata: { acesso_numero: ((grant.access_count as number) ?? 0) + 1 },
    });

    return reply.send({ resumo: grant.summary_cache });
  });
}
