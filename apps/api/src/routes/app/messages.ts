/**
 * /app/messages — o histórico do chat e o envio.
 *
 * GET: paginação KEYSET (nunca OFFSET). O índice
 * `messages(conversation_id, created_at desc, id desc)` da 0025 faz a página 1 e a
 * página 1000 custarem o mesmo. Com OFFSET, um paciente antigo rolando o histórico
 * varreria milhares de linhas por página — e o custo cresce justamente pra quem usa
 * mais o produto.
 *
 * POST: responde **202 na hora** e o turno da LLM acontece no worker. O legado
 * (`/app/inbound`) segurava a conexão HTTP os 5-15s do turno; era o teto de
 * throughput do app.
 *
 * A conversa é resolvida pelo JWT, nunca por parâmetro: o paciente não escolhe de
 * qual conversa quer ler.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db, writeEvent } from '@iasaude/db';
import { SARA_INSTANCE, whatsappJidVariants } from '@iasaude/shared';
import { requirePatient } from '../../middleware/patient-auth.js';
import { loadPrompts } from '../../config/prompts.js';
import { decodeCursor, encodeCursor } from '../../lib/messages-cursor.js';
import { appExternalId, isValidClientId } from '../../lib/app-inbound.js';
import { enqueueAppInbound } from '../../queues/app-inbound.queue.js';
import { publishAppEvent } from '../../lib/app-publish.js';
import { APP_CONSENT_VERSION } from './auth.js';

const PAGE_DEFAULT = 30;
const PAGE_MAX = 100;

const ListQuery = z.object({
  cursor: z.string().max(256).optional(),
  limit: z.coerce.number().int().min(1).max(PAGE_MAX).optional(),
});

const SendBody = z.object({
  clientId: z.string(),
  text: z.string().min(1).max(4000),
  /** Carimbo do aparelho, opcional — sem ele o servidor usa o próprio relógio. */
  sentAtMs: z.number().int().positive().optional(),
});

/** A conversa do paciente com a Xarlote (leg `sara`), por qualquer variante do 9º dígito. */
async function findConversation(phoneE164: string): Promise<{ id: string } | null> {
  const { data } = await db
    .from('conversations')
    .select('id')
    .eq('whatsapp_instance', SARA_INSTANCE)
    .in('whatsapp_jid', whatsappJidVariants(phoneE164))
    .order('last_message_at', { ascending: false, nullsFirst: false })
    .limit(1);
  return (data?.[0] as { id: string } | undefined) ?? null;
}

async function patientPhone(userId: string): Promise<string | null> {
  const { data } = await db.from('users').select('phone_e164').eq('id', userId).maybeSingle();
  return (data?.phone_e164 as string | undefined) ?? null;
}

async function consentPending(userId: string): Promise<boolean> {
  const { data } = await db
    .from('consent_events')
    .select('id')
    .eq('user_id', userId)
    .eq('event_type', 'accept')
    .eq('channel', 'app')
    .eq('policy_version', APP_CONSENT_VERSION)
    .limit(1);
  return (data ?? []).length === 0;
}

export async function appMessagesRoutes(app: FastifyInstance): Promise<void> {
  // ─── Histórico ────────────────────────────────────────────────────────────────
  app.get('/messages', { preHandler: requirePatient }, async (req, reply) => {
    const parsed = ListQuery.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_query' });

    const cursor = parsed.data.cursor ? decodeCursor(parsed.data.cursor) : null;
    // Cursor presente mas ilegível é ERRO, não "começa do zero": voltar pro topo
    // silenciosamente faria o app repetir o histórico inteiro no meio da rolagem.
    if (parsed.data.cursor && !cursor) return reply.code(400).send({ error: 'invalid_cursor' });

    const phone = await patientPhone(req.patient!.userId);
    if (!phone) return reply.code(404).send({ error: 'user_gone' });

    const conv = await findConversation(phone);
    // Sem conversa ainda (paciente novo que nunca falou): lista vazia, não erro.
    if (!conv) return reply.send({ messages: [], nextCursor: null, conversationId: null });

    const limit = parsed.data.limit ?? PAGE_DEFAULT;
    let q = db
      .from('messages')
      .select('id, direction, sender_role, content_type, content, external_id, created_at, media_mime')
      .eq('conversation_id', conv.id)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      // Pede uma linha EXTRA pra saber se há próxima página sem um count() separado.
      .limit(limit + 1);

    if (cursor) {
      // Keyset: `(created_at, id) < (cursor)`. O PostgREST não tem tupla, então
      // vira "mais antigo OU (mesmo instante E id menor)" — o `id` desempata
      // mensagens no MESMO timestamp, que acontece nos inserts em lote do worker.
      //
      // Valores entre ASPAS DUPLAS de propósito: o timestamp do Postgres vem como
      // `2026-08-10T13:45:00.123456+00:00`, e essa string vai crua dentro da
      // expressão `or=(...)` do PostgREST. Sem as aspas, o `+` e o `:` ficam à mercê
      // da codificação da URL — o `+` decodificado como espaço viraria um timestamp
      // inválido, e o filtro silenciosamente pararia de cortar, repetindo página.
      const at = `"${cursor.createdAt}"`;
      q = q.or(`created_at.lt.${at},and(created_at.eq.${at},id.lt."${cursor.id}")`);
    }

    const { data, error } = await q;
    if (error) return reply.code(503).send({ error: 'read_failed' });

    const rows = data ?? [];
    const temMais = rows.length > limit;
    const pagina = temMais ? rows.slice(0, limit) : rows;
    const ultima = pagina[pagina.length - 1];

    return reply.send({
      conversationId: conv.id,
      // Ordem cronológica ASCENDENTE na resposta: é como a tela desenha. O DESC do
      // banco existe só pra o índice servir a paginação.
      messages: pagina
        .map((m) => ({
          id: m.id,
          direction: m.direction,
          senderRole: m.sender_role,
          contentType: m.content_type,
          text: m.content,
          mediaMime: m.media_mime ?? null,
          createdAt: m.created_at,
          // Devolvido só pro app casar o eco do envio otimista.
          clientId:
            typeof m.external_id === 'string' && m.external_id.startsWith('app-')
              ? m.external_id.slice(4)
              : null,
        }))
        .reverse(),
      nextCursor:
        temMais && ultima
          ? encodeCursor({ createdAt: ultima.created_at as string, id: ultima.id as string })
          : null,
    });
  });

  // ─── Envio (assíncrono) ───────────────────────────────────────────────────────
  app.post('/messages', { preHandler: requirePatient }, async (req, reply) => {
    const parsed = SendBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });
    if (!isValidClientId(parsed.data.clientId)) return reply.code(400).send({ error: 'invalid_client_id' });

    const userId = req.patient!.userId;

    // Gate do consentimento: sem aceite de dado de saúde, nada de conversa clínica.
    // 428 é o código que o app entende como "abra a tela de termos".
    if (await consentPending(userId)) {
      return reply.code(428).send({ error: 'consent_required' });
    }

    if (loadPrompts().xarlote_enabled === false) {
      return reply.code(503).send({
        error: 'xarlote_disabled',
        message: 'Estou em manutenção agora. Tenta de novo em instantes 💙',
      });
    }

    const phone = await patientPhone(userId);
    if (!phone) return reply.code(404).send({ error: 'user_gone' });

    const resultado = await enqueueAppInbound({
      userId,
      phoneE164: phone,
      clientId: parsed.data.clientId,
      text: parsed.data.text,
      // Carimbo do aparelho, limitado ao presente: um relógio adiantado no celular
      // jogaria a bolha pro futuro e ela ficaria grudada no topo da lista pra sempre.
      sentAtMs: Math.min(parsed.data.sentAtMs ?? Date.now(), Date.now()),
    });

    if (resultado === 'unavailable') {
      return reply.code(503).send({
        error: 'queue_unavailable',
        message: 'Não consegui receber sua mensagem agora. Tenta de novo em instantes.',
      });
    }

    void writeEvent({
      eventName: 'app.message_sent',
      userId,
      // Só o tamanho: o conteúdo é clínico e já vive em `messages`.
      payload: { channel: 'xarlote_app', length: parsed.data.text.length },
    });

    return reply.code(202).send({
      accepted: true,
      clientId: parsed.data.clientId,
      externalId: appExternalId(parsed.data.clientId),
    });
  });

  // ─── "Estou digitando" ────────────────────────────────────────────────────────
  // Existe pro caso multi-aparelho: a pessoa escrevendo no celular e com o app aberto
  // no tablet. Efêmero — publica e não persiste nada.
  app.post('/messages/typing', { preHandler: requirePatient }, async (req, reply) => {
    const phone = await patientPhone(req.patient!.userId);
    if (!phone) return reply.code(404).send({ error: 'user_gone' });
    const conv = await findConversation(phone);
    // Tipo `typing`, não `message` com contentType — o cliente decide o que fazer
    // pelo `type` do envelope, e um evento de digitação disfarçado de mensagem
    // entraria na lista de bolhas de quem só olhasse o tipo.
    if (conv) void publishAppEvent(conv.id, { type: 'typing', at: Date.now(), direction: 'in' });
    return reply.code(204).send();
  });
}
