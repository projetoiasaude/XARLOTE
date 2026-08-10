import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildOtpTemplate } from '../apps/api/src/config/template-registry.js';

/**
 * O payload do template de OTP.
 *
 * Por que este arquivo existe: a documentação oficial da Meta exige que, em template
 * de AUTENTICAÇÃO com botão "Copiar código", o código apareça DUAS vezes no payload —
 * no componente `body` E num componente `button` (`sub_type: 'url'`, `index: '0'`).
 * Nossa primeira versão mandava só o corpo, e o envio seria recusado: o paciente
 * nunca receberia o código e o login do app inteiro morreria em silêncio.
 *
 * O outro lado do risco é simétrico: os templates de UTILIDADE (cotação de
 * medicamento, clínica, coringa) NÃO têm botão aprovado. Mandar componente de botão
 * pra eles quebraria a abertura fria de farmácia e clínica — o fluxo que hoje paga a
 * conta. Daí `copyCode` ser exclusivo do OTP.
 */

const ANTES = process.env['ZPRO_TEMPLATE_OTP_CODE'];

beforeEach(() => {
  process.env['ZPRO_TEMPLATE_OTP_CODE'] = 'autenticacao';
});

afterEach(() => {
  if (ANTES === undefined) delete process.env['ZPRO_TEMPLATE_OTP_CODE'];
  else process.env['ZPRO_TEMPLATE_OTP_CODE'] = ANTES;
});

describe('buildOtpTemplate', () => {
  it('devolve o código DUAS vezes: no corpo e no botão', () => {
    const t = buildOtpTemplate('123456')!;
    expect(t.variables).toEqual(['123456']);
    expect(t.copyCode).toBe('123456');
  });

  it('o corpo e o botão carregam o MESMO código', () => {
    // Divergirem seria pior que faltar: o paciente veria um código na mensagem e o
    // botão copiaria outro.
    const t = buildOtpTemplate('987654')!;
    expect(t.copyCode).toBe(t.variables[0]);
  });

  it('usa o nome do template que veio da env (aprovado na Meta)', () => {
    expect(buildOtpTemplate('123456')!.name).toBe('autenticacao');
  });

  it('sem env = template ainda não aprovado → null (o caller responde 503)', () => {
    delete process.env['ZPRO_TEMPLATE_OTP_CODE'];
    expect(buildOtpTemplate('123456')).toBeNull();
  });

  it('env vazia ou só espaços também conta como não aprovado', () => {
    process.env['ZPRO_TEMPLATE_OTP_CODE'] = '   ';
    expect(buildOtpTemplate('123456')).toBeNull();
  });

  it('o texto de fallback espelha o corpo REAL aprovado, com o código dentro', () => {
    // Este texto só é usado quando o template falha E há janela de 24h aberta. Ele
    // precisa ser o que o paciente leria — não uma paráfrase.
    const t = buildOtpTemplate('123456')!;
    expect(t.text).toBe('Seu código de verificação é 123456. Para sua segurança, não o compartilhe.');
  });

  it('idioma é pt_BR (o template foi aprovado em Portuguese (BR))', () => {
    expect(buildOtpTemplate('123456')!.language).toBe('pt_BR');
  });
});
