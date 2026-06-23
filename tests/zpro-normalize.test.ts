import { describe, it, expect } from 'vitest';
import { normalizeZproWebhook, zproEventId } from '../packages/whatsapp/src/zpro-normalize.js';

// ⚠️ O payload de entrada do zpro NÃO é documentado. Estes testes travam a
// TOLERÂNCIA do normalizador (vários shapes plausíveis: WABA-flat, Baileys-
// upsert, button reply, áudio) — não o contrato real, que será apertado assim
// que capturarmos um payload de produção.

describe('normalizeZproWebhook — tolerância de shapes', () => {
  it('extrai texto de um payload WABA-flat', () => {
    const n = normalizeZproWebhook(
      { fromMe: false, type: 'text', body: 'oi', number: '5562998345024', pushName: 'Hiago', id: 'wamid.A', ticketId: 42 },
      'sara',
    );
    expect(n).not.toBeNull();
    expect(n!.contentType).toBe('text');
    expect(n!.text).toBe('oi');
    expect(n!.from.phoneE164).toBe('+5562998345024');
    expect(n!.from.pushName).toBe('Hiago');
    expect(n!.providerTicketId).toBe(42);
    expect(n!.externalId).toBe('wamid.A');
  });

  it('extrai texto de um payload estilo Baileys-upsert (data.key/message)', () => {
    const n = normalizeZproWebhook(
      {
        data: {
          key: { remoteJid: '5562998345024@s.whatsapp.net', fromMe: false, id: '3A6A22' },
          message: { conversation: 'bom dia' },
          pushName: 'Hiago',
        },
      },
      'sara',
    );
    expect(n).not.toBeNull();
    expect(n!.contentType).toBe('text');
    expect(n!.text).toBe('bom dia');
    expect(n!.from.phoneE164).toBe('+5562998345024');
    expect(n!.fromMe).toBe(false);
  });

  it('trata resposta de botão como texto (o título escolhido)', () => {
    const n = normalizeZproWebhook(
      { fromMe: false, type: 'button', body: 'Aceitar', number: '5562998345024', ticketId: 7, selectedButtonId: 'accept' },
      'sara',
    );
    expect(n).not.toBeNull();
    expect(n!.contentType).toBe('text');
    expect(n!.text).toBe('Aceitar');
    expect(n!.providerTicketId).toBe(7);
  });

  it('reconhece áudio com mediaUrl + duração', () => {
    const n = normalizeZproWebhook(
      { fromMe: false, type: 'audio', number: '5562998345024', mediaUrl: 'https://backhub.criate.online/media/x.ogg', mimetype: 'audio/ogg', duration: 5, id: 'wamid.B' },
      'sara',
    );
    expect(n).not.toBeNull();
    expect(n!.contentType).toBe('audio');
    expect(n!.mediaUrl).toBe('https://backhub.criate.online/media/x.ogg');
    expect(n!.mediaDurationMs).toBe(5000);
  });

  it('ignora echo (fromMe) e grupos', () => {
    expect(normalizeZproWebhook({ fromMe: true, type: 'text', body: 'eco', number: '5562998345024' }, 'sara')).toBeNull();
    expect(normalizeZproWebhook({ fromMe: false, isGroup: true, body: 'x', number: '5562998345024' }, 'sara')).toBeNull();
    expect(normalizeZproWebhook({ fromMe: false, body: 'x', number: '120363@g.us' }, 'sara')).toBeNull();
  });

  it('ignora payload sem remetente (status/ack) sem quebrar', () => {
    expect(normalizeZproWebhook({ ack: 3, status: 'read' }, 'sara')).toBeNull();
    expect(normalizeZproWebhook(null, 'sara')).toBeNull();
    expect(normalizeZproWebhook('texto solto', 'sara')).toBeNull();
  });

  it('zproEventId acha um id pra idempotência/captura', () => {
    expect(zproEventId({ id: 'wamid.C' })).toBe('wamid.C');
    expect(zproEventId({ data: { key: { id: '3A99' } } })).toBe('3A99');
  });
});

// Shape REAL capturado de backhub.criate.online (WABA) — msg/ticket aninhados.
describe('normalizeZproWebhook — shape real (WABA backhub)', () => {
  const realText = {
    msg: { id: 'wamid.HBgMNTU2Mjkx', from: '556291592150', text: { body: 'Oi' }, type: 'text', timestamp: '1750000000' },
    method: 'message',
    ticket: {
      id: 173743,
      status: 'pending',
      channel: 'waba',
      isGroup: false,
      contact: { id: 191912, name: 'Hiago', number: '556291592150', pushname: 'Hiago' },
    },
  };

  it('extrai texto, número, pushName, ticketId e wamid do payload real', () => {
    const n = normalizeZproWebhook(realText, 'sara');
    expect(n).not.toBeNull();
    expect(n!.contentType).toBe('text');
    expect(n!.text).toBe('Oi');
    expect(n!.from.phoneE164).toBe('+556291592150');
    expect(n!.from.pushName).toBe('Hiago');
    expect(n!.providerTicketId).toBe(173743);
    expect(n!.externalId).toBe('wamid.HBgMNTU2Mjkx');
    expect(n!.fromMe).toBe(false);
  });

  it('ignora eventos que não são mensagem recebida (status/ack)', () => {
    expect(normalizeZproWebhook({ method: 'messageAck', msg: { id: 'wamid.Z', from: '556291592150' } }, 'sara')).toBeNull();
    expect(normalizeZproWebhook({ method: 'messageStatus', ticket: { id: 1, contact: { number: '556291592150' } } }, 'sara')).toBeNull();
  });

  it('resposta de botão WABA (interactive.button_reply) vira texto com o título', () => {
    const btn = {
      method: 'message',
      msg: { id: 'wamid.B2', from: '556291592150', type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: 'accept', title: 'Aceitar' } } },
      ticket: { id: 173743, contact: { number: '556291592150', name: 'Hiago' } },
    };
    const n = normalizeZproWebhook(btn, 'sara');
    expect(n).not.toBeNull();
    expect(n!.contentType).toBe('text');
    expect(n!.text).toBe('Aceitar');
    expect(n!.providerTicketId).toBe(173743);
  });
});
