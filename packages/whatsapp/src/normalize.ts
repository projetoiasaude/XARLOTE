import { parsePhoneNumber } from 'libphonenumber-js';
import type { NormalizedInbound } from '@iasaude/shared';
import type { UazapiWebhookPayload } from './types.js';

export function normalizeWebhookPayload(payload: UazapiWebhookPayload): NormalizedInbound | null {
  const { data, instance } = payload;
  if (!data?.key?.remoteJid || data.key.fromMe) return null;

  const jid = data.key.remoteJid;
  const rawPhone = jid.replace('@s.whatsapp.net', '').replace('@c.us', '');
  let phoneE164 = rawPhone;
  try {
    phoneE164 = parsePhoneNumber(`+${rawPhone}`).format('E.164');
  } catch {
    phoneE164 = `+${rawPhone}`;
  }

  const msg = data.message;
  if (!msg) return null;

  const base: Omit<NormalizedInbound, 'contentType' | 'text' | 'location'> = {
    instance,
    externalId: data.key.id,
    from: { jid, pushName: data.pushName, phoneE164 },
    fromMe: false,
    timestamp: new Date((data.messageTimestamp ?? Date.now() / 1000) * 1000),
    raw: payload,
  };

  if (msg.conversation || msg.extendedTextMessage?.text) {
    return { ...base, contentType: 'text', text: msg.conversation ?? msg.extendedTextMessage?.text };
  }
  if (msg.imageMessage) {
    return { ...base, contentType: 'image', text: msg.imageMessage.caption, mediaMime: msg.imageMessage.mimetype, mediaUrl: msg.imageMessage.url };
  }
  if (msg.audioMessage) {
    return { ...base, contentType: 'audio', mediaMime: msg.audioMessage.mimetype, mediaUrl: msg.audioMessage.url, mediaDurationMs: (msg.audioMessage.seconds ?? 0) * 1000 };
  }
  if (msg.locationMessage) {
    return {
      ...base,
      contentType: 'location',
      location: {
        lat: msg.locationMessage.degreesLatitude,
        lng: msg.locationMessage.degreesLongitude,
        name: msg.locationMessage.name,
        address: msg.locationMessage.address,
      },
    };
  }
  if (msg.documentMessage) {
    return { ...base, contentType: 'document', text: msg.documentMessage.title, mediaMime: msg.documentMessage.mimetype, mediaUrl: msg.documentMessage.url };
  }

  return null;
}

export function jidToE164(jid: string): string {
  const raw = jid.replace('@s.whatsapp.net', '').replace('@c.us', '');
  try {
    return parsePhoneNumber(`+${raw}`).format('E.164');
  } catch {
    return `+${raw}`;
  }
}

export function e164ToJid(phoneE164: string): string {
  return `${phoneE164.replace('+', '')}@s.whatsapp.net`;
}
