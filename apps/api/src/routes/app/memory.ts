/**
 * `DELETE /app/memory/:id` — a pessoa apaga um aprendizado que a Xarlote formou sobre ela.
 *
 * ## Por que isto existe
 *
 * A tela de Perfil mostra o que a Xarlote deduziu de conversas — "prefere tomar remédio de
 * manhã", "tem medo de agulha". Quando ela erra, a pessoa precisa poder tirar. Um app de
 * saúde que afirma coisas sobre você e não deixa você corrigir é assustador, e o fundador
 * pediu isso com todas as letras: "corrigir ou apagar o errado".
 *
 * Até aqui o único apagamento possível era o da conta inteira. Tudo ou nada não é controle.
 *
 * ## Apagar nos DOIS lugares, e por quê
 *
 * A memória vive em dois lugares, de propósito (ver `packages/db/src/memory.ts`):
 *
 * · `conversations.memory_cards` (JSONB) — a **fonte canônica**, que a LGPD alcança:
 *   é ela que sai na portabilidade e no export.
 * · `memory_cards_index` — o **espelho indexado**, com embedding, que alimenta a busca
 *   semântica que monta o prompt da Xarlote.
 *
 * Apagar só o espelho deixaria o card **morto na tela e vivo no registro**: a pessoa veria
 * "pronto, tirei", pediria o próprio arquivo pela LGPD e ele estaria lá. Apagar só o
 * canônico deixaria o inverso, pior ainda: sumiria da tela e a Xarlote continuaria citando.
 * As duas metades são uma coisa só.
 *
 * ## A trava, e a regra que ela honra
 *
 * O `profile-enricher.worker.ts` faz leitura-modificação-escrita no MESMO JSONB, a cada
 * turno, e por isso já roda sob `withUserLock`. Sem entrar na mesma fila, uma escrita do
 * enricher iniciada antes daqui sobrescreveria o array inteiro e **ressuscitaria o card**
 * que a pessoa acabou de apagar — silenciosamente, e só na próxima vez que ela abrisse a
 * tela. É a regra do projeto: dois leitores do mesmo JSONB, a segunda escrita apaga a
 * primeira.
 */
import type { FastifyInstance } from 'fastify';
import { db, writeAudit } from '@iasaude/db';
import { requirePatient } from '../../middleware/patient-auth.js';
import { withUserLock } from '../../concurrency/user-lock.js';

interface CardJsonb {
  id?: unknown;
  [k: string]: unknown;
}

/**
 * Tira o card de um array de JSONB. Devolve `null` quando não havia nada a tirar — o que
 * distingue "removi" de "já não estava lá" sem uma segunda consulta.
 */
export function semOCard(cards: readonly CardJsonb[], id: string): CardJsonb[] | null {
  // Id vazio não casa com NADA. Sem esta guarda, o `?? ''` do coalescente fazia um card
  // sem `id` virar `''`, e uma busca por `''` varreria todos eles de uma vez. A rota não
  // consegue produzir isso (`/memory/` não casa com `/memory/:id`), mas a função é pura e
  // não deve depender de quem a chama pra não destruir dado.
  if (id.length === 0) return null;

  const restantes = cards.filter((c) => {
    const bruto = c?.id;
    // Card sem id fica, sempre: não dá pra afirmar que ele é o alvo.
    if (bruto === null || bruto === undefined) return true;
    // `String()` porque o JSONB aceita número e o `:id` da rota chega sempre como texto.
    return String(bruto) !== id;
  });

  return restantes.length === cards.length ? null : restantes;
}

export async function appMemoryRoutes(app: FastifyInstance): Promise<void> {
  app.delete<{ Params: { id: string } }>(
    '/memory/:id',
    { preHandler: requirePatient },
    async (req, reply) => {
      const userId = req.patient!.userId;
      const cardId = req.params.id;

      // Leitura só pra saber ONDE mexer (qual conversa) e se existe. A autorização real
      // não se apoia nela: o DELETE lá embaixo repete `eq('user_id')`, então uma corrida
      // entre este SELECT e ele não vira apagamento do card de outra pessoa.
      const { data: card, error: errBusca } = await db
        .from('memory_cards_index')
        .select('id, conversation_id, kind, text')
        .eq('id', cardId)
        .eq('user_id', userId)
        .maybeSingle();

      if (errBusca) {
        req.log.error({ err: errBusca.message }, 'busca do card de memória falhou');
        return reply.code(500).send({ error: 'busca_falhou' });
      }
      // 404 e não 403: id de card de outra pessoa e id inexistente respondem igual, senão
      // a resposta vira um oráculo que confirma a existência de cards alheios.
      if (!card) return reply.code(404).send({ error: 'not_found' });

      const resultado = await withUserLock(
        userId,
        async () => {
          // ── 1. O canônico primeiro ───────────────────────────────────────────────
          // Se esta metade falhar, nada foi apagado e a pessoa pode tentar de novo. Na
          // ordem inversa, uma falha aqui deixaria o card fora da busca e dentro do
          // registro — "apagado" pra Xarlote e presente na portabilidade.
          const conversationId = card.conversation_id as string | null;

          // `conversation_id` é `on delete set null`: quando a conversa some, o card
          // sobrevive sem endereço. Aí o jeito de achá-lo é varrer as conversas da
          // pessoa — que são poucas, e é melhor do que deixar órfão no canônico.
          const { data: conversas, error: errConv } = conversationId
            ? await db.from('conversations').select('id, memory_cards').eq('id', conversationId).eq('user_id', userId)
            : await db.from('conversations').select('id, memory_cards').eq('user_id', userId);

          if (errConv) throw new Error(`leitura das conversas falhou: ${errConv.message}`);

          for (const conv of conversas ?? []) {
            const cards = Array.isArray(conv.memory_cards) ? (conv.memory_cards as CardJsonb[]) : [];
            const restantes = semOCard(cards, cardId);
            if (!restantes) continue;

            const { error: errUpd } = await db
              .from('conversations')
              .update({ memory_cards: restantes })
              .eq('id', conv.id);
            if (errUpd) throw new Error(`remoção do card no JSONB falhou: ${errUpd.message}`);
          }

          // ── 2. O espelho ─────────────────────────────────────────────────────────
          const { data: apagados, error: errDel } = await db
            .from('memory_cards_index')
            .delete()
            .eq('id', cardId)
            .eq('user_id', userId)
            .select('id');

          if (errDel) throw new Error(`apagamento do espelho falhou: ${errDel.message}`);
          return (apagados?.length ?? 0) > 0;
        },
        { scope: 'memory', waitMs: 6_000 },
      );

      // `withUserLock` devolve `null` quando não conseguiu a vez. Isso NÃO é sucesso, e
      // responder 204 aqui ensinaria a tela a dizer "apaguei" sem ter apagado.
      if (resultado === null) {
        return reply.code(409).send({
          error: 'ocupado',
          message: 'Estou organizando sua memória agora. Tenta de novo em alguns segundos?',
        });
      }

      void writeAudit({
        actorType: 'user',
        actorId: userId,
        action: 'app.memory.card_deleted',
        userId,
        targetTable: 'memory_cards_index',
        targetId: cardId,
        // O TEXTO do card fica de fora de propósito. Guardar em `audit_log` — que é
        // append-only — o conteúdo que a pessoa acabou de mandar apagar seria criar uma
        // cópia justamente do que ela pediu para não existir mais. O tipo e o tamanho
        // provam que o apagamento aconteceu sem preservar o que foi apagado.
        before: { kind: card.kind, caracteres: String(card.text ?? '').length },
      });

      return reply.code(204).send();
    },
  );
}
