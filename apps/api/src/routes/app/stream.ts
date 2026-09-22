/**
 * GET /app/stream — o tempo real do app, por SSE.
 *
 * Escolhi SSE e não WebSocket porque o tráfego é de UMA direção (servidor → app; o
 * app fala por POST comum), e SSE é HTTP normal: passa por qualquer proxy, reconecta
 * sozinho e não precisa de biblioteca no servidor. WebSocket seria mais peça pra
 * manter sem ganho nenhum aqui.
 *
 * ## O que este arquivo tem que acertar pra não quebrar em produção
 *
 * 1. **Uma inscrição de Redis POR CONEXÃO.** Um client `subscribe` do ioredis entra
 *    em modo assinante e não serve mais pra outros comandos — então NÃO dá pra usar o
 *    `getRedisClient()` compartilhado (que o rate-limit e o /ready também usam).
 *    Cada SSE cria o seu e fecha no fim. Vazar isso é vazar conexão de Redis por
 *    paciente, até estourar o limite do provedor.
 *
 * 2. **Heartbeat de 25s.** Proxy do Railway e operadora móvel matam conexão ociosa
 *    em ~30-60s. Sem o comentário periódico, o app "perde o tempo real" e ninguém
 *    entende por quê — parece bug de app, é timeout de infra.
 *
 * 3. **Sem replay, e isso é contrato.** Se a conexão cai, o cliente NÃO recebe o que
 *    perdeu por aqui: ele refaz a busca por cursor no `GET /app/messages`. Guardar
 *    histórico de eventos no servidor seria uma segunda fonte de verdade do chat pra
 *    manter sincronizada — o banco já é a fonte, e ele nunca perde nada.
 *
 * 4. **Limpar TUDO no fim.** Timer do heartbeat, inscrição e o client. O `close` do
 *    request é o único gancho garantido: o paciente tranca a tela e o socket morre
 *    sem aviso.
 */
import type { FastifyInstance } from 'fastify';
import IORedis from 'ioredis';
import { db } from '@iasaude/db';
import { SARA_INSTANCE, whatsappJidVariants } from '@iasaude/shared';
import { requirePatient } from '../../middleware/patient-auth.js';
import {
  SSE_HEARTBEAT,
  SSE_HEARTBEAT_MS,
  SSE_RETRY_MS,
  appConversationChannel,
  decodeAppEvent,
  sseFrame,
} from '../../lib/app-events.js';

/**
 * Conexões SSE abertas — para o graceful shutdown poder fechá-las.
 *
 * SSE é conexão ATIVA e nunca fica ociosa: com `forceCloseConnections: 'idle'` (o padrão
 * do Fastify), UM app aberto fazia o `app.close()` esperar o timeout duro de 25s, o
 * processo sair com `exit(1)` e os disposers seguintes — flush do debounce de fornecedor
 * e fechamento das filas — NUNCA rodarem (auditoria 22/09).
 */
const streamsAbertos = new Set<() => void>();

/** Encerra todas as conexões SSE. Chamado no shutdown, ANTES do `app.close()`. */
export function encerrarStreamsAbertos(): void {
  for (const encerrar of [...streamsAbertos]) {
    try {
      encerrar();
    } catch {
      /* uma conexão problemática não pode impedir o fechamento das outras */
    }
  }
  streamsAbertos.clear();
}

export async function appStreamRoutes(app: FastifyInstance): Promise<void> {
  app.get('/stream', { preHandler: requirePatient }, async (req, reply) => {
    const userId = req.patient!.userId;

    const { data: user } = await db.from('users').select('phone_e164').eq('id', userId).maybeSingle();
    const phone = user?.phone_e164 as string | undefined;
    if (!phone) return reply.code(404).send({ error: 'user_gone' });

    const { data: convs } = await db
      .from('conversations')
      .select('id')
      .eq('whatsapp_instance', SARA_INSTANCE)
      .in('whatsapp_jid', whatsappJidVariants(phone))
      .order('last_message_at', { ascending: false, nullsFirst: false })
      .limit(1);
    const conversationId = convs?.[0]?.id as string | undefined;
    // Paciente que nunca conversou não tem canal pra escutar. 409 (e não 404) porque
    // não é "não existe" — é "ainda não, manda a primeira mensagem".
    if (!conversationId) return reply.code(409).send({ error: 'no_conversation' });

    // A AUTORIZAÇÃO acontece AQUI, uma vez: a conversa foi achada a partir do userId
    // do JWT, então por construção é a dele. Nenhum evento publicado depois precisa
    // ser reautorizado, e é por isso que o canal é por conversa e não por usuário.
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // Desliga o buffer do nginx/proxy — com ele, o evento fica preso até juntar
      // um bloco e o "tempo real" chega em rajadas de 30 segundos.
      'x-accel-buffering': 'no',
    });
    reply.raw.write(`retry: ${SSE_RETRY_MS}\n\n`);
    // Primeiro quadro imediato: confirma pro app que o canal está vivo, então ele
    // pode desligar o fallback de polling sem esperar o primeiro evento real.
    reply.raw.write(sseFrame({ type: 'activity', at: Date.now(), text: 'connected' }));

    const sub = new IORedis(process.env['REDIS_URL'] ?? 'redis://localhost:6379', {
      maxRetriesPerRequest: null,
    });
    sub.on('error', () => { /* a reconexão do ioredis cuida; o cliente tem o cursor */ });

    const heartbeat = setInterval(() => {
      // `writable` protege contra escrever em socket já morto (throw no meio do
      // interval derrubaria o processo, não só esta conexão).
      if (reply.raw.writable) reply.raw.write(SSE_HEARTBEAT);
    }, SSE_HEARTBEAT_MS);

    let encerrado = false;
    const encerrar = () => {
      if (encerrado) return;
      encerrado = true;
      streamsAbertos.delete(encerrar);
      clearInterval(heartbeat);
      void sub.unsubscribe().catch(() => undefined);
      void sub.quit().catch(() => undefined);
      if (reply.raw.writable) reply.raw.end();
    };
    streamsAbertos.add(encerrar);

    await sub.subscribe(appConversationChannel(conversationId));
    sub.on('message', (_canal, payload) => {
      const ev = decodeAppEvent(payload);
      if (!ev || !reply.raw.writable) return;
      reply.raw.write(sseFrame(ev));
    });

    // `close` cobre o caso normal (app fechou) e o anormal (rede caiu, app morto).
    req.raw.on('close', encerrar);
    req.raw.on('error', encerrar);

    // Fastify não pode responder de novo depois do writeHead manual.
    return reply;
  });
}
