import axios from 'axios';

interface ClientConfig {
  serverUrl: string;
  token: string;
  instance: string;
}

function buildConfig(instance: 'sara' | 'agent' | string): ClientConfig {
  const serverUrl = process.env['UAZAPI_SERVER_URL'] ?? '';
  const upper = instance.toUpperCase();
  const token = process.env[`UAZAPI_${upper}_TOKEN`] ?? '';
  // UAZAPI_SARA_INSTANCE / UAZAPI_AGENT_INSTANCE permite usar um nome diferente de 'sara'/'agent'
  const instanceName = process.env[`UAZAPI_${upper}_INSTANCE`] ?? instance;
  return { serverUrl, token, instance: instanceName };
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
  const result = await apiCall(cfg, 'POST', `/message/sendText/${cfg.instance}`, { number, text });
  return { messageId: result?.key?.id ?? result?.messageId ?? '' };
}

export async function sendImage(instance: string, phoneE164: string, imageUrl: string, caption?: string): Promise<{ messageId: string }> {
  const cfg = buildConfig(instance);
  const number = phoneE164.replace('+', '');
  const result = await apiCall(cfg, 'POST', `/message/sendImage/${cfg.instance}`, { number, image: imageUrl, caption });
  return { messageId: result?.key?.id ?? '' };
}

export async function setPresence(instance: string, phoneE164: string, state: 'composing' | 'paused'): Promise<void> {
  const cfg = buildConfig(instance);
  const number = phoneE164.replace('+', '');
  await apiCall(cfg, 'POST', `/chat/presence/${cfg.instance}`, { number, presence: state });
}

export async function checkWhatsApp(instance: string, phoneE164: string): Promise<{ exists: boolean; jid?: string }> {
  const cfg = buildConfig(instance);
  const number = phoneE164.replace('+', '');
  try {
    const result = await apiCall(cfg, 'GET', `/chat/whatsappNumbers/${cfg.instance}?numbers=${number}`);
    const entry = Array.isArray(result) ? result[0] : result;
    return { exists: !!entry?.exists, jid: entry?.jid };
  } catch {
    return { exists: false };
  }
}

export async function getInstanceStatus(instance: string): Promise<{ connected: boolean }> {
  const cfg = buildConfig(instance);
  try {
    const result = await apiCall(cfg, 'GET', `/instance/connectionState/${cfg.instance}`);
    return { connected: result?.state === 'open' };
  } catch {
    return { connected: false };
  }
}

export async function downloadMedia(instance: string, messageId: string): Promise<Buffer | null> {
  const cfg = buildConfig(instance);
  try {
    const result = await apiCall(cfg, 'POST', `/chat/getBase64FromMediaMessage/${cfg.instance}`, { messageId });
    if (!result?.base64) return null;
    return Buffer.from(result.base64, 'base64');
  } catch {
    return null;
  }
}
