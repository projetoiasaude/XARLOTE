/**
 * Hospedagem da mídia RECEBIDA do paciente pelo WhatsApp (30/07).
 *
 * Por que existe: a foto que o paciente manda vivia só durante o turno — `media_storage_path`
 * era gravado como `null` sempre. Depois do turno a imagem sumia, então era impossível
 * ENCAMINHAR o documento à clínica/farmácia mais tarde. O caso Glauber travou exatamente
 * aqui: o consultório pediu foto da carteirinha e do pedido médico, e a Xarlote não tinha
 * como repassar nada.
 *
 * O reenvio pelo WhatsApp exige uma URL que funcione no INSTANTE do envio (o zpro manda
 * mídia por URL), e a URL original do Meta é protegida por token e expira. Então guardamos
 * uma cópia no Storage. Espelha o `audio-host` do TTS, que já faz isso pro áudio de saída.
 *
 * ## Por que URL ASSINADA e não pública (correção 19/08)
 *
 * O MESMO documento tem dois caminhos de entrada — o app e o WhatsApp — e eles divergiam
 * justamente na dimensão que mais importa. Pelo app, `routes/app/media.ts` guarda no bucket
 * PRIVADO `xarlote-app-media` (migration 0025) e serve por signed URL de 10 min, com a
 * justificativa escrita no cabeçalho de lá: "um bucket público com nome de arquivo
 * adivinhável seria prontuário aberto por enumeração — e nomes aleatórios não são um
 * controle de acesso". Pelo WhatsApp, o mesmo arquivo ia pra um bucket PÚBLICO com URL sem
 * expiração e sem dono.
 *
 * Isso já valia pra foto, mas era foto. Com o PDF entrando por aqui, este caminho passa a
 * receber LAUDO DE LABORATÓRIO inteiro, que costuma trazer nome, data de nascimento e às
 * vezes CPF do paciente na primeira linha. Quem encaminha só precisa de uma URL que valha
 * no momento do envio; 10 minutos bastam, que é exatamente o que o caminho do app faz.
 *
 * ⚠️ FALTA A OUTRA METADE: `xarlote-media` foi criado à mão e continua marcado `public` —
 * ele nunca apareceu em migration nenhuma (a 0025 só declara `xarlote-app-media` e
 * `xarlote-exports`). Enquanto o bucket for público, as URLs antigas seguem abertas. O
 * fecho é `update storage.buckets set public = false where id = 'xarlote-media';` numa
 * migration nova — `createSignedUrl` funciona igual nos dois casos, então este arquivo já
 * está pronto pro dia em que ela rodar.
 */
import { db, writeLog } from '@iasaude/db';
import { randomUUID } from 'node:crypto';

const BUCKET = 'xarlote-media';

/**
 * Validade da URL assinada. O único consumidor é o encaminhamento ao estabelecimento, que
 * busca o link e despacha na mesma função — 10 minutos é folga, não prazo.
 */
const VALIDADE_URL_SEGUNDOS = 600;

function extFor(mime: string): string {
  if (mime.includes('png')) return 'png';
  if (mime.includes('webp')) return 'webp';
  if (mime.includes('pdf')) return 'pdf';
  if (mime.includes('heic')) return 'heic';
  return 'jpg';
}

/**
 * Sobe a mídia recebida e devolve `{ path }`, ou null em falha.
 *
 * Devolve o CAMINHO, não uma URL: o caminho é o que vai pro banco
 * (`messages.media_storage_path`) e é a partir dele que se emite uma URL assinada na hora
 * de usar. Uma URL sem prazo devolvida aqui viraria link de laudo guardado em log, em
 * mensagem espelhada e em memória de processo — e nenhum dos três expira.
 *
 * Best-effort: falhar aqui NUNCA pode derrubar o turno — a leitura da imagem (visão) já
 * aconteceu e vale por si só.
 */
export async function uploadInboundMedia(
  buffer: Buffer,
  mime: string,
  traceId?: string,
): Promise<{ path: string } | null> {
  try {
    const path = `inbound/${new Date().toISOString().slice(0, 10)}/${randomUUID()}.${extFor(mime)}`;
    const { error } = await db.storage.from(BUCKET).upload(path, buffer, {
      contentType: mime || 'image/jpeg',
      upsert: false,
    });
    if (error) {
      await writeLog('warn', 'media', `upload da mídia do paciente falhou: ${error.message}`, { traceId });
      return null;
    }
    return { path };
  } catch (err) {
    await writeLog('warn', 'media', `upload da mídia (exceção): ${String(err).slice(0, 160)}`, { traceId });
    return null;
  }
}

/**
 * URL ASSINADA e de vida curta pra uma mídia já hospedada (a partir do
 * `media_storage_path` salvo). Null quando não dá — e null aqui tem que virar "não
 * consegui mandar", nunca um encaminhamento silenciosamente vazio.
 */
export async function signedUrlForStoredMedia(
  storagePath: string,
  expiraEmSegundos: number = VALIDADE_URL_SEGUNDOS,
): Promise<string | null> {
  try {
    const { data, error } = await db.storage.from(BUCKET).createSignedUrl(storagePath, expiraEmSegundos);
    if (error) {
      await writeLog('warn', 'media', `signed URL da mídia do paciente falhou: ${error.message}`);
      return null;
    }
    return data?.signedUrl ?? null;
  } catch {
    return null;
  }
}

/**
 * Os BYTES de uma mídia já hospedada — pra devolver ao modelo a foto de há pouco quando a
 * pergunta do paciente é sobre ela (ver foto-recente.ts). Teto de tamanho: uma foto de
 * WhatsApp tem ~100–300 KB; acima de `maxBytes` não é o caso de uso e não vai pro prompt.
 * Null em qualquer falha — quem chama segue sem a foto, nunca com um buffer suspeito.
 */
export async function downloadStoredMedia(storagePath: string, maxBytes = 6 * 1024 * 1024): Promise<Buffer | null> {
  try {
    const { data, error } = await db.storage.from(BUCKET).download(storagePath);
    if (error || !data) {
      await writeLog('warn', 'media', `download da mídia hospedada falhou: ${error?.message ?? 'sem corpo'}`);
      return null;
    }
    const buf = Buffer.from(await data.arrayBuffer());
    if (!buf.length || buf.length > maxBytes) return null;
    return buf;
  } catch (err) {
    await writeLog('warn', 'media', `download da mídia hospedada (exceção): ${String(err).slice(0, 160)}`);
    return null;
  }
}
