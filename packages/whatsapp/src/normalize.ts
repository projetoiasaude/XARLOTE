import { parsePhoneNumber } from 'libphonenumber-js';
import type { NormalizedInbound } from '@iasaude/shared';
import type { UazapiWebhookPayload } from './types.js';

export function normalizeWebhookPayload(payload: UazapiWebhookPayload): NormalizedInbound | null {
  const msg = payload.message;
  if (!msg) return null;

  // Ignora mensagens enviadas pela própria API (echo de outbound)
  if (msg.fromMe || msg.wasSentByApi) return null;

  // Ignora grupos por enquanto
  if (msg.isGroup) return null;

  const jid = msg.chatid || payload.chat?.wa_chatid || '';
  if (!jid) return null;

  const rawPhone = jid.replace('@s.whatsapp.net', '').replace('@c.us', '').replace('@lid', '');
  let phoneE164 = rawPhone;
  try {
    phoneE164 = parsePhoneNumber(`+${rawPhone}`).format('E.164');
  } catch {
    phoneE164 = `+${rawPhone}`;
  }

  const pushName = payload.chat?.wa_name || payload.chat?.name || msg.senderName || undefined;

  const base: Omit<NormalizedInbound, 'contentType' | 'text' | 'location'> = {
    instance: payload.instanceName,
    externalId: msg.messageid || msg.id,
    from: { jid, pushName, phoneE164 },
    fromMe: false,
    timestamp: new Date((msg.messageTimestamp ?? Date.now() / 1000) * 1000),
    raw: payload,
  };

  // uazapi normaliza o tipo em msg.type ('text' | 'image' | 'audio' | 'location' | 'document')
  // Mas também pode vir só messageType ('ExtendedTextMessage', 'Conversation', etc.)
  const type = (msg.type || '').toLowerCase();
  const messageType = (msg.messageType || '').toLowerCase();

  // Texto
  if (type === 'text' || messageType.includes('text') || messageType === 'conversation') {
    const text = msg.text ?? msg.content?.text ?? '';
    return { ...base, contentType: 'text', text };
  }

  // Imagem
  if (type === 'image' || messageType.includes('image')) {
    return {
      ...base,
      contentType: 'image',
      text: msg.text || msg.content?.text,
      mediaMime: msg.mimetype ?? 'image/jpeg',
      mediaUrl: msg.mediaUrl,
    };
  }

  // Áudio
  if (type === 'audio' || messageType.includes('audio') || messageType === 'pttmessage') {
    return {
      ...base,
      contentType: 'audio',
      mediaMime: msg.mimetype ?? 'audio/ogg',
      mediaUrl: msg.mediaUrl,
      mediaDurationMs: (msg.duration ?? 0) * 1000,
    };
  }

  // Localização
  if (type === 'location' || messageType.includes('location')) {
    return {
      ...base,
      contentType: 'location',
      location: {
        lat: msg.latitude ?? 0,
        lng: msg.longitude ?? 0,
        name: msg.locationName,
        address: msg.locationAddress,
      },
    };
  }

  // Documento
  if (type === 'document' || messageType.includes('document')) {
    return {
      ...base,
      contentType: 'document',
      text: msg.text,
      mediaMime: msg.mimetype,
      mediaUrl: msg.mediaUrl,
    };
  }

  // Tipo desconhecido — tenta texto puro como fallback
  if (msg.text) {
    return { ...base, contentType: 'text', text: msg.text };
  }

  return null;
}

export function jidToE164(jid: string): string {
  const raw = jid.replace('@s.whatsapp.net', '').replace('@c.us', '').replace('@lid', '');
  try {
    return parsePhoneNumber(`+${raw}`).format('E.164');
  } catch {
    return `+${raw}`;
  }
}

export function e164ToJid(phoneE164: string): string {
  return `${phoneE164.replace('+', '')}@s.whatsapp.net`;
}
