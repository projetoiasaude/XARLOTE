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
  it('mascara par de coordenadas lat,lng — geolocalização (audit 15/07 item 4)', () => {
    expect(maskString('centro: -16.68690,-49.26430, raio 3km')).toContain('[geo]');
    expect(maskString('centro: -16.68690,-49.26430')).not.toContain('16.68690');
    expect(maskString('Cidade "Goiânia" geocodada → -16.6869,-49.2643')).toContain('[geo]'); // toFixed(4)
  });
  it('NÃO confunde preço BR nem decimal comum com coordenada', () => {
    expect(maskString('total R$ 1.234,56 com frete')).toContain('1.234,56'); // vírgula é o decimal, não coord
    expect(maskString('dipirona por R$ 4,27')).toContain('4,27');
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
  it('mascara coordenada dentro da mensagem E redige lat/lng do meta (defesa dupla — item 4)', () => {
    const out = redactPII({ message: 'Buscando farmácias — centro: -16.68690,-49.26430', lat: -16.6869, lng: -49.2643 });
    expect(out.message).not.toContain('16.68690');
    expect(out.message).toContain('[geo]');
    expect(out.lat).toBe('[redacted]');
    expect(out.lng).toBe('[redacted]');
  });
  it('redige campos clínicos de PERFIL (condition/allergy/diagnosis/symptom/substance) — LGPD (B6)', () => {
    const out = redactPII({ condition: 'diabetes tipo 2', allergy: 'dipirona', diagnosis: 'hipertensão', substance: 'penicilina', symptom: 'cefaleia', label: 'perfil' });
    expect(out.condition).toBe('[redacted]');
    expect(out.allergy).toBe('[redacted]');
    expect(out.diagnosis).toBe('[redacted]'); // casa 'diagnos'
    expect(out.substance).toBe('[redacted]');
    expect(out.symptom).toBe('[redacted]');
    expect(out.label).toBe('perfil'); // não-clínico preserva
  });
  it('NÃO redige medication/items — operacional do fluxo de pedido (escolha deliberada)', () => {
    const out = redactPII({ medication: 'dipirona 500mg', items: ['dorflex'] });
    expect(out.medication).toBe('dipirona 500mg'); // 'medication' fora do SENSITIVE_KEY de propósito
    expect((out.items as string[])[0]).toBe('dorflex');
  });
});

/**
 * 🔴 IDENTIFICADOR OPERACIONAL SAI INTACTO (auditoria 05/08).
 *
 * `PHONE_RE` casava 8 dígitos DENTRO de qualquer token, e o primeiro segmento de um uuid tem
 * 8 caracteres hex — que em ~2% dos casos saem todos numéricos. Linha REAL de produção:
 *
 *   "traceId": "[phone]-79fd-4e65-877f-d17ae23628e4"
 *
 * O traceId era destruído e com ele a capacidade de seguir um turno pelos logs. Foi
 * exatamente o que travou a investigação da conversa da Ludmila: os logs do turno dela
 * apareciam como `tr=[phone]-` e não davam pra correlacionar com nada.
 *
 * Um redator que corrompe id operacional não protege o paciente — cega a operação. E a
 * defesa é ESTRUTURAL (a forma do uuid/hex-token), não uma lista de nomes de chave: cobre
 * qualquer identificador que apareça no futuro sem ninguém ter que lembrar de cadastrá-lo.
 */
describe('maskString — identificador operacional sobrevive', () => {
  it('🔴 o traceId REAL do turno da Ludmila sai inteiro', () => {
    const trace = '37188565-79fd-4e65-877f-d17ae23628e4';
    expect(maskString(`traceId=${trace} instance=sara`)).toContain(trace);
  });

  it('uuid com PRIMEIRO segmento todo numérico (o caso que quebrava) sobrevive', () => {
    for (const u of [
      '12345678-1234-4321-8888-123456789012',
      '00000000-0000-4000-8000-000000000000',
      '99999999-1111-4111-9111-999999999999',
    ]) {
      expect(maskString(`id=${u}`)).toContain(u);
    }
  });

  it('uuid dentro de JSON de metadata sobrevive', () => {
    const j = '{"traceId":"37188565-79fd-4e65-877f-d17ae23628e4","orderId":"ec1f69c8-4b08-4e06-9468-1ba1bbbbf732"}';
    expect(maskString(j)).toBe(j);
  });

  it('wa_key hexadecimal (12+ chars) sobrevive', () => {
    for (const k of ['40296c739c7c', '1234567890ab', '915235a3e71b', '11914dccdd9442ca']) {
      expect(maskString(`wa_key=${k}`)).toContain(k);
    }
  });

  it('vários ids na MESMA string voltam todos, na ordem certa', () => {
    const a = '37188565-79fd-4e65-877f-d17ae23628e4';
    const b = 'ec1f69c8-4b08-4e06-9468-1ba1bbbbf732';
    const k = '40296c739c7c';
    const out = maskString(`tr=${a} order=${b} key=${k}`);
    expect(out).toBe(`tr=${a} order=${b} key=${k}`);
  });

  it('🔴 e a PII no MESMO texto continua sendo mascarada', () => {
    const trace = '37188565-79fd-4e65-877f-d17ae23628e4';
    const out = maskString(`traceId=${trace} paciente +55 62 98345-0244 cpf 123.456.789-09`);
    expect(out).toContain(trace);          // id preservado
    expect(out).not.toContain('98345');    // telefone mascarado
    expect(out).not.toContain('123.456.789-09');
  });
});

describe('maskString — a PII continua sendo mascarada (nenhuma regressão)', () => {
  it.each([
    ['+5562983450244', '5562983450244'],
    ['62983450244', '62983450244'],
    ['(62) 98345-0244', '98345'],
    ['98345-0244', '98345'],
    ['551188887777', '551188887777'],
    ['+55 62 99159-2150', '99159'],
  ])('"%s" é mascarado', (entrada, cru) => {
    expect(maskString(`contato ${entrada} fim`)).not.toContain(cru);
  });

  it('telefone GRUDADO num token não é mascarado — e isso é o certo', () => {
    // Não é telefone: é id. Mascarar aqui foi o bug. PII de verdade vem separada por
    // espaço/pontuação em texto livre, nunca colada em hex.
    expect(maskString('key=abc62983450244def')).toContain('abc62983450244def');
  });

  it('sentinela não vaza no resultado, nem com NUL na entrada', () => {
    const NUL = String.fromCharCode(0);
    const out = maskString(`x${NUL}0${NUL}y 37188565-79fd-4e65-877f-d17ae23628e4`);
    expect(out).toContain('37188565-79fd-4e65-877f-d17ae23628e4');
  });

  it('redactPII preserva traceId dentro de objeto e ainda redige chave sensível', () => {
    const out = redactPII({
      traceId: '37188565-79fd-4e65-877f-d17ae23628e4',
      phone_e164: '+5562983450244',
      message: 'liga pra +55 62 98345-0244',
    }) as Record<string, string>;
    expect(out.traceId).toBe('37188565-79fd-4e65-877f-d17ae23628e4');
    expect(out.phone_e164).toBe('[redacted]');
    expect(out.message).not.toContain('98345');
  });
});
