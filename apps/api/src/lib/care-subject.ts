/**
 * care-subject — de quem é a "bolsa" que esta requisição está pedindo.
 *
 * O JWT diz quem está falando (`sub`); ele NUNCA diz de quem é o dado. Um app que
 * pudesse escolher o sujeito sozinho tornaria o vínculo decorativo — bastaria trocar um
 * id na query. Por isso a validação acontece AQUI, no servidor, a cada requisição, contra
 * `care_links`. Não há cache entre requisições: revogar tem que valer no próximo toque de
 * tela, não no próximo login.
 *
 * Sem `?subject`, é o próprio — o caminho de praticamente todo request, e o mais barato
 * (nem consulta o banco).
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import { writeEvent } from '@iasaude/db';
import { podeAtuarSobre, type CareCapability, type CareLinkView } from '@iasaude/shared';
import { carregarVinculosDoCuidador } from './care-links.js';

export interface SujeitoDaRequisicao {
  /** De quem é o dado. */
  userId: string;
  /** Quem pediu, quando é diferente do dono. `null` no acesso ao próprio registro. */
  caregiverUserId: string | null;
  /** O vínculo usado, pra log e pra resposta. */
  link: CareLinkView | null;
}

/**
 * Resolve e AUTORIZA o sujeito de uma requisição autenticada.
 *
 * Devolve `null` **depois de já ter respondido** quando o acesso é negado — mesmo
 * contrato do `requirePatient`, pra rota poder fazer `if (!s) return;`.
 *
 * O 404 (e não 403) no caso sem vínculo é deliberado: 403 confirmaria que aquele
 * `users.id` existe, e uma rota autenticada não precisa ser um oráculo de ids.
 */
export async function resolverSujeitoDaRequisicao(
  req: FastifyRequest,
  reply: FastifyReply,
  capacidade: CareCapability = 'ver',
): Promise<SujeitoDaRequisicao | null> {
  const atorId = req.patient!.userId;
  const pedido = (req.query as { subject?: string } | undefined)?.subject?.trim();

  if (!pedido || pedido === atorId) {
    return { userId: atorId, caregiverUserId: null, link: null };
  }

  const vinculos = await carregarVinculosDoCuidador(atorId);
  const v = podeAtuarSobre(atorId, pedido, vinculos, capacidade);
  if (!v.pode) {
    // Tentativa de ler prontuário alheio é sinal de segurança, não ruído de produto:
    // vai pro event_log com severidade, sem conteúdo clínico e sem confirmar o id.
    void writeEvent({
      eventName: 'care.access_denied',
      severity: 'warn',
      userId: atorId,
      payload: { motivo: v.motivo, capacidade },
    });
    reply.code(404).send({ error: 'sem_acesso', message: 'Você não tem acesso a esse registro.' });
    return null;
  }

  const link = v.via === 'vinculo' ? v.link : null;
  void writeEvent({
    eventName: 'care.subject_read',
    userId: pedido,
    payload: { por_cuidador: atorId, capacidade, relation: link?.relation ?? null },
  });
  return { userId: pedido, caregiverUserId: atorId, link };
}
