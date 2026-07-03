import { describe, it, expect } from 'vitest';
import { brPhoneVariants, whatsappJidVariants, isPlaceholderPhone } from '../packages/shared/src/phone.js';

// Blinda a TRAVA do incidente 2026-07-01: números sintéticos (+555500000<id>) gerados
// quando o fornecedor não tinha telefone real NÃO podem ir pro envio. Números BR reais passam.
describe('isPlaceholderPhone (trava anti-número-fake)', () => {
  it('barra os números sintéticos exatos do incidente', () => {
    for (const fake of ['5555000006001', '5555000083', '555500000536', '555500000489', '55550000040', '+555500000abcd']) {
      expect(isPlaceholderPhone(fake)).toBe(true);
    }
  });
  it('barra vazio/nulo/curto', () => {
    expect(isPlaceholderPhone(null)).toBe(true);
    expect(isPlaceholderPhone('')).toBe(true);
    expect(isPlaceholderPhone('+5562999')).toBe(true);
  });
  it('DEIXA passar número BR real (com e sem o 9)', () => {
    expect(isPlaceholderPhone('+5562991592150')).toBe(false); // 13 díg
    expect(isPlaceholderPhone('+556291592150')).toBe(false);  // 12 díg
    expect(isPlaceholderPhone('+556232223344')).toBe(false);  // fixo 12 díg
  });
  it('barra os números DEMO do simulador (caso Marina: envio real diário pra teste)', () => {
    for (const demo of ['+5511999990001', '+5511999990002', '+5511999990003', '5511999990001']) {
      expect(isPlaceholderPhone(demo)).toBe(true);
    }
    // vizinho REAL fora da faixa demo passa
    expect(isPlaceholderPhone('+5511999991001')).toBe(false);
  });
});

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
