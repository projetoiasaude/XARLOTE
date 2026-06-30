// Client de WhatsApp — fachada ÚNICA de I/O, despacha por PROVEDOR.
//
// A interface pública (sendText, sendMenu, sendImage, sendAudio, downloadMedia,
// fetchInboundMedia, …) é estável; cada função decide entre uazapi e zpro/WABA
// pela instância (ver provider.ts). Assim NENHUM call-site precisa saber qual
// provedor está ativo — sara→zpro (oficial), agent→uazapi.
import axios from 'axios';
import type { NormalizedInbound } from '@iasaude/shared';
import { providerFor } from './provider.js';
import {
  buildZproConfig,
  zproSendText,
  zproSendMenu,
  zproSendImage,
  zproSendAudio,
  zproSendTemplate,
  zproCheckWhatsApp,
  zproGetInstanceStatus,
} from './zpro-client.js';

// ─── uazapi (não-oficial) — implementação interna ────────────────────────────

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

async function uazSendText(instance: string, phoneE164: string, text: string): Promise<{ messageId: string }> {
  const cfg = buildConfig(instance);
  const number = phoneE164.replace('+', '');
  const result = await apiCall(cfg, 'POST', '/send/text', { number, text });
  return { messageId: result?.messageid ?? result?.id ?? '' };
}

async function uazSendMenu(
  instance: string,
  phoneE164: string,
  text: string,
  choices: string[],
  opts: { type?: 'button' | 'list' | 'poll'; footerText?: string } = {},
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

async function uazSendImage(instance: string, phoneE164: string, imageUrl: string, caption?: string): Promise<{ messageId: string }> {
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

async function uazSendAudio(
  instance: string,
  phoneE164: string,
  audio: Buffer | string,
  opts: { mime?: string; ptv?: boolean } = {},
): Promise<{ messageId: string }> {
  const cfg = buildConfig(instance);
  const number = phoneE164.replace('+', '');
  const file = Buffer.isBuffer(audio) ? audio.toString('base64') : audio;
  const result = await apiCall(cfg, 'POST', '/send/media', {
    number,
    type: opts.ptv === false ? 'audio' : 'ptt',
    file,
    ...(opts.mime ? { mimetype: opts.mime } : {}),
  });
  return { messageId: result?.messageid ?? result?.id ?? '' };
}

async function uazCheckWhatsApp(instance: string, phoneE164: string): Promise<{ exists: boolean; jid?: string }> {
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

async function uazGetInstanceStatus(instance: string): Promise<{ connected: boolean }> {
  const cfg = buildConfig(instance);
  try {
    const result = await apiCall(cfg, 'GET', '/instance/status');
    return { connected: result?.status?.connected === true || result?.instance?.status === 'connected' };
  } catch {
    return { connected: false };
  }
}

/**
 * Baixa mídia via uazapi a partir do **id longo** (ex.: `5562…:3A6A…`).
 * uazapi devolve `{fileURL, mimetype}` (CDN) ou `{base64, mimetype}`.
 */
async function uazDownloadMedia(instance: string, messageId: string): Promise<{ buffer: Buffer; mime: string } | null> {
  const cfg = buildConfig(instance);
  try {
    const result = await apiCall(cfg, 'POST', '/message/download', { id: messageId });
    if (result?.fileURL) {
      const fileRes = await axios.get<ArrayBuffer>(result.fileURL, { responseType: 'arraybuffer', timeout: 30_000 });
      return { buffer: Buffer.from(fileRes.data), mime: result.mimetype || 'application/octet-stream' };
    }
    if (result?.base64) {
      return { buffer: Buffer.from(result.base64, 'base64'), mime: result.mimetype || 'application/octet-stream' };
    }
    return null;
  } catch {
    return null;
  }
}

// ─── Fachada pública (despacha por provedor) ─────────────────────────────────

export async function sendText(instance: string, phoneE164: string, text: string): Promise<{ messageId: string }> {
  return providerFor(instance) === 'zpro'
    ? zproSendText(instance, phoneE164, text)
    : uazSendText(instance, phoneE164, text);
}

/**
 * Menu interativo (botões clicáveis).
 * - uazapi: /send/menu (usa opts.type).
 * - zpro/WABA: /sendButtonWABA (máx 3 botões; usa opts.ticketId quando houver).
 */
export async function sendMenu(
  instance: string,
  phoneE164: string,
  text: string,
  choices: string[],
  opts: { type?: 'button' | 'list' | 'poll'; footerText?: string; ticketId?: number | string } = {},
): Promise<{ messageId: string }> {
  if (providerFor(instance) === 'zpro') {
    return zproSendMenu(instance, phoneE164, text, choices, { footerText: opts.footerText, ticketId: opts.ticketId });
  }
  return uazSendMenu(instance, phoneE164, text, choices, { type: opts.type, footerText: opts.footerText });
}

export async function sendImage(instance: string, phoneE164: string, imageUrl: string, caption?: string): Promise<{ messageId: string }> {
  return providerFor(instance) === 'zpro'
    ? zproSendImage(instance, phoneE164, imageUrl, caption)
    : uazSendImage(instance, phoneE164, imageUrl, caption);
}

/**
 * Áudio (voice note). uazapi aceita Buffer (base64) ou URL; zpro faz PTT só por
 * URL (/voice) e cai pra /base64 quando recebe Buffer.
 */
export async function sendAudio(
  instance: string,
  phoneE164: string,
  audio: Buffer | string,
  opts: { mime?: string; ptv?: boolean } = {},
): Promise<{ messageId: string }> {
  return providerFor(instance) === 'zpro'
    ? zproSendAudio(instance, phoneE164, audio, { mime: opts.mime })
    : uazSendAudio(instance, phoneE164, audio, opts);
}

/**
 * Envia um TEMPLATE (HSM) aprovado — abertura fria de conversa no WABA oficial.
 * Só o zpro (canal oficial) suporta HSM; uazapi não tem template → LANÇA pra o
 * caller cair no fallback de texto. (Ver fila outbound: kind='template'.)
 */
export async function sendTemplate(
  instance: string,
  phoneE164: string,
  template: { name: string; language: string; variables: string[] },
): Promise<{ messageId: string }> {
  if (providerFor(instance) === 'zpro') {
    return zproSendTemplate(instance, phoneE164, template);
  }
  throw new Error('templates (HSM) só existem no canal oficial (zpro) — provider atual não suporta');
}

// Nenhum provedor expõe presence isolado de forma estável — no-op.
export async function setPresence(_instance: string, _phoneE164: string, _state: 'composing' | 'paused'): Promise<void> {
  return;
}

export async function checkWhatsApp(instance: string, phoneE164: string): Promise<{ exists: boolean; jid?: string }> {
  return providerFor(instance) === 'zpro'
    ? zproCheckWhatsApp(instance, phoneE164)
    : uazCheckWhatsApp(instance, phoneE164);
}

export async function getInstanceStatus(instance: string): Promise<{ connected: boolean }> {
  return providerFor(instance) === 'zpro'
    ? zproGetInstanceStatus(instance)
    : uazGetInstanceStatus(instance);
}

/**
 * Baixa mídia por id (compat uazapi). No zpro não há download por id — a mídia
 * recebida vem com URL no próprio webhook, baixada por `fetchInboundMedia`.
 */
export async function downloadMedia(instance: string, messageId: string): Promise<{ buffer: Buffer; mime: string } | null> {
  if (providerFor(instance) === 'zpro') return null;
  return uazDownloadMedia(instance, messageId);
}

/**
 * GET de uma URL → buffer. LANÇA em falha (com status no erro) — quem chama
 * decide o fallback. `forceBearer`: manda o Bearer já na 1ª tentativa (URLs do
 * Meta exigem isso); senão só retenta com Bearer em 401/403 (mídia do zpro).
 */
async function fetchUrlBuffer(
  url: string,
  bearer?: string,
  forceBearer = false,
): Promise<{ buffer: Buffer; mime: string }> {
  const auth = bearer ? { Authorization: `Bearer ${bearer}` } : undefined;
  const doGet = (headers?: Record<string, string>) =>
    axios.get<ArrayBuffer>(url, { responseType: 'arraybuffer', timeout: 30_000, headers });
  const res = await doGet(forceBearer ? auth : undefined).catch((err: unknown) => {
    const status = (err as { response?: { status?: number } })?.response?.status;
    if (auth && !forceBearer && (status === 401 || status === 403)) {
      return doGet(auth);
    }
    throw err;
  });
  const mime = String(res.headers?.['content-type'] ?? 'application/octet-stream').split(';')[0]!.trim();
  return { buffer: Buffer.from(res.data), mime };
}

function metaTokenFor(instance: string): string {
  return (
    process.env[`ZPRO_${instance.toUpperCase()}_META_TOKEN`] ??
    process.env['META_WABA_ACCESS_TOKEN'] ??
    ''
  );
}

/**
 * Obtém o binário de uma mídia recebida, de forma agnóstica de provedor:
 *   - base64 inline (simulador) → decodifica;
 *   - zpro/WABA: baixa a `mediaUrl` do webhook. URLs do Meta (lookaside.fbsbx.com)
 *     são protegidas → exigem o token do WhatsApp Business (ZPRO_*_META_TOKEN)
 *     como Bearer. Mídia hospedada no próprio zpro usa o token do zpro.
 *   - uazapi: id longo + /message/download (caminho provado).
 *
 * Lança em falha de download (com status/host) pra o caller logar o motivo;
 * retorna null só quando não há mídia pra baixar.
 * `instance` é a chave de config (ex.: SARA_INSTANCE), não o nome cru do webhook.
 */
export async function fetchInboundMedia(
  inbound: NormalizedInbound,
  instance: string,
): Promise<{ buffer: Buffer; mime: string } | null> {
  const cleanMime = (m?: string) => (m ? m.split(';')[0]!.trim() : undefined);

  if (inbound.mediaBase64) {
    return {
      buffer: Buffer.from(inbound.mediaBase64, 'base64'),
      mime: cleanMime(inbound.mediaMime) ?? 'application/octet-stream',
    };
  }

  if (providerFor(instance) === 'zpro') {
    const url = inbound.mediaUrl;
    if (!url) return null;
    const isMeta = /(?:lookaside|fbsbx|fbcdn|graph\.facebook)\.com/i.test(url);
    const metaToken = metaTokenFor(instance);
    const bearer = isMeta ? metaToken : buildZproConfig(instance).token;
    try {
      const got = await fetchUrlBuffer(url, bearer || undefined, isMeta && !!metaToken);
      // Se o content-type vier genérico, prefere o mime declarado no webhook.
      const mime =
        !got.mime || got.mime === 'application/octet-stream'
          ? cleanMime(inbound.mediaMime) ?? got.mime
          : got.mime;
      return { buffer: got.buffer, mime };
    } catch (err) {
      const status = (err as { response?: { status?: number }; code?: string })?.response?.status;
      let host = '?';
      try {
        host = new URL(url).host;
      } catch {
        /* ignore */
      }
      const hint = isMeta && !metaToken ? ' — falta ZPRO_*_META_TOKEN p/ baixar mídia do Meta' : '';
      throw new Error(
        `zpro media download ${status ?? (err as { code?: string })?.code ?? 'falhou'} host=${host}${hint}`,
      );
    }
  }

  const longId = (inbound.raw as { message?: { id?: string } } | null)?.message?.id ?? inbound.externalId;
  return uazDownloadMedia(instance, longId);
}
