/**
 * Apagar a conta e exportar os dados — os dois direitos que o app tem que oferecer.
 *
 * ## Por que isto é bloqueante para publicar
 *
 * A Apple exige exclusão de conta DENTRO do app (App Store Review 5.1.1(v)) para qualquer
 * app que permita criar conta. E a LGPD (art. 18) exige exclusão e portabilidade a pedido
 * do titular. Até estas rotas existirem, o caminho era só conversacional ("CONFIRMO
 * APAGAR" no chat) — funciona, mas não satisfaz nenhuma das duas exigências.
 *
 * ## O acesso morre no request; o resto vai pra fila
 *
 * A ordem aqui é deliberada: **revogar sessões e aparelhos ANTES de responder**, e só
 * então enfileirar a limpeza. No instante em que o paciente confirma, ele deixa de ser
 * alcançável — mesmo que a fila leve um minuto. Fosse ao contrário, a janela entre
 * "confirmei" e "o worker pegou" seria uma janela com o prontuário aberto.
 *
 * E se a fila não aceitar, a rota responde **503, não 202**: dizer que a conta será
 * apagada sem ter nada enfileirado é a pior mentira que este sistema é capaz de contar.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db, writeLog } from '@iasaude/db';
import { requirePatient } from '../../middleware/patient-auth.js';
import { enqueueAccountForget, enqueueDataExport } from '../../queues/lgpd.queue.js';

/**
 * A frase que o paciente digita.
 *
 * Um botão "apagar" sozinho é fácil de tocar por engano, e isto não tem volta. Digitar a
 * frase é o pedágio de atenção — o mesmo raciocínio do "CONFIRMO APAGAR" do chat, que já
 * está em produção há meses.
 */
export const FRASE_CONFIRMACAO = 'APAGAR MINHA CONTA';

const ApagarSchema = z.object({ confirmacao: z.string().min(1).max(60) });

/** Normaliza pra comparar: caixa, acento e espaço extra não podem ser o obstáculo. */
function confirmou(entrada: string): boolean {
  const limpa = entrada
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
  return limpa === FRASE_CONFIRMACAO;
}

/** Uma exportação por vez a cada 10 minutos: gerar o JSON custa I/O de verdade. */
const INTERVALO_EXPORT_MS = 10 * 60_000;

export async function appAccountRoutes(app: FastifyInstance): Promise<void> {
  // ─── DELETE /app/account ──────────────────────────────────────────────────
  app.delete('/account', { preHandler: requirePatient }, async (req, reply) => {
    const parsed = ApagarSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'confirmacao_ausente', message: `Digite "${FRASE_CONFIRMACAO}" pra confirmar.` });
    }
    if (!confirmou(parsed.data.confirmacao)) {
      return reply.code(400).send({
        error: 'confirmacao_invalida',
        message: `Pra apagar a conta, digite exatamente "${FRASE_CONFIRMACAO}".`,
      });
    }

    const userId = req.patient!.userId;
    const traceId = req.id;

    // ── 1. FECHAR A PORTA, agora ──────────────────────────────────────────
    // Antes da fila e antes da resposta. Se qualquer coisa falhar depois disto, o
    // paciente já está inalcançável — que é o estado seguro.
    const { error: errSessoes } = await db.from('app_sessions').delete().eq('user_id', userId);
    const { error: errDispositivos } = await db.from('device_tokens').delete().eq('user_id', userId);
    // Link de médico ativo é um terceiro com acesso: revogar é tão urgente quanto a sessão.
    const { error: errLinks } = await db
      .from('share_grants')
      .update({ revoked_at: new Date().toISOString() })
      .eq('user_id', userId)
      .is('revoked_at', null);

    if (errSessoes || errDispositivos || errLinks) {
      const detalhe = [errSessoes, errDispositivos, errLinks].filter(Boolean).map((e) => e!.message).join(' | ');
      await writeLog('error', 'lgpd', `revogação de acesso falhou no DELETE /account: ${detalhe.slice(0, 200)}`, {
        userId,
        traceId,
      });
      // Não enfileira: se não consegui nem fechar a porta, prometer o apagamento é pior
      // do que pedir pra tentar de novo.
      return reply.code(503).send({
        error: 'unavailable',
        message: 'Não consegui concluir agora. Tenta de novo em instantes — nada foi apagado ainda.',
      });
    }

    // ── 2. Enfileirar a limpeza ───────────────────────────────────────────
    // O telefone vai NO JOB: o executor anonimiza `users.phone_e164` no passo 8, e uma
    // retentativa depois disso perderia a única chave que alcança `webhook_events`.
    const { data: dono } = await db.from('users').select('phone_e164').eq('id', userId).maybeSingle();
    const telefone = dono?.phone_e164 as string | undefined;
    const enfileirou = await enqueueAccountForget({
      userId,
      canal: 'app',
      traceId,
      ...(telefone && !telefone.startsWith('deleted-') ? { phoneE164: telefone } : {}),
    });
    if (!enfileirou) {
      return reply.code(503).send({
        error: 'unavailable',
        message:
          'Sua sessão já foi encerrada, mas não consegui iniciar o apagamento agora. ' +
          'Me chama no WhatsApp que eu concluo — seus dados não vão ficar assim.',
      });
    }

    // 202: aceito e em andamento. Não é 200 de propósito — o apagamento não terminou.
    return reply.code(202).send({
      ok: true,
      message:
        'Sua conta está sendo apagada e sua sessão já foi encerrada. Em alguns instantes ' +
        'não haverá mais nada seu aqui. Obrigada por ter me deixado cuidar de você.',
    });
  });

  // ─── POST /app/export ─────────────────────────────────────────────────────
  app.post('/export', { preHandler: requirePatient }, async (req, reply) => {
    const userId = req.patient!.userId;

    // Já tem um em andamento? Devolve ELE, em vez de criar outro. Toque duplo no botão
    // não pode virar dois jobs lendo dezenas de milhares de mensagens em paralelo.
    const { data: emAndamento } = await db
      .from('app_exports')
      .select('id, status, created_at')
      .eq('user_id', userId)
      .eq('status', 'pending')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (emAndamento) {
      return reply.code(202).send({
        exportId: emAndamento.id,
        status: 'pending',
        message: 'Já estou preparando seus dados. Te aviso assim que ficar pronto.',
      });
    }

    // Anti-abuso por tempo: gerar o arquivo custa I/O real.
    const { data: ultimo } = await db
      .from('app_exports')
      .select('created_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (ultimo?.created_at) {
      const desde = Date.now() - Date.parse(ultimo.created_at as string);
      if (Number.isFinite(desde) && desde < INTERVALO_EXPORT_MS) {
        const faltam = Math.ceil((INTERVALO_EXPORT_MS - desde) / 60_000);
        return reply.code(429).send({
          error: 'rate_limited',
          message: `Acabei de gerar um export pra você. Espera ${faltam} min pra pedir outro.`,
        });
      }
    }

    const { data: criado, error } = await db
      .from('app_exports')
      .insert({ user_id: userId, status: 'pending' })
      .select('id')
      .single();

    if (error || !criado) {
      return reply.code(500).send({ error: 'export_failed', message: 'Não consegui iniciar o export.' });
    }

    const enfileirou = await enqueueDataExport({ userId, exportId: criado.id as string, traceId: req.id });
    if (!enfileirou) {
      // A linha existe mas ninguém vai processá-la: marca `failed` na hora, senão ela
      // fica `pending` pra sempre e a tela mostra "preparando" eternamente.
      await db.from('app_exports').update({ status: 'failed', error: 'queue_unavailable' }).eq('id', criado.id as string);
      return reply.code(503).send({ error: 'unavailable', message: 'Não consegui iniciar agora. Tenta de novo em instantes.' });
    }

    return reply.code(202).send({
      exportId: criado.id,
      status: 'pending',
      message: 'Estou juntando tudo. Te aviso aqui quando estiver pronto.',
    });
  });

  // ─── GET /app/export/:id ──────────────────────────────────────────────────
  app.get<{ Params: { id: string } }>('/export/:id', { preHandler: requirePatient }, async (req, reply) => {
    const { data: exp } = await db
      .from('app_exports')
      .select('id, user_id, status, storage_path, error, created_at, completed_at')
      .eq('id', req.params.id)
      .maybeSingle();

    if (!exp) return reply.code(404).send({ error: 'not_found' });
    // Dono, sempre. Um id de export adivinhado não pode virar o prontuário de outro.
    if (exp.user_id !== req.patient!.userId) return reply.code(403).send({ error: 'forbidden' });

    if (exp.status !== 'ready' || !exp.storage_path) {
      return reply.send({
        exportId: exp.id,
        status: exp.status,
        ...(exp.status === 'failed' ? { message: 'Algo falhou ao preparar o arquivo. Pede de novo?' } : {}),
      });
    }

    // Signed URL curta: o link é o próprio prontuário em texto puro. 10 minutos é tempo
    // de baixar, e não é tempo de o link circular por aí.
    const { data: assinada, error } = await db.storage
      .from('xarlote-exports')
      .createSignedUrl(exp.storage_path as string, 600);

    if (error || !assinada?.signedUrl) {
      return reply.code(500).send({ error: 'signed_url_failed', message: 'O arquivo existe mas não consegui gerar o link. Tenta de novo?' });
    }

    return reply.send({
      exportId: exp.id,
      status: 'ready',
      url: assinada.signedUrl,
      expiraEmSegundos: 600,
      completedAt: exp.completed_at,
    });
  });

  // ─── GET /app/export ──────────────────────────────────────────────────────
  // O histórico, pra tela saber se já existe um pronto sem precisar pedir outro.
  app.get('/export', { preHandler: requirePatient }, async (req, reply) => {
    const { data } = await db
      .from('app_exports')
      .select('id, status, created_at, completed_at')
      .eq('user_id', req.patient!.userId)
      .order('created_at', { ascending: false })
      .limit(10);
    return reply.send({ exports: data ?? [] });
  });
}
