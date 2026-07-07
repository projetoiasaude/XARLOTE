import { describe, it, expect } from 'vitest';
import { extractSharedContacts } from '../packages/whatsapp/src/contacts';

// Estrutura REAL capturada (zpro/WABA, contatos que o Hiago mandou 07/07):
// msg.contacts[] com name{first_name,formatted_name}, phones[{phone,wa_id,type}],
// org? (business), vcard.

describe('extractSharedContacts — vCard do WhatsApp (payload real 07/07)', () => {
  it('extrai nome + telefone de wa_id (fonte mais confiável)', () => {
    const msg = {
      type: 'contacts',
      contacts: [{
        name: { first_name: 'Cris', formatted_name: 'Cris' },
        org: 'Medcore',
        phones: [{ phone: '+55 62 3333-4444', wa_id: '556233334444', type: 'WORK' }],
        vcard: 'BEGIN:VCARD...',
      }],
    };
    const out = extractSharedContacts(msg);
    expect(out).toEqual([{ name: 'Cris', phoneE164: '+556233334444', org: 'Medcore' }]);
  });

  it('DEDUP: mesmo contato mandado 2× (caso "Meu Amor") → 1 só', () => {
    const card = {
      name: { first_name: 'Meu Amor', formatted_name: 'Meu Amor' },
      phones: [{ phone: '+55 62 98888-7777', wa_id: '5562988887777', type: 'CELL' }],
    };
    const out = extractSharedContacts({ type: 'contacts', contacts: [card, card] });
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({ name: 'Meu Amor', phoneE164: '+5562988887777' });
  });

  it('vários contatos DIFERENTES → todos', () => {
    const out = extractSharedContacts({
      contacts: [
        { name: { formatted_name: 'A' }, phones: [{ wa_id: '5562911112222' }] },
        { name: { formatted_name: 'B' }, phones: [{ wa_id: '5562933334444' }] },
      ],
    });
    expect(out.map((c) => c.name)).toEqual(['A', 'B']);
  });

  it('fallback: sem wa_id, usa phone display (toE164BR)', () => {
    const out = extractSharedContacts({
      contacts: [{ name: { formatted_name: 'Zé' }, phones: [{ phone: '(62) 99999-8888' }] }],
    });
    expect(out[0]?.phoneE164).toBe('+5562999998888');
  });

  it('fallback: sem phones, parseia waid/TEL do vcard cru', () => {
    const out = extractSharedContacts({
      contacts: [{
        name: { formatted_name: 'Dra Ana' },
        vcard: 'BEGIN:VCARD\nVERSION:3.0\nFN:Dra Ana\nTEL;type=CELL;waid=5562988776655:+55 62 98877-6655\nEND:VCARD',
      }],
    });
    expect(out[0]?.phoneE164).toBe('+5562988776655');
  });

  it('contato SEM telefone válido → ignorado (não trava)', () => {
    const out = extractSharedContacts({ contacts: [{ name: { formatted_name: 'Sem Fone' } }] });
    expect(out).toEqual([]);
  });

  it('wa_id ESTRANGEIRO (não começa com 55) → rejeitado (não fabrica número BR errado)', () => {
    // contato dos EUA: wa_id "12025550100" NÃO pode virar "+5512025550100"
    const out = extractSharedContacts({ contacts: [{ name: { formatted_name: 'US Contact' }, phones: [{ wa_id: '12025550100' }] }] });
    expect(out).toEqual([]);
  });
  it('phone de exibição com código estrangeiro explícito → rejeitado', () => {
    const out = extractSharedContacts({ contacts: [{ name: { formatted_name: 'Intl' }, phones: [{ phone: '+1 202-555-0100' }] }] });
    expect(out).toEqual([]);
  });
  it('mas BR completo (55...) passa normal', () => {
    const out = extractSharedContacts({ contacts: [{ name: { formatted_name: 'BR' }, phones: [{ wa_id: '5562988887777' }] }] });
    expect(out[0]?.phoneE164).toBe('+5562988887777');
  });

  it('entrada vazia/lixo → []', () => {
    expect(extractSharedContacts(null)).toEqual([]);
    expect(extractSharedContacts({})).toEqual([]);
    expect(extractSharedContacts({ contacts: [] })).toEqual([]);
  });

  it('aceita receber direto a array de contacts', () => {
    const out = extractSharedContacts([{ name: { formatted_name: 'X' }, phones: [{ wa_id: '5562911112222' }] }]);
    expect(out).toHaveLength(1);
  });
});
