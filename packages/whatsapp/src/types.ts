export interface UazapiSendTextPayload {
  number: string;
  text: string;
  quotedMsgId?: string;
}

export interface UazapiSendImagePayload {
  number: string;
  image: string; // url or base64
  caption?: string;
}

export interface UazapiSendLocationPayload {
  number: string;
  lat: number;
  lng: number;
  name?: string;
}

export interface UazapiWebhookPayload {
  event: string;
  instance: string;
  data: {
    key: { remoteJid: string; fromMe: boolean; id: string };
    pushName?: string;
    message?: {
      conversation?: string;
      extendedTextMessage?: { text: string };
      imageMessage?: { caption?: string; mimetype: string; url?: string };
      audioMessage?: { mimetype: string; url?: string; seconds?: number; ptt?: boolean };
      videoMessage?: { caption?: string; mimetype: string; url?: string };
      documentMessage?: { title?: string; mimetype: string; url?: string };
      locationMessage?: { degreesLatitude: number; degreesLongitude: number; name?: string; address?: string };
    };
    messageType?: string;
    messageTimestamp?: number;
  };
}
