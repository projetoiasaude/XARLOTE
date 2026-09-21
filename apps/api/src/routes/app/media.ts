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
 *
 * ## PDF: o TEXTO é lido aqui, no upload
 *
 * Laudo de laboratório é texto, não desenho. Mandar o PDF pro modelo de visão seria
 * repetir a armadilha do HEIC (formato que sobe e o provedor recusa) e ainda pagar token
 * de imagem por página pra receber um chute onde existe certeza: `extrairTextoDePdf` lê
 * "Hemoglobina 13,2 g/dL" dos bytes.
 *
 * A leitura acontece no upload e não no turno da LLM por dois motivos:
 * · o buffer já está na memória aqui — no worker ele teria que ser baixado de novo;
 * · o app precisa da resposta ANTES de enviar, pra mostrar a prévia ("2 páginas, 1.842
 *   caracteres lidos") e deixar o paciente conferir que mandou o arquivo certo.
 *
 * Quando o PDF é uma folha escaneada, ou está cifrado, ou usa fonte sem mapa de unicode,
 * a resposta traz `motivo` e `aviso` em vez de texto. Ela nunca traz texto vazio como se
 * tivesse dado certo — o app precisa saber a diferença pra oferecer a foto da folha.
 *
 * ## Sim, o worker lê o mesmo PDF de novo — e as duas leituras têm dono
 *
 * Esta aqui alimenta a PRÉVIA: é o que o app mostra ao paciente antes de a mensagem
 * existir (`features/media/pdf-documento.ts`), inclusive a frase que diz, com todas as
 * letras, que o conteúdo NÃO pôde ser lido. A do worker alimenta o PROMPT, com teto maior
 * (6000 contra 3000) e o embrulho que separa conteúdo de arquivo de instrução. Apagar uma
 * delas não é economia: é ou uma prévia que mente, ou um laudo cortado no prompt.
 *
 * O custo dessa leitura é limitado no extrator, não aqui: `extrairTextoDePdf` para de
 * inflar ao somar ~32 MB no total (não só 8 MB por stream), o que é o que impede um upload
 * de 10 MB declarando 400 streams compressíveis de virar gigabytes de `inflateSync`
 * síncrono na thread que atende todo mundo.
 */
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { db, writeEvent } from '@iasaude/db';
import { lerPdfCompleto, mensagemDePdfIlegivel, type LeituraDePdf } from '@iasaude/integrations';
import { requirePatient } from '../../middleware/patient-auth.js';
import { MAX_BYTES, mensagemDeRecusa, sniffMidia } from '../../lib/media-sniff.js';

const BUCKET = 'xarlote-app-media';
/** Validade da URL assinada: tempo de carregar a imagem, não de circular por aí. */
const URL_TTL_S = 600;

/**
 * O que o app recebe sobre um PDF. Ou tem texto, ou tem motivo — nunca os dois vazios.
 */
type RespostaDocumento =
  | { texto: string; paginas: number; caracteres: number; truncado: boolean }
  | { texto: null; paginas: number; motivo: string; aviso: string };

/**
 * O extrator é puro e não deve lançar. O `try` existe porque este caminho segura o exame
 * que o paciente acabou de mandar: se um PDF exótico achar um caso que o parser não
 * previu, o arquivo TEM que continuar guardado e a resposta tem que dizer o que houve.
 * Perder o upload por causa da leitura seria trocar um problema pequeno por um grande.
 */
async function lerPdf(buf: Buffer, log: { error: (o: object, m: string) => void }): Promise<LeituraDePdf> {
  try {
    return await lerPdfCompleto(buf);
  } catch (err) {
    // Sem o texto no log: é dado clínico. Só o tamanho e a mensagem do erro.
    log.error(
      { err: err instanceof Error ? err.message.slice(0, 160) : String(err).slice(0, 160), bytes: buf.length },
      'extração de texto do PDF lançou',
    );
    return { ok: false, motivo: 'falha_ao_ler', paginas: 0 };
  }
}

export async function appMediaRoutes(app: FastifyInstance): Promise<void> {
  // ─── POST /app/media ──────────────────────────────────────────────────────
  app.post(
    '/media',
    {
      preHandler: requirePatient,
      /**
       * Teto de corpo APENAS desta rota.
       *
       * O default do Fastify é 1 MB — uma foto de exame em base64 (33% maior que o
       * arquivo) seria recusada com 413 antes mesmo de o handler rodar, e o paciente
       * veria "não consegui enviar" sem explicação. Subir o limite GLOBAL resolveria e
       * abriria todas as outras rotas a corpos de 15 MB, que é superfície de abuso de
       * graça. Aqui o limite acompanha o `MAX_BYTES` com folga pro overhead do base64.
       */
      bodyLimit: Math.ceil(MAX_BYTES * 1.4),
    },
    async (req, reply) => {
    const userId = req.patient!.userId;

    /**
     * DUAS formas de subir o arquivo, e a segunda existe por um motivo medido.
     *
     * `multipart` é o caminho canônico e continua valendo (web, curl, futuros clientes).
     * Mas no app nativo ele **não funciona**: com React Native 0.86 em modo bridgeless,
     * `fetch` com um `FormData` contendo `{uri, name, type}` LANÇA antes de chegar à
     * rede — verificado no simulador em 13/08, com a requisição nunca aparecendo no log
     * do servidor. Alternativas nativas (expo-file-system) exigiriam um módulo novo, e
     * módulo nativo novo só existe depois de um build novo do app.
     *
     * Então o app manda JSON com base64. Custa 33% a mais de bytes e funciona no binário
     * que já está instalado. O servidor aceita os dois e o resto do fluxo é idêntico —
     * o veredicto continua vindo dos BYTES, não do que o cliente declarou.
     */
    let buf: Buffer;

    if (req.isMultipart()) {
      const arquivo = await req.file();
      if (!arquivo) return reply.code(400).send({ error: 'arquivo_ausente' });
      try {
        buf = await arquivo.toBuffer();
      } catch {
        // `@fastify/multipart` lança quando o arquivo estoura o `fileSize` do plugin.
        return reply.code(413).send({ error: 'muito_grande', message: mensagemDeRecusa('muito_grande') });
      }
    } else {
      const corpo = req.body as { base64?: unknown } | undefined;
      const b64 = typeof corpo?.base64 === 'string' ? corpo.base64 : null;
      if (!b64) return reply.code(400).send({ error: 'arquivo_ausente' });

      // O teto é checado ANTES de decodificar: base64 de 4 caracteres vira 3 bytes, então
      // um corpo gigante seria materializado na memória só pra depois ser recusado.
      if (b64.length > MAX_BYTES * 1.4) {
        return reply.code(413).send({ error: 'muito_grande', message: mensagemDeRecusa('muito_grande') });
      }
      buf = Buffer.from(b64, 'base64');
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
      /**
       * `kind` guarda 'image' pro PDF porque a coluna tem `check (kind in ('image',
       * 'audio'))` desde a 0025 — 'document' exigiria migration, que não é desta frente.
       * O tipo REAL não se perde: ele está em `mime` (`application/pdf`), que é o que o
       * apagamento e a exportação leem. Enquanto a migration não vier, `kind` é uma pista,
       * nunca a chave — e é por isso que quem quiser saber se é PDF olha o mime.
       */
      .insert({ user_id: userId, storage_path: caminho, mime: v.mime, bytes: buf.length, kind: v.tipo === 'audio' ? 'audio' : 'image' })
      .select('id')
      .single();

    if (errLinha || !linha) {
      // Arquivo no bucket sem linha no banco = lixo órfão que o apagamento LGPD não
      // alcança (ele varre por `app_media`). Remove antes de responder o erro.
      await db.storage.from(BUCKET).remove([caminho]).then(() => undefined, () => undefined);
      return reply.code(500).send({ error: 'registro_falhou' });
    }

    /**
     * A leitura do PDF vem DEPOIS de o arquivo estar guardado e registrado, de propósito.
     * Nesta ordem, qualquer coisa que aconteça na extração acontece sobre um exame que
     * já está a salvo — a ordem inversa faria uma falha de leitura custar o upload.
     */
    let documento: RespostaDocumento | undefined;
    if (v.tipo === 'document') {
      const leitura = await lerPdf(buf, req.log);
      documento = leitura.ok
        ? {
            texto: leitura.texto,
            paginas: leitura.paginas,
            caracteres: leitura.caracteres,
            truncado: leitura.truncado,
          }
        : {
            texto: null,
            paginas: leitura.paginas,
            motivo: leitura.motivo,
            aviso: mensagemDePdfIlegivel(leitura.motivo),
          };
    }

    void writeEvent({
      eventName: 'app.media_uploaded',
      userId,
      // Sem nome de arquivo e sem conteúdo: só o formato e o tamanho. Do PDF vão os
      // NÚMEROS (páginas, caracteres) e o motivo da falha — nunca um trecho do laudo.
      payload: {
        tipo: v.tipo,
        mime: v.mime,
        bytes: buf.length,
        ...(documento
          ? documento.texto === null
            ? { pdfLido: false, pdfMotivo: documento.motivo, paginas: documento.paginas }
            : {
                pdfLido: true,
                paginas: documento.paginas,
                caracteres: documento.caracteres,
                truncado: documento.truncado,
              }
          : {}),
      },
    });

      return reply.code(201).send({
        mediaId: linha.id,
        tipo: v.tipo,
        mime: v.mime,
        bytes: buf.length,
        ...(documento ? { documento } : {}),
      });
    },
  );

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
