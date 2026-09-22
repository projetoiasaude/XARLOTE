import { describe, it, expect } from 'vitest';
import {
  classifyApiError,
  classifyTransportError,
  reacaoAFalha,
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

describe('403 é autorização, não autenticação', () => {
  /**
   * O defeito que estes casos fecham (auditoria de 22/09, P0 #1 e #3):
   *
   * 401 e 403 eram o MESMO `kind`. Um cuidador tocava "já tomei" no lembrete da mãe, a
   * chamada ia sem `?subject=`, o servidor respondia 403, o cliente gastava uma rotação
   * de refresh, repetia, tomava 403 de novo e chamava `onSignedOut()`: sessão limpa,
   * cache do prontuário limpo, tela de login — e nenhuma frase explicando. Nenhum token
   * novo resolveria: o problema nunca foi quem ele é.
   */
  it('403 vira `forbidden`, não `unauthenticated`', () => {
    expect(classifyApiError(403, { error: 'forbidden' }).kind).toBe('forbidden');
    expect(classifyApiError(403, null).kind).toBe('forbidden');
  });

  it('`sem_acesso` (o 404 de quem não tem vínculo) também é `forbidden`', () => {
    // A rota não é oráculo de ids: sem vínculo ela responde 404, e o app entende que é
    // falta de acesso — sem deslogar e sem dizer "não encontrei" sobre algo que existe.
    const f = classifyApiError(404, { error: 'sem_acesso' });
    expect(f.kind).toBe('forbidden');
    expect(f.message).toMatch(/acesso/i);
  });

  it('401 continua `unauthenticated`, inclusive o `unauthorized` do contrato', () => {
    expect(classifyApiError(401, { error: 'unauthorized' }).kind).toBe('unauthenticated');
    expect(classifyApiError(401, { error: 'token_expired' }).kind).toBe('unauthenticated');
    expect(classifyApiError(401, null).kind).toBe('unauthenticated');
  });

  it('`forbidden` NÃO é retentável — o React Query não pode insistir nisso', () => {
    // `query.ts` decide por `retryable`: repetir um 403 só gasta a rede do paciente.
    expect(classifyApiError(403, { error: 'forbidden' }).retryable).toBe(false);
    expect(classifyApiError(404, { error: 'sem_acesso' }).retryable).toBe(false);
  });
});

describe('reacaoAFalha — o que o cliente HTTP faz com a falha', () => {
  it('401 na primeira tentativa renova; 401 depois de renovar encerra', () => {
    expect(reacaoAFalha('unauthenticated', 'primeira')).toBe('renovar');
    expect(reacaoAFalha('unauthenticated', 'apos-renovar')).toBe('encerrar');
  });

  it('403 não renova e NÃO desloga, nas duas tentativas', () => {
    // Este é o teste que impede o P0 de voltar: nenhum caminho de um 403 leva a
    // `onSignedOut()`.
    expect(reacaoAFalha('forbidden', 'primeira')).toBe('nada');
    expect(reacaoAFalha('forbidden', 'apos-renovar')).toBe('nada');
  });

  it('nenhum outro kind mexe na sessão', () => {
    const outros = ['network', 'timeout', 'rate_limited', 'not_found', 'unavailable', 'unknown'] as const;
    for (const kind of outros) {
      expect(reacaoAFalha(kind, 'primeira')).toBe('nada');
      expect(reacaoAFalha(kind, 'apos-renovar')).toBe('nada');
    }
  });
});

describe('transporte', () => {
  it('AbortError vira timeout (o app pode dizer "demorou"), o resto vira rede', () => {
    expect(classifyTransportError({ name: 'AbortError' }).kind).toBe('timeout');
    expect(classifyTransportError(new TypeError('Network request failed')).kind).toBe('network');
    expect(classifyTransportError(undefined).kind).toBe('network');
  });
});
