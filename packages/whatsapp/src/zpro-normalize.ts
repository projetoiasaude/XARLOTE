// Normalizador de ENTRADA do zpro (webhook de mensagens recebidas).
//
// ⚠️ PROVISÓRIO: o zpro NÃO documenta o payload do webhook de entrada em nenhuma
// fonte oficial. Este parser é deliberadamente TOLERANTE — ele tenta várias
// chaves candidatas (estilos whaticket/Baileys/WABA-flat) para cada campo, de
// modo a "funcionar de primeira" na maioria dos formatos. Assim que capturarmos
// um payload real (a rota loga o shape redatado), apertamos as chaves certas.
//
// Devolve `null` para: echo (fromMe), grupo, status/ack, ou shape irreconhecível.
import { parsePhoneNumber } from 'libphonenumber-js';
import type { NormalizedInbound } from '@iasaude/shared';

// ── helpers de extração tolerante ────────────────────────────────────────────

function get(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => {
    if (acc && typeof acc === 'object' && !Array.isArray(acc)) {
      return (acc as Record<string, unknown>)[key];
    }
    if (Array.isArray(acc) && /^\d+$/.test(key)) {
      return acc[Number(key)];
    }
    return undefined;
  }, obj);
}

function pickStr(obj: unknown, paths: string[]): string | undefined {
  for (const p of paths) {
    const v = get(obj, p);
    if (typeof v === 'string' && v.trim()) return v;
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  }
  return undefined;
}

function pickNum(obj: unknown, paths: string[]): number | undefined {
  for (const p of paths) {
    const v = get(obj, p);
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && v.trim() && Number.isFinite(Number(v))) return Number(v);
  }
  return undefined;
}

function pickBool(obj: unknown, paths: string[]): boolean {
  for (const p of paths) {
    const v = get(obj, p);
    if (typeof v === 'boolean') return v;
    if (v === 'true') return true;
    if (v === 'false') return false;
  }
  return false;
}

function toE164(raw: string): string {
  const stripped = raw.replace(/@.*$/, '').replace(/[^\d+]/g, '');
  const digits = stripped.replace(/^\+/, '');
  try {
    return parsePhoneNumber(`+${digits}`).format('E.164');
  } catch {
    return `+${digits}`;
  }
}

// ── chaves candidatas (ajustar quando o payload real for capturado) ──────────

const P = {
  fromMe: ['fromMe', 'key.fromMe', 'data.fromMe', 'data.key.fromMe', 'message.fromMe', 'message.key.fromMe', 'msg.fromMe'],
  isGroup: ['isGroup', 'group', 'data.isGroup', 'key.isGroup', 'ticket.isGroup'],
  sender: [
    'number', 'from', 'sender', 'phone', 'jid',
    'contact.number', 'contact.id', 'contact.jid',
    'data.number', 'data.from', 'data.sender',
    'key.remoteJid', 'data.key.remoteJid', 'message.key.remoteJid',
    'message.from', 'ticket.contact.number', 'ticket.contact.id',
  ],
  pushName: [
    'pushName', 'senderName', 'notifyName', 'name',
    'contact.name', 'contact.pushname', 'contact.pushName',
    'data.pushName', 'data.notifyName', 'ticket.contact.name',
  ],
  type: ['type', 'messageType', 'mediaType', 'data.type', 'data.messageType', 'message.type', 'msg.type'],
  text: [
    'body', 'text', 'caption', 'content', 'msgBody',
    'message', 'data.body', 'data.text', 'data.caption',
    'message.conversation', 'message.extendedTextMessage.text',
    'message.text', 'data.message.conversation',
    'message.imageMessage.caption', 'message.videoMessage.caption', 'message.documentMessage.caption',
  ],
  buttonTitle: [
    'selectedButtonText', 'buttonText', 'selectedDisplayText',
    'interactive.button_reply.title', 'interactive.list_reply.title',
    'message.buttonsResponseMessage.selectedDisplayText',
    'message.listResponseMessage.title',
    'message.interactiveResponseMessage.body.text',
    'data.selectedButtonText',
  ],
  buttonId: [
    'selectedButtonId', 'buttonId',
    'interactive.button_reply.id', 'interactive.list_reply.id',
    'message.buttonsResponseMessage.selectedButtonId',
    'message.listResponseMessage.singleSelectReply.selectedRowId',
  ],
  mediaUrl: [
    'mediaUrl', 'mediaURL', 'url', 'fileUrl', 'fileURL', 'mediaPath',
    'media.url', 'data.mediaUrl', 'data.url', 'message.mediaUrl', 'attachment.url',
  ],
  mime: ['mimetype', 'mimeType', 'mime', 'data.mimetype', 'media.mimetype', 'message.mimetype'],
  duration: ['duration', 'seconds', 'data.duration', 'message.audioMessage.seconds'],
  externalId: [
    'id', 'messageId', 'wamid', 'key.id', 'data.id', 'data.key.id',
    'message.id', 'message.key.id', 'msgId', 'data.messageId',
  ],
  ticketId: ['ticketId', 'ticket.id', 'data.ticketId', 'ticket_id', 'data.ticket.id'],
  timestamp: ['timestamp', 'messageTimestamp', 'data.timestamp', 't', 'date'],
  lat: ['latitude', 'lat', 'location.latitude', 'location.lat', 'message.locationMessage.degreesLatitude', 'data.latitude'],
  lng: ['longitude', 'lng', 'lon', 'location.longitude', 'location.lng', 'message.locationMessage.degreesLongitude', 'data.longitude'],
};

/** Acha um id de evento mesmo quando a mensagem não normaliza (idempotência/captura). */
export function zproEventId(payload: unknown): string | undefined {
  return pickStr(payload, P.externalId);
}

export function normalizeZproWebhook(
  payload: unknown,
  instance: string,
): NormalizedInbound | null {
  if (!payload || typeof payload !== 'object') return null;

  // Echo das próprias mensagens e grupos: ignora.
  if (pickBool(payload, P.fromMe)) return null;
  if (pickBool(payload, P.isGroup)) return null;

  const senderRaw = pickStr(payload, P.sender);
  if (!senderRaw) return null;
  // JIDs de grupo terminam em @g.us — ignora.
  if (senderRaw.includes('@g.us')) return null;

  const phoneE164 = toE164(senderRaw);
  const jid = senderRaw.includes('@') ? senderRaw : `${senderRaw.replace(/\D/g, '')}@s.whatsapp.net`;
  const pushName = pickStr(payload, P.pushName);
  const externalId = pickStr(payload, P.externalId) ?? `zpro-${phoneE164}-${pickStr(payload, P.timestamp) ?? ''}`;
  const ticketId = pickNum(payload, P.ticketId) ?? pickStr(payload, P.ticketId);

  const tsRaw = pickNum(payload, P.timestamp);
  // timestamp pode vir em segundos (WABA) ou ms — heurística pelo tamanho.
  const tsMs = tsRaw == null ? Date.now() : tsRaw > 1e12 ? tsRaw : tsRaw * 1000;

  const base: Omit<NormalizedInbound, 'contentType' | 'text' | 'location'> = {
    instance,
    externalId,
    from: { jid, pushName, phoneE164 },
    fromMe: false,
    timestamp: new Date(tsMs),
    raw: payload,
    ...(ticketId !== undefined ? { providerTicketId: ticketId } : {}),
  };

  const typeStr = (pickStr(payload, P.type) ?? '').toLowerCase();

  // 1) Resposta de botão / lista interativa → trata como texto (o título escolhido).
  //    Na Cloud API o título do botão costuma vir também em `body`, então mesmo
  //    sem casar aqui o fluxo de texto pega. Mas extraímos explicitamente quando dá.
  const btnTitle = pickStr(payload, P.buttonTitle);
  const btnId = pickStr(payload, P.buttonId);
  if (
    typeStr.includes('button') ||
    typeStr.includes('interactive') ||
    typeStr.includes('list') ||
    btnTitle ||
    btnId
  ) {
    const text = btnTitle || pickStr(payload, P.text) || btnId || '';
    return { ...base, contentType: 'text', text };
  }

  // 2) Localização
  const lat = pickNum(payload, P.lat);
  const lng = pickNum(payload, P.lng);
  if (typeStr.includes('location') || (lat != null && lng != null)) {
    if (lat == null || lng == null || (lat === 0 && lng === 0)) {
      return {
        ...base,
        contentType: 'text',
        text: '[Localização compartilhada chegou sem coordenadas válidas — pedir pro usuário enviar de novo ou digitar CEP/endereço com número e bairro]',
      };
    }
    return {
      ...base,
      contentType: 'location',
      location: { lat, lng, name: pickStr(payload, ['name', 'locationName']), address: pickStr(payload, ['address', 'locationAddress']) },
    };
  }

  // 3) Áudio (voz/PTT)
  if (typeStr.includes('audio') || typeStr.includes('voice') || typeStr.includes('ptt')) {
    return {
      ...base,
      contentType: 'audio',
      mediaUrl: pickStr(payload, P.mediaUrl),
      mediaMime: pickStr(payload, P.mime) ?? 'audio/ogg',
      mediaDurationMs: (pickNum(payload, P.duration) ?? 0) * 1000,
    };
  }

  // 4) Imagem
  if (typeStr.includes('image') || typeStr.includes('sticker')) {
    return {
      ...base,
      contentType: 'image',
      text: pickStr(payload, P.text),
      mediaUrl: pickStr(payload, P.mediaUrl),
      mediaMime: pickStr(payload, P.mime) ?? 'image/jpeg',
    };
  }

  // 5) Documento
  if (typeStr.includes('document') || typeStr.includes('file')) {
    return {
      ...base,
      contentType: 'document',
      text: pickStr(payload, P.text),
      mediaUrl: pickStr(payload, P.mediaUrl),
      mediaMime: pickStr(payload, P.mime),
    };
  }

  // 6) Texto (default) — inclui type='text'/'chat'/'conversation' e fallback geral.
  const text = pickStr(payload, P.text);
  if (text || typeStr.includes('text') || typeStr.includes('chat') || typeStr.includes('conversation')) {
    return { ...base, contentType: 'text', text: text ?? '' };
  }

  // Sem corpo reconhecível (provável status/ack) → ignora.
  return null;
}
