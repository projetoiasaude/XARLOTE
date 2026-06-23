// Cliente de SAÍDA do zpro (API Externa) — WhatsApp Business API oficial.
//
// Contrato CONFIRMADO pelo OpenAPI oficial do zpro (rota /v2/api/external/{ApiID}):
//   - Auth:    Authorization: Bearer <token>
//   - Número:  só dígitos com DDI, sem '+', sem @c.us  (ex.: "5562998345024")
//   - Texto:   POST {externalUrl}                 { number, body }
//   - MídiaURL POST {externalUrl}/url             { number, body(=legenda), mediaUrl }
//   - Base64:  POST {externalUrl}/base64          { number, body, base64Data, mimeType, fileName }
//   - Voz/PTT: POST {externalUrl}/voice           { number, audio(=URL) }
//   - Botões:  POST {externalUrl}/sendButtonWABA  { number, message, button1..3, ticketId }
//
// externalUrl = `${ZPRO_BASE_URL}/v2/api/external/${ZPRO_<INSTANCE>_API_ID}`
import axios from 'axios';
import { randomUUID } from 'crypto';

interface ZproConfig {
  externalUrl: string;
  token: string;
}

export function buildZproConfig(instance: string): ZproConfig {
  const base = (process.env['ZPRO_BASE_URL'] ?? '').replace(/\/+$/, '');
  const upper = instance.toUpperCase();
  const apiId = process.env[`ZPRO_${upper}_API_ID`] ?? '';
  const token = process.env[`ZPRO_${upper}_TOKEN`] ?? '';
  const externalUrl = base && apiId ? `${base}/v2/api/external/${apiId}` : '';
  return { externalUrl, token };
}

async function zproCall(cfg: ZproConfig, path: string, body: unknown): Promise<unknown> {
  if (!cfg.externalUrl) {
    throw new Error('zpro não configurado (ZPRO_BASE_URL / ZPRO_*_API_ID / ZPRO_*_TOKEN)');
  }
  try {
    const res = await axios.post(`${cfg.externalUrl}${path}`, body, {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.token}`,
      },
      timeout: 15_000,
    });
    // O zpro às vezes responde 200 com `{success:false, error:...}` (ex.: formato
    // de áudio que o WABA não entrega). Sem checar isso, o envio "falha em
    // silêncio" — tratamos como erro pra o caller cair no fallback (texto).
    const data = res.data as { success?: boolean; error?: string } | null;
    if (data && typeof data === 'object' && data.success === false) {
      throw new Error(`zpro ${path || '/text'} success=false: ${String(data.error ?? '').slice(0, 300)}`);
    }
    return res.data;
  } catch (err) {
    // Propaga o CORPO da resposta de erro do zpro pra mensagem do Error — assim o
    // log da fila outbound (que imprime String(err)) mostra POR QUE o zpro recusou
    // (ex.: 400 com o campo faltante), em vez de só "AxiosError 400".
    const ax = err as { response?: { status?: number; data?: unknown } };
    const status = ax.response?.status;
    if (status) {
      let detail: string;
      try {
        detail =
          typeof ax.response?.data === 'string'
            ? ax.response.data
            : JSON.stringify(ax.response?.data);
      } catch {
        detail = '<unserializable>';
      }
      throw new Error(`zpro ${path || '/text'} HTTP ${status}: ${detail.slice(0, 400)}`);
    }
    throw err;
  }
}

/** O shape da resposta do zpro não é documentado — extraímos um id best-effort. */
function pickMessageId(data: unknown): string {
  if (!data || typeof data !== 'object') return '';
  const d = data as Record<string, unknown>;
  const candidates: unknown[] = [
    d['messageId'],
    d['id'],
    d['wamid'],
    (d['message'] as Record<string, unknown> | undefined)?.['id'],
    (d['data'] as Record<string, unknown> | undefined)?.['id'],
    Array.isArray(d['messages']) ? (d['messages'][0] as Record<string, unknown>)?.['id'] : undefined,
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c) return c;
    if (typeof c === 'number') return String(c);
  }
  return '';
}

function toNumber(phoneE164: string): string {
  return phoneE164.replace(/\D/g, '');
}

export async function zproSendText(
  instance: string,
  phoneE164: string,
  text: string,
): Promise<{ messageId: string }> {
  const cfg = buildZproConfig(instance);
  const data = await zproCall(cfg, '', {
    number: toNumber(phoneE164),
    body: text,
    externalKey: randomUUID(),
    isClosed: false,
  });
  return { messageId: pickMessageId(data) };
}

/**
 * Botões interativos (WABA reply buttons, máx 3) via /sendButtonWABA.
 *
 * O payload do zpro é "achatado" (button1/button2/button3, strings).
 * `ticketId` é incluído quando conhecido (vem do webhook de entrada). Quando
 * ausente, mandamos sem — alguns deploys do zpro resolvem o ticket pelo número;
 * se rejeitar, o caller (fila/handler) já degrada pra texto.
 *
 * O zpro não tem campo de footer aqui — então embutimos o footer no corpo.
 */
export async function zproSendMenu(
  instance: string,
  phoneE164: string,
  text: string,
  choices: string[],
  opts: { footerText?: string; ticketId?: number | string } = {},
): Promise<{ messageId: string }> {
  const cfg = buildZproConfig(instance);
  const top3 = choices.slice(0, 3);
  const message = opts.footerText ? `${text}\n\n${opts.footerText}` : text;
  const body: Record<string, unknown> = {
    number: toNumber(phoneE164),
    message,
    externalKey: randomUUID(),
  };
  top3.forEach((label, i) => {
    body[`button${i + 1}`] = label;
  });
  if (opts.ticketId !== undefined && opts.ticketId !== null && opts.ticketId !== '') {
    const tid = Number(opts.ticketId);
    body['ticketId'] = Number.isFinite(tid) ? tid : opts.ticketId;
  }
  const data = await zproCall(cfg, '/sendButtonWABA', body);
  return { messageId: pickMessageId(data) };
}

export async function zproSendImage(
  instance: string,
  phoneE164: string,
  imageUrl: string,
  caption?: string,
): Promise<{ messageId: string }> {
  const cfg = buildZproConfig(instance);
  const data = await zproCall(cfg, '/url', {
    number: toNumber(phoneE164),
    mediaUrl: imageUrl,
    body: caption ?? '',
    externalKey: randomUUID(),
    isClosed: false,
  });
  return { messageId: pickMessageId(data) };
}

/**
 * Áudio. O zpro só faz PTT (voice note) por URL (/voice). Quando temos um
 * Buffer (TTS gerado), não há URL pública — então mandamos via /base64 como
 * arquivo de áudio. Se o caller quiser PTT garantido, precisa passar URL.
 */
export async function zproSendAudio(
  instance: string,
  phoneE164: string,
  audio: Buffer | string,
  opts: { mime?: string } = {},
): Promise<{ messageId: string }> {
  const cfg = buildZproConfig(instance);
  const number = toNumber(phoneE164);
  if (typeof audio === 'string') {
    const data = await zproCall(cfg, '/voice', { number, audio, externalKey: randomUUID(), isClosed: false });
    return { messageId: pickMessageId(data) };
  }
  // Buffer → /base64. O fileName precisa BATER com o mime, senão o zpro/WABA pode
  // recusar ou tratar como arquivo errado. (audio/mpeg→.mp3, audio/ogg→.ogg, …)
  const mime = opts.mime ?? 'audio/ogg';
  const ext = /mpeg|mp3/i.test(mime)
    ? 'mp3'
    : /ogg|opus/i.test(mime)
      ? 'ogg'
      : /wav/i.test(mime)
        ? 'wav'
        : /mp4|m4a|aac/i.test(mime)
          ? 'm4a'
          : 'mp3';
  const data = await zproCall(cfg, '/base64', {
    number,
    body: '',
    base64Data: audio.toString('base64'),
    mimeType: mime,
    fileName: `audio.${ext}`,
    externalKey: randomUUID(),
    isClosed: false,
  });
  return { messageId: pickMessageId(data) };
}

// A API externa do zpro não expõe checagem de número nem status de instância de
// forma documentada. Como nenhum caller depende disso hoje, devolvemos otimista
// (não bloquear envio / não derrubar health-check).
export async function zproCheckWhatsApp(
  _instance: string,
  _phoneE164: string,
): Promise<{ exists: boolean; jid?: string }> {
  return { exists: true };
}

export async function zproGetInstanceStatus(_instance: string): Promise<{ connected: boolean }> {
  return { connected: true };
}
