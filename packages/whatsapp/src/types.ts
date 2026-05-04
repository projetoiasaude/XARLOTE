// Tipos baseados no payload REAL enviado pela uazapi (criate.uazapi.com).
// Estrutura difere do Baileys: usa EventType, instanceName, message.text, etc.

export interface UazapiSendTextPayload {
  number: string;
  text: string;
  quotedMsgId?: string;
}

export interface UazapiSendImagePayload {
  number: string;
  image: string;
  caption?: string;
}

export interface UazapiWebhookMessage {
  chatid: string;
  chatlid?: string;
  content?: {
    text?: string;
    contextInfo?: unknown;
    // Campos específicos de localização (uazapi coloca lat/lng dentro de `content`)
    degreesLatitude?: number;
    degreesLongitude?: number;
    name?: string;
    address?: string;
    JPEGThumbnail?: string;
    // Campos de resposta de botão/lista (ButtonsResponseMessage)
    selectedButtonID?: string;
    Response?: {
      SelectedDisplayText?: string;
      [k: string]: unknown;
    };
    [k: string]: unknown;
  };
  // Resposta de botão/lista — uazapi expõe o texto selecionado nesses campos
  buttonOrListid?: string;
  vote?: string;
  edited?: string;
  fromMe: boolean;
  groupName?: string;
  id: string;
  isGroup: boolean;
  mediaType?: string;
  messageTimestamp: number;
  messageType: string; // ExtendedTextMessage, Conversation, ImageMessage, AudioMessage, LocationMessage, DocumentMessage
  messageid: string;
  owner: string;
  quoted?: string;
  reaction?: string;
  sender: string;
  senderName?: string;
  sender_lid?: string;
  sender_pn?: string;
  source?: string;
  status?: string;
  text?: string;
  type?: string; // text / image / audio / location / document
  wasSentByApi?: boolean;
  // Campos opcionais para mídia
  mediaUrl?: string;
  mimetype?: string;
  duration?: number;
  // Campos opcionais para localização
  latitude?: number;
  longitude?: number;
  locationName?: string;
  locationAddress?: string;
}

export interface UazapiWebhookChat {
  wa_chatid: string;
  wa_name?: string;
  name?: string;
  phone?: string;
  wa_isGroup?: boolean;
}

export interface UazapiWebhookPayload {
  BaseUrl?: string;
  EventType: string; // "messages", "messages_update", "connection", "wasSentByApi", "call", "contacts", etc.
  chat?: UazapiWebhookChat;
  chatSource?: string;
  instanceName: string;
  message?: UazapiWebhookMessage;
  owner?: string;
  token?: string;
}
