import { describe, it, expect } from 'vitest';
import { brPhoneVariants, whatsappJidVariants } from '../packages/shared/src/phone.js';

describe('brPhoneVariants (9º dígito BR)', () => {
  it('com o 9 → gera também a versão sem o 9', () => {
    const v = brPhoneVariants('+5562991592150'); // 13 dígitos, com 9
    expect(v).toContain('+5562991592150');
    expect(v).toContain('+556291592150'); // sem o 9
  });
  it('sem o 9 → gera também a versão com o 9', () => {
    const v = brPhoneVariants('+556291592150'); // 12 dígitos, sem 9
    expect(v).toContain('+556291592150');
    expect(v).toContain('+5562991592150'); // com o 9
  });
  it('número não-BR fica intacto (sem variante)', () => {
    expect(brPhoneVariants('+14155551234')).toEqual(['+14155551234']);
  });
});

describe('whatsappJidVariants — casa os dois lados do teste real', () => {
  it('reply sem-9 casa o jid do supplier com-9 (o bug que travou a negociação)', () => {
    // supplier semeado com 13 dígitos; resposta chega com 12 → tem que bater
    const jidsDaResposta = whatsappJidVariants('+556291592150');
    expect(jidsDaResposta).toContain('5562991592150@s.whatsapp.net'); // = jid do supplier
    expect(jidsDaResposta).toContain('556291592150@s.whatsapp.net');
  });
  it('aceita jid cru na entrada', () => {
    const v = whatsappJidVariants('5562991592150@s.whatsapp.net');
    expect(v).toContain('556291592150@s.whatsapp.net');
  });
});
