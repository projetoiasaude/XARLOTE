import { describe, expect, it } from 'vitest';
import { formatOrderTotal, formatSupplierRelayToUser } from '../packages/shared/src/pharmacy.js';

// Auditoria do 1º pedido bem-sucedido (14/07): correções de apresentação ao cliente.

describe('formatOrderTotal (preço FINAL = remédios + frete) — P6', () => {
  it('frete > 0 → soma e mostra o breakdown (o cliente pagou R$35,89, não R$28,89)', () => {
    expect(formatOrderTotal(28.89, 7)).toBe('R$35.89 (remédios R$28.89 + entrega R$7.00)');
  });
  it('frete 0 → entrega grátis (sem somar)', () => {
    expect(formatOrderTotal(28.89, 0)).toBe('R$28.89 (entrega grátis)');
  });
  it('frete null → "a confirmar" (NUNCA vira grátis — caso Hiago 06/07)', () => {
    expect(formatOrderTotal(28.89, null)).toBe('R$28.89 + frete a confirmar');
  });
  it('sem total → string vazia', () => {
    expect(formatOrderTotal(null, 7)).toBe('');
    expect(formatOrderTotal(undefined, undefined)).toBe('');
  });
});

describe('formatSupplierRelayToUser (repasse contextual) — P3', () => {
  it('NUNCA começa com "Oi!" (conversa em andamento)', () => {
    expect(formatSupplierRelayToUser('Coimbra', 'qualquer coisa').startsWith('Oi!')).toBe(false);
  });
  it('PERGUNTA da farmácia → "perguntou" + pede resposta (não "seguir assim mesmo")', () => {
    const m = formatSupplierRelayToUser('Drogaria Coimbra', 'Dorflex vc queria a cx com 30 envelopes isso?');
    expect(m).toContain('perguntou');
    expect(m).toContain('Drogaria Coimbra');
    expect(m).not.toContain('seguir com ela assim mesmo');
  });
  it('PROPOSTA/condição → "respondeu" + oferece seguir ou ver outra', () => {
    const m = formatSupplierRelayToUser('Coimbra', 'Eu conseguiria te enviar as 15:30 mais ou menos');
    expect(m).toContain('respondeu');
    expect(m.toLowerCase()).toContain('seguir com ela');
  });
  it('resposta com PREÇO → oferece fechar', () => {
    const m = formatSupplierRelayToUser('Coimbra', 'Cefáliv 12 cpr 19.99 / Dorflex 10 cpr 8.90');
    expect(m.toLowerCase()).toContain('feche com ela');
  });
});
