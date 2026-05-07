import axios from 'axios';

interface ClientConfig {
  serverUrl: string;
  token: string;
}

function buildConfig(instance: 'sara' | 'agent' | string): ClientConfig {
  const serverUrl = process.env['UAZAPI_SERVER_URL'] ?? '';
  const upper = instance.toUpperCase();
  const token = process.env[`UAZAPI_${upper}_TOKEN`] ?? '';
  return { serverUrl, token };
}

async function apiCall(cfg: ClientConfig, method: string, path: string, body?: unknown) {
  const res = await axios({
    method,
    url: `${cfg.serverUrl}${path}`,
    headers: {
      'Content-Type': 'application/json',
      token: cfg.token,
    },
    data: body,
    timeout: 15_000,
  });
  return res.data;
}

export async function sendText(instance: string, phoneE164: string, text: string): Promise<{ messageId: string }> {
  const cfg = buildConfig(instance);
  const number = phoneE164.replace('+', '');
  const result = await apiCall(cfg, 'POST', '/send/text', { number, text });
  return { messageId: result?.messageid ?? result?.id ?? '' };
}

/**
 * Envia menu interativo (botões clicáveis) via uazapi.
 * Doc: https://docs.uazapi.com/endpoint/post/send~menu
 *
 * @param type - 'button' (até 3 opções), 'list', 'poll', etc.
 * @param choices - Array de opções (ex: ['Aceitar', 'Recusar']).
 */
export async function sendMenu(
  instance: string,
  phoneE164: string,
  text: string,
  choices: string[],
  opts: { type?: 'button' | 'list' | 'poll'; footerText?: string } = {}
): Promise<{ messageId: string }> {
  const cfg = buildConfig(instance);
  const number = phoneE164.replace('+', '');
  const result = await apiCall(cfg, 'POST', '/send/menu', {
    number,
    type: opts.type ?? 'button',
    text,
    choices,
    ...(opts.footerText ? { footerText: opts.footerText } : {}),
  });
  return { messageId: result?.messageid ?? result?.id ?? '' };
}

export async function sendImage(instance: string, phoneE164: string, imageUrl: string, caption?: string): Promise<{ messageId: string }> {
  const cfg = buildConfig(instance);
  const number = phoneE164.replace('+', '');
  const result = await apiCall(cfg, 'POST', '/send/media', {
    number,
    type: 'image',
    file: imageUrl,
    text: caption,
  });
  return { messageId: result?.messageid ?? result?.id ?? '' };
}

// uazapi não tem endpoint de presence isolado documentado de forma estável — desativado.
export async function setPresence(_instance: string, _phoneE164: string, _state: 'composing' | 'paused'): Promise<void> {
  return;
}

export async function checkWhatsApp(instance: string, phoneE164: string): Promise<{ exists: boolean; jid?: string }> {
  const cfg = buildConfig(instance);
  const number = phoneE164.replace('+', '');
  try {
    const result = await apiCall(cfg, 'POST', '/chat/check', { numbers: [number] });
    const entry = Array.isArray(result) ? result[0] : result?.[0] ?? result;
    return { exists: !!entry?.exists || !!entry?.isInWhatsapp, jid: entry?.jid };
  } catch {
    return { exists: false };
  }
}

export async function getInstanceStatus(instance: string): Promise<{ connected: boolean }> {
  const cfg = buildConfig(instance);
  try {
    const result = await apiCall(cfg, 'GET', '/instance/status');
    return { connected: result?.status?.connected === true || result?.instance?.status === 'connected' };
  } catch {
    return { connected: false };
  }
}

/**
 * Baixa o conteúdo binário de uma mídia (áudio/imagem/doc) via uazapi.
 *
 * IMPORTANTE: o `messageId` aqui precisa ser o **id longo** do payload
 * (ex.: `556298345024:3A6A22A40561634EC12A`), NÃO o `messageid` curto.
 * Internamente uazapi devolve `{fileURL, mimetype}` apontando pro CDN dela
 * (ex.: `https://criate.uazapi.com/files/<sha>.jpg`) — fazemos um segundo
 * GET pra puxar o buffer.
 *
 * Retorna `null` em qualquer falha (caller decide o fallback de UX).
 */
export async function downloadMedia(
  instance: string,
  messageId: string
): Promise<{ buffer: Buffer; mime: string } | null> {
  const cfg = buildConfig(instance);
  try {
    const result = await apiCall(cfg, 'POST', '/message/download', { id: messageId });
    // Caminho atual da uazapi: { fileURL, mimetype }
    if (result?.fileURL) {
      const fileRes = await axios.get<ArrayBuffer>(result.fileURL, {
        responseType: 'arraybuffer',
        timeout: 30_000,
      });
      return {
        buffer: Buffer.from(fileRes.data),
        mime: result.mimetype || 'application/octet-stream',
      };
    }
    // Fallback legado: caso a API volte a entregar base64
    if (result?.base64) {
      return {
        buffer: Buffer.from(result.base64, 'base64'),
        mime: result.mimetype || 'application/octet-stream',
      };
    }
    return null;
  } catch {
    return null;
  }
}
