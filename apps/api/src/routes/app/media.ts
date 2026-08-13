/**
 * `/app/media` — o paciente manda a foto do exame, a receita ou um áudio.
 *
 * ## Duas etapas, e o porquê
 *
 * O upload NÃO cria a mensagem. Ele guarda o arquivo e devolve um `mediaId`; a mensagem
 * nasce depois, no `POST /app/messages {kind, mediaId}`. Parece um passo a mais e resolve
 * dois problemas reais:
 *
 * · **Rede móvel cai no meio.** Subir 4 MB e falhar na última etapa não pode desperdiçar
 *   o upload — o app repete só a parte barata.
 * · **O paciente escolhe a foto e desiste.** Sem a separação, cada foto escolhida já
 *   viraria mensagem e turno de LLM.
 *
 * ## O bucket é PRIVADO
 *
 * `xarlote-app-media` não tem leitura pública. Cada visualização passa por
 * `GET /app/media/:id/url`, que confere o dono e emite uma URL assinada de 10 minutos.
 * Um bucket público com nome de arquivo adivinhável seria prontuário aberto por
 * enumeração — e nomes "aleatórios" não são um controle de acesso.
 */
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { db, writeEvent } from '@iasaude/db';
import { requirePatient } from '../../middleware/patient-auth.js';
import { MAX_BYTES, mensagemDeRecusa, sniffMidia } from '../../lib/media-sniff.js';

const BUCKET = 'xarlote-app-media';
/** Validade da URL assinada: tempo de carregar a imagem, não de circular por aí. */
const URL_TTL_S = 600;

export async function appMediaRoutes(app: FastifyInstance): Promise<void> {
  // ─── POST /app/media ──────────────────────────────────────────────────────
  app.post('/media', { preHandler: requirePatient }, async (req, reply) => {
    const userId = req.patient!.userId;

    if (!req.isMultipart()) {
      return reply.code(400).send({ error: 'multipart_esperado' });
    }

    const arquivo = await req.file();
    if (!arquivo) return reply.code(400).send({ error: 'arquivo_ausente' });

    let buf: Buffer;
    try {
      buf = await arquivo.toBuffer();
    } catch {
      // `@fastify/multipart` lança quando o arquivo estoura o `fileSize` do plugin.
      return reply.code(413).send({ error: 'muito_grande', message: mensagemDeRecusa('muito_grande') });
    }

    // O veredicto vem dos BYTES. `arquivo.mimetype` é o que o cliente disse, e é
    // deliberadamente ignorado — ver o cabeçalho de lib/media-sniff.ts.
    const v = sniffMidia(buf);
    if (!v.ok) {
      // 415 pro formato, 413 pro tamanho: são problemas diferentes e o app trata
      // diferente (um pede outro arquivo, o outro pede uma foto menor).
      const status = v.motivo === 'muito_grande' ? 413 : 415;
      return reply.code(status).send({ error: v.motivo, message: mensagemDeRecusa(v.motivo) });
    }

    // Caminho com o userId no prefixo: torna a limpeza do apagamento LGPD trivial e
    // deixa uma política de bucket por pasta possível depois, se precisar.
    const caminho = `${userId}/${randomUUID()}.${v.extensao}`;

    const { error } = await db.storage.from(BUCKET).upload(caminho, buf, {
      contentType: v.mime,
      // Sem upsert: o caminho tem UUID, colisão não acontece. E `upsert: true` deixaria
      // um caminho adivinhado sobrescrever arquivo de outra pessoa.
      upsert: false,
    });
    if (error) {
      req.log.error({ err: error.message }, 'upload de mídia do app falhou');
      return reply.code(502).send({ error: 'upload_falhou', message: 'Não consegui guardar o arquivo. Tenta de novo?' });
    }

    const { data: linha, error: errLinha } = await db
      .from('app_media')
      .insert({ user_id: userId, storage_path: caminho, mime: v.mime, bytes: buf.length, kind: v.tipo === 'audio' ? 'audio' : 'image' })
      .select('id')
      .single();

    if (errLinha || !linha) {
      // Arquivo no bucket sem linha no banco = lixo órfão que o apagamento LGPD não
      // alcança (ele varre por `app_media`). Remove antes de responder o erro.
      await db.storage.from(BUCKET).remove([caminho]).then(() => undefined, () => undefined);
      return reply.code(500).send({ error: 'registro_falhou' });
    }

    void writeEvent({
      eventName: 'app.media_uploaded',
      userId,
      // Sem nome de arquivo e sem conteúdo: só o formato e o tamanho.
      payload: { tipo: v.tipo, mime: v.mime, bytes: buf.length },
    });

    return reply.code(201).send({ mediaId: linha.id, tipo: v.tipo, mime: v.mime, bytes: buf.length });
  });

  // ─── GET /app/media/:id/url ───────────────────────────────────────────────
  app.get<{ Params: { id: string } }>('/media/:id/url', { preHandler: requirePatient }, async (req, reply) => {
    const { data: midia } = await db
      .from('app_media')
      .select('id, user_id, storage_path, mime')
      .eq('id', req.params.id)
      .maybeSingle();

    if (!midia) return reply.code(404).send({ error: 'not_found' });
    // Dono, sempre: um id adivinhado não pode virar o exame de outra pessoa.
    if (midia.user_id !== req.patient!.userId) return reply.code(403).send({ error: 'forbidden' });

    const { data, error } = await db.storage
      .from(BUCKET)
      .createSignedUrl(midia.storage_path as string, URL_TTL_S);

    if (error || !data?.signedUrl) {
      return reply.code(500).send({ error: 'url_falhou' });
    }

    return reply.send({ url: data.signedUrl, mime: midia.mime, expiraEmSegundos: URL_TTL_S });
  });
}

export { BUCKET as BUCKET_APP_MEDIA, MAX_BYTES };
