import { describe, it, expect } from 'vitest';
import {
  classifyApiError,
  classifyTransportError,
} from '../apps/mobile/src/lib/api/errors.js';

/**
 * A tradução de falha da API em decisão do app.
 *
 * O contrato que estes testes protegem:
 *   • a mensagem do SERVIDOR vence a genérica (ela sabe coisas que o app não sabe);
 *   • `kind` decide fluxo, texto nunca;
 *   • 5xx é retentável, 4xx de regra de negócio não é — insistir num código errado
 *     só queima as 3 tentativas do paciente.
 */

describe('a mensagem do servidor tem precedência', () => {
  it('usa o texto da API quando ele vem — é ele que sabe do template pendente', () => {
    // Caso real: janela de 24h fechada e template `otp_code` ainda não aprovado na
    // Meta. Só o servidor sabe disso, e a orientação dele é a única saída útil.
    const f = classifyApiError(503, {
      error: 'otp_unavailable',
      message: 'Manda um "oi" pra Xarlote no WhatsApp e tenta entrar de novo em seguida 💙',
    });
    expect(f.kind).toBe('unavailable');
    expect(f.message).toContain('Manda um "oi"');
  });

  it('cai no texto local quando a API só manda o código', () => {
    const f = classifyApiError(503, { error: 'otp_unavailable' });
    expect(f.kind).toBe('unavailable');
    expect(f.message).toMatch(/indisponível/i);
  });

  it('ignora message vazia ou só com espaços', () => {
    const f = classifyApiError(429, { error: 'rate_limited', message: '   ' });
    expect(f.message).toMatch(/tentativas/i);
  });
});

describe('mapeamento de código → kind', () => {
  const casos: [string, number, string][] = [
    ['invalid_code', 400, 'invalid_code'],
    ['code_expired', 410, 'code_expired'],
    ['too_many_attempts', 429, 'too_many_attempts'],
    ['rate_limited', 429, 'rate_limited'],
    ['token_expired', 401, 'unauthenticated'],
    ['invalid_refresh', 401, 'unauthenticated'],
    ['session_revoked', 401, 'unauthenticated'],
    ['consent_required', 428, 'consent_required'],
  ];

  for (const [code, status, esperado] of casos) {
    it(`${code} → ${esperado}`, () => {
      expect(classifyApiError(status, { error: code }).kind).toBe(esperado);
    });
  }

  it('código desconhecido não vira unknown se o status já diz o bastante', () => {
    // O backend pode ganhar um código novo amanhã. O status HTTP é o piso.
    expect(classifyApiError(401, { error: 'algo_novo_qualquer' }).kind).toBe('unauthenticated');
    expect(classifyApiError(429, { error: 'algo_novo_qualquer' }).kind).toBe('rate_limited');
    expect(classifyApiError(503, { error: 'algo_novo_qualquer' }).kind).toBe('unavailable');
  });
});

describe('sem corpo utilizável', () => {
  it('body null, string ou array não quebram a classificação', () => {
    expect(classifyApiError(500, null).kind).toBe('unavailable');
    expect(classifyApiError(404, 'texto solto').kind).toBe('not_found');
    expect(classifyApiError(400, []).kind).toBe('unknown');
  });
});

describe('o que vale retentar', () => {
  it('rede, timeout e 5xx são retentáveis', () => {
    expect(classifyTransportError(new Error('offline')).retryable).toBe(true);
    expect(classifyTransportError({ name: 'AbortError' }).retryable).toBe(true);
    expect(classifyApiError(502, null).retryable).toBe(true);
  });

  it('código errado e limite estourado NÃO são — repetir só queima tentativa', () => {
    expect(classifyApiError(400, { error: 'invalid_code' }).retryable).toBe(false);
    expect(classifyApiError(429, { error: 'rate_limited' }).retryable).toBe(false);
    expect(classifyApiError(401, { error: 'token_expired' }).retryable).toBe(false);
  });
});

describe('transporte', () => {
  it('AbortError vira timeout (o app pode dizer "demorou"), o resto vira rede', () => {
    expect(classifyTransportError({ name: 'AbortError' }).kind).toBe('timeout');
    expect(classifyTransportError(new TypeError('Network request failed')).kind).toBe('network');
    expect(classifyTransportError(undefined).kind).toBe('network');
  });
});
