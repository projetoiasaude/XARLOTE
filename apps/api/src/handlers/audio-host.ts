// Hospeda áudio TTS numa URL pública (Supabase Storage) pra enviar voice note
// pelo WhatsApp oficial (WABA via zpro): o endpoint /voice do zpro exige a mídia
// por URL, não base64. Bucket `xarlote-audio` é público (RLS off — só áudio TTS
// efêmero, sem PII).
import { randomUUID } from 'crypto';
import { db, writeLog } from '@iasaude/db';

const BUCKET = 'xarlote-audio';

const extFor = (mime: string): string =>
  /ogg|opus/i.test(mime) ? 'ogg' : /mpeg|mp3/i.test(mime) ? 'mp3' : /mp4|m4a|aac/i.test(mime) ? 'm4a' : 'ogg';

/**
 * Sobe o buffer e devolve a URL pública. `null` em falha (caller cai pro base64
 * ou texto). Caminho com data pra facilitar limpeza futura por prefixo.
 */
export async function uploadPublicAudio(
  buffer: Buffer,
  mime: string,
  traceId?: string,
): Promise<string | null> {
  try {
    const path = `tts/${new Date().toISOString().slice(0, 10)}/${randomUUID()}.${extFor(mime)}`;
    const { error } = await db.storage.from(BUCKET).upload(path, buffer, {
      contentType: mime,
      upsert: true,
    });
    if (error) {
      await writeLog('warn', 'tts', `upload do áudio pro storage falhou: ${error.message}`, { traceId });
      return null;
    }
    const { data } = db.storage.from(BUCKET).getPublicUrl(path);
    return data?.publicUrl ?? null;
  } catch (err) {
    await writeLog('warn', 'tts', `upload do áudio (exceção): ${String(err).slice(0, 160)}`, { traceId });
    return null;
  }
}
