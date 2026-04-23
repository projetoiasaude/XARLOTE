// Modo simulador — substitui chamadas uazapi por inserção direta no banco.
// Usado quando WHATSAPP_MODE=simulator (sem uazapi configurado).

import type { SimulateInboundPayload, NormalizedInbound } from '@iasaude/shared';
import { e164ToJid } from './normalize.js';

export function buildSimulatedInbound(payload: SimulateInboundPayload): NormalizedInbound {
  const phoneE164 = payload.phone.startsWith('+') ? payload.phone : `+${payload.phone}`;
  const jid = e164ToJid(phoneE164);

  const base = {
    instance: 'sara',
    externalId: `sim-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    from: { jid, pushName: payload.name ?? 'Usuário Simulado', phoneE164 },
    fromMe: false,
    timestamp: new Date(),
    raw: payload,
  };

  switch (payload.contentType) {
    case 'image':
      return {
        ...base,
        contentType: 'image',
        text: undefined,
        mediaBase64: payload.imageBase64,
        mediaMime: payload.imageMime ?? 'image/jpeg',
      };
    case 'location':
      return {
        ...base,
        contentType: 'location',
        location: {
          lat: payload.locationLat ?? 0,
          lng: payload.locationLng ?? 0,
          name: payload.locationName,
        },
      };
    default:
      return { ...base, contentType: 'text', text: payload.text ?? '' };
  }
}

export function isSimulatorMode(): boolean {
  return (
    process.env['WHATSAPP_MODE'] === 'simulator' ||
    !process.env['UAZAPI_SARA_TOKEN']
  );
}
