import { parsePhoneNumber } from 'libphonenumber-js';
import type { NormalizedInbound } from '@iasaude/shared';
import type { UazapiWebhookPayload } from './types.js';
import { extractSharedContacts } from './contacts.js';

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
  const mediaType = (msg.mediaType || '').toLowerCase();

  // Resposta de botão/lista (clique em quick_reply ou item de lista).
  // uazapi entrega como type='media', messageType='ButtonsResponseMessage' (ou ListResponseMessage),
  // mediaType='buttons_response', com o texto selecionado em msg.buttonOrListid / vote /
  // content.Response.SelectedDisplayText / content.selectedButtonID. msg.text vem vazio nesse caso,
  // então o fluxo de texto não pega — precisa desse branch antes.
  const isButtonReply =
    messageType === 'buttonsresponsemessage' ||
    messageType === 'listresponsemessage' ||
    messageType === 'templatebuttonreplymessage' ||
    messageType === 'interactiveresponsemessage' ||
    mediaType === 'buttons_response' ||
    mediaType === 'list_response';

  if (isButtonReply) {
    const text =
      msg.buttonOrListid ||
      msg.vote ||
      msg.content?.Response?.SelectedDisplayText ||
      msg.content?.selectedButtonID ||
      msg.text ||
      '';
    return { ...base, contentType: 'text', text };
  }

  // Contato(s) compartilhado(s) — best-effort (shape uazapi não capturado; tenta
  // as chaves prováveis). Trata como texto + anexa sharedContacts.
  if (type.includes('contact') || messageType.includes('contact')) {
    const m = msg as unknown as Record<string, unknown>;
    const contacts = extractSharedContacts(m['contacts'] ?? (m['content'] as Record<string, unknown>)?.['contacts'] ?? m);
    if (contacts.length) {
      const names = contacts.map((c) => c.name).join(', ');
      return {
        ...base,
        contentType: 'text',
        text: `[Compartilhou ${contacts.length > 1 ? 'os contatos' : 'o contato'}: ${names}]`,
        sharedContacts: contacts,
      };
    }
    // Contato sem número legível → não dropa (dead air): pede o número digitado.
    return {
      ...base,
      contentType: 'text',
      text: '[O usuário compartilhou um contato, mas não consegui ler o número — peça pra ele digitar o WhatsApp com DDD]',
    };
  }

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

  // Localização — uazapi pode entregar lat/lng em vários lugares dependendo da versão:
  // 1) msg.content.degreesLatitude / degreesLongitude (formato Baileys, atual)
  // 2) msg.latitude / msg.longitude (formato antigo/simplificado)
  // mediaType também identifica ('location') quando type vem como 'media'.
  if (
    type === 'location' ||
    messageType.includes('location') ||
    msg.mediaType === 'location'
  ) {
    const lat = msg.content?.degreesLatitude ?? msg.latitude;
    const lng = msg.content?.degreesLongitude ?? msg.longitude;

    // Se as coords vieram inválidas (formato desconhecido ou bug do cliente WhatsApp),
    // converte pra texto sinalizando o problema, pra Xarlote pedir reenvio ou CEP.
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
      location: {
        lat,
        lng,
        name: msg.content?.name ?? msg.locationName,
        address: msg.content?.address ?? msg.locationAddress,
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
