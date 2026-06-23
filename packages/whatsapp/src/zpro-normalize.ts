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

// Ordem importa: o 1º path que casar vence. O shape REAL do backhub.criate.online
// (WABA) aninha tudo sob `msg` + `ticket` — por isso os paths `msg.*`/`ticket.*`
// vêm primeiro. Os demais ficam como rede de segurança p/ outras versões do zpro.
const P = {
  fromMe: ['msg.fromMe', 'msg.key.fromMe', 'fromMe', 'key.fromMe', 'data.fromMe', 'data.key.fromMe', 'message.fromMe', 'message.key.fromMe'],
  isGroup: ['ticket.isGroup', 'msg.isGroup', 'isGroup', 'group', 'data.isGroup', 'key.isGroup', 'ticket.contact.isGroup'],
  // method/event do envelope zpro — usado p/ ignorar status/ack (só processa 'message').
  method: ['method', 'event', 'action', 'msg.method', 'type_event', 'eventType'],
  sender: [
    'msg.from', 'ticket.contact.number',
    'number', 'from', 'sender', 'phone', 'jid',
    'contact.number', 'contact.id', 'contact.jid',
    'data.number', 'data.from', 'data.sender',
    'key.remoteJid', 'data.key.remoteJid', 'message.key.remoteJid',
    'message.from', 'ticket.contact.id',
  ],
  pushName: [
    'ticket.contact.name', 'ticket.contact.pushname', 'msg.profile.name', 'msg.pushName', 'msg.notifyName',
    'pushName', 'senderName', 'notifyName', 'name',
    'contact.name', 'contact.pushname', 'contact.pushName',
    'data.pushName', 'data.notifyName',
  ],
  type: ['msg.type', 'type', 'messageType', 'mediaType', 'data.type', 'data.messageType', 'message.type'],
  text: [
    'msg.text.body', 'msg.text', 'msg.button.text', 'msg.caption',
    'msg.image.caption', 'msg.video.caption', 'msg.document.caption', 'msg.audio.caption',
    'body', 'text', 'caption', 'content', 'msgBody',
    'message', 'data.body', 'data.text', 'data.caption',
    'message.conversation', 'message.extendedTextMessage.text',
    'message.text', 'data.message.conversation',
    'message.imageMessage.caption', 'message.videoMessage.caption', 'message.documentMessage.caption',
  ],
  buttonTitle: [
    'msg.interactive.button_reply.title', 'msg.interactive.list_reply.title', 'msg.button.text',
    'selectedButtonText', 'buttonText', 'selectedDisplayText',
    'interactive.button_reply.title', 'interactive.list_reply.title',
    'message.buttonsResponseMessage.selectedDisplayText',
    'message.listResponseMessage.title',
    'message.interactiveResponseMessage.body.text',
    'data.selectedButtonText',
  ],
  buttonId: [
    'msg.interactive.button_reply.id', 'msg.interactive.list_reply.id', 'msg.button.payload',
    'selectedButtonId', 'buttonId',
    'interactive.button_reply.id', 'interactive.list_reply.id',
    'message.buttonsResponseMessage.selectedButtonId',
    'message.listResponseMessage.singleSelectReply.selectedRowId',
  ],
  mediaUrl: [
    'msg.audio.url', 'msg.image.url', 'msg.document.url', 'msg.video.url', 'msg.voice.url', 'msg.sticker.url',
    'msg.audio.link', 'msg.image.link', 'msg.document.link', 'msg.media.url',
    'mediaUrl', 'mediaURL', 'url', 'fileUrl', 'fileURL', 'mediaPath',
    'media.url', 'data.mediaUrl', 'data.url', 'message.mediaUrl', 'attachment.url',
  ],
  mime: [
    'msg.audio.mime_type', 'msg.voice.mime_type', 'msg.image.mime_type', 'msg.document.mime_type', 'msg.video.mime_type',
    'mimetype', 'mimeType', 'mime', 'data.mimetype', 'media.mimetype', 'message.mimetype',
  ],
  duration: ['msg.audio.seconds', 'msg.voice.seconds', 'duration', 'seconds', 'data.duration', 'message.audioMessage.seconds'],
  externalId: [
    'msg.id', 'id', 'messageId', 'wamid', 'key.id', 'data.id', 'data.key.id',
    'message.id', 'message.key.id', 'msgId', 'data.messageId',
  ],
  ticketId: ['ticket.id', 'ticketId', 'data.ticketId', 'ticket_id', 'data.ticket.id', 'msg.ticketId'],
  timestamp: ['msg.timestamp', 'timestamp', 'messageTimestamp', 'data.timestamp', 't', 'date'],
  lat: ['msg.location.latitude', 'latitude', 'lat', 'location.latitude', 'location.lat', 'message.locationMessage.degreesLatitude', 'data.latitude'],
  lng: ['msg.location.longitude', 'longitude', 'lng', 'lon', 'location.longitude', 'location.lng', 'message.locationMessage.degreesLongitude', 'data.longitude'],
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

  // Só mensagens RECEBIDAS. O zpro também posta status/ack/echo no mesmo webhook —
  // o envelope traz `method` ('message' = recebida). Se vier outro method, ignora.
  const method = (pickStr(payload, P.method) ?? '').toLowerCase();
  if (method && !['message', 'messages', 'received', 'message_received', 'onmessage'].includes(method)) {
    return null;
  }

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
