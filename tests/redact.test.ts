import { describe, it, expect } from 'vitest';
import { maskString, redactPII } from '../packages/db/src/redact';

// Propriedade que importa pra LGPD: a PII some do texto. O RÓTULO ([phone] vs
// [cpf]) pode variar — um telefone de 11 dígitos colado casa o regex de CPF
// primeiro. O que NÃO pode acontecer é o dado cru sobreviver.

describe('maskString — mascara PII em texto livre (F0.5/LGPD)', () => {
  it('mascara telefone E.164 com separadores', () => {
    const out = maskString('liga pra +55 62 98345-0244 agora');
    expect(out).not.toContain('98345');
    expect(out).toMatch(/\[(phone|cpf)\]/);
  });
  it('mascara número de 11 dígitos colado', () => {
    expect(maskString('meu numero 62983450244')).not.toContain('62983450244');
  });
  it('mascara CPF', () => {
    const out = maskString('cpf 123.456.789-09');
    expect(out).not.toContain('123.456.789-09');
    expect(out).toContain('[cpf]');
  });
  it('mascara e-mail', () => {
    expect(maskString('manda pro joao@exemplo.com')).toContain('[email]');
  });
  it('preserva texto clínico sem PII', () => {
    expect(maskString('quero comprar dipirona 500mg')).toBe('quero comprar dipirona 500mg');
  });
});

describe('redactPII — redige por chave sensível, preserva operacional', () => {
  it('redige valores de chaves sensíveis', () => {
    const out = redactPII({ phone: '+5562983450244', cpf: '12345678909', lat: -16.6, lng: -49.2 });
    expect(out.phone).toBe('[redacted]');
    expect(out.cpf).toBe('[redacted]');
    expect(out.lat).toBe('[redacted]');
    expect(out.lng).toBe('[redacted]');
  });
  it('redige detalhes de endereço (complement/quadra/lote/bairro) — save_address LGPD', () => {
    const out = redactPII({ label: 'casa', complement: 'Qd 19 Lt 28', bairro: 'Recanto das Emas', full_address: 'Rua Ema 5' });
    expect(out.complement).toBe('[redacted]');
    expect(out.bairro).toBe('[redacted]');
    expect(out.full_address).toBe('[redacted]');
    expect(out.label).toBe('casa'); // o RÓTULO não é PII — preserva
  });
  it('preserva chaves operacionais (debug não quebra)', () => {
    const out = redactPII({ trace_id: 'abc', conversation_id: 'c1', category: 'webhook', count: 3 });
    expect(out).toEqual({ trace_id: 'abc', conversation_id: 'c1', category: 'webhook', count: 3 });
  });
  it('redige recursivamente e mascara strings livres aninhadas', () => {
    const out = redactPII({
      user: { telefone: '62983450244', preferred_name: 'Hiago' },
      message: 'liga no 62983450244',
    });
    expect((out.user as Record<string, unknown>).telefone).toBe('[redacted]');
    expect((out.user as Record<string, unknown>).preferred_name).toBe('[redacted]');
    expect(out.message).not.toContain('62983450244');
  });
  it('mascara CPF dentro de string de mensagem', () => {
    const out = redactPII({ message: 'cpf do paciente: 123.456.789-09' });
    expect(out.message).toContain('[cpf]');
  });
});
