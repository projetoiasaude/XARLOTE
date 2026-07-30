/**
 * Hospedagem pública de mídia RECEBIDA do paciente (30/07).
 *
 * Por que existe: a foto que o paciente manda vivia só durante o turno — `media_storage_path`
 * era gravado como `null` sempre. Depois do turno a imagem sumia, então era impossível
 * ENCAMINHAR o documento à clínica/farmácia mais tarde. O caso Glauber travou exatamente
 * aqui: o consultório pediu foto da carteirinha e do pedido médico, e a Xarlote não tinha
 * como repassar nada.
 *
 * O reenvio pelo WhatsApp exige URL pública (o zpro manda imagem por URL), e a URL original
 * do Meta é protegida por token e expira. Então guardamos uma cópia no Storage e usamos a URL
 * dela. Espelha o `audio-host` do TTS, que já faz isso pro áudio de saída.
 */
import { db, writeLog } from '@iasaude/db';
import { randomUUID } from 'node:crypto';

const BUCKET = 'xarlote-media';

function extFor(mime: string): string {
  if (mime.includes('png')) return 'png';
  if (mime.includes('webp')) return 'webp';
  if (mime.includes('pdf')) return 'pdf';
  if (mime.includes('heic')) return 'heic';
  return 'jpg';
}

/**
 * Sobe a mídia recebida e devolve `{ path, url }` público, ou null em falha.
 * Best-effort: falhar aqui NUNCA pode derrubar o turno — a leitura da imagem
 * (visão) já aconteceu e vale por si só.
 */
export async function uploadInboundMedia(
  buffer: Buffer,
  mime: string,
  traceId?: string,
): Promise<{ path: string; url: string } | null> {
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
    const { data } = db.storage.from(BUCKET).getPublicUrl(path);
    if (!data?.publicUrl) return null;
    return { path, url: data.publicUrl };
  } catch (err) {
    await writeLog('warn', 'media', `upload da mídia (exceção): ${String(err).slice(0, 160)}`, { traceId });
    return null;
  }
}

/** URL pública de uma mídia já hospedada (a partir do `media_storage_path` salvo). */
export function publicUrlForStoredMedia(storagePath: string): string | null {
  try {
    const { data } = db.storage.from(BUCKET).getPublicUrl(storagePath);
    return data?.publicUrl ?? null;
  } catch {
    return null;
  }
}
