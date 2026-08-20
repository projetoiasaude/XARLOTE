import { describe, it, expect } from 'vitest';
import {
  MAX_BYTES_ARQUIVO,
  MSG_MUITO_GRANDE,
  envelopeDoFastify,
  falhaDoUpload,
} from '../apps/mobile/src/features/media/erro-upload.js';
import { MAX_BYTES, mensagemDeRecusa } from '../apps/api/src/lib/media-sniff.js';

/**
 * O que a paciente LÊ quando o arquivo não sobe.
 *
 * O caso que motiva o arquivo inteiro: o `bodyLimit` da rota `POST /app/media` é do
 * Fastify, e o 413 dele é respondido ANTES do handler — com `{statusCode:413, error:
 * 'Payload Too Large', message:'Request body is too large'}`. Como `classifyApiError`
 * prefere a `message` do servidor, esse texto ia direto pra barra de erro do chat: uma
 * senhora de 55 anos lendo "Request body is too large" sobre o exame que ela acabou de
 * mandar, enquanto a frase em PT-BR que o handler prepararia nunca chegava a rodar.
 */

/** O corpo exato que o Fastify devolve quando o corpo estoura o `bodyLimit` da rota. */
const ENVELOPE_413 = {
  statusCode: 413,
  code: 'FST_ERR_CTP_BODY_TOO_LARGE',
  error: 'Payload Too Large',
  message: 'Request body is too large',
};

describe('o teto do app é o teto do servidor', () => {
  it('MAX_BYTES_ARQUIVO e MSG_MUITO_GRANDE não podem divergir da API', () => {
    // Vigilante da invariante: os dois valores são cópias declaradas, e cópia declarada
    // envelhece em silêncio. Se alguém mudar o limite ou a frase de um lado só, isto
    // quebra alto — que é o único jeito de a cópia continuar sendo verdade.
    expect(MAX_BYTES_ARQUIVO).toBe(MAX_BYTES);
    expect(MSG_MUITO_GRANDE).toBe(mensagemDeRecusa('muito_grande'));
  });
});

describe('envelopeDoFastify', () => {
  it('reconhece o envelope automático pelo statusCode e pelo rótulo em inglês', () => {
    expect(envelopeDoFastify(ENVELOPE_413)).toBe(true);
    expect(envelopeDoFastify({ error: 'Bad Request', message: 'body must be object' })).toBe(true);
  });

  it('NÃO descarta corpo nosso — o `error` da casa é slug minúsculo', () => {
    expect(envelopeDoFastify({ error: 'muito_grande', message: 'qualquer coisa' })).toBe(false);
    expect(envelopeDoFastify({ error: 'formato_nao_suportado' })).toBe(false);
    expect(envelopeDoFastify({ error: 'arquivo_ausente' })).toBe(false);
    // Sem evidência positiva, o corpo é tratado como nosso: o erro caro é jogar fora uma
    // orientação que a casa escreveu, não manter uma que o Fastify escreveu.
    expect(envelopeDoFastify(null)).toBe(false);
    expect(envelopeDoFastify(undefined)).toBe(false);
    expect(envelopeDoFastify({ message: 'só a mensagem' })).toBe(false);
  });
});

describe('falhaDoUpload', () => {
  it('413 do bodyLimit vira a frase em PT-BR, nunca "Request body is too large"', () => {
    const f = falhaDoUpload(413, ENVELOPE_413);

    expect(f.message).toBe(MSG_MUITO_GRANDE);
    expect(f.message).not.toContain('Request body');
    // Tentar de novo com o MESMO arquivo dá o mesmo 413 — prometer repetição seria mentira.
    expect(f.retryable).toBe(false);
  });

  it('413 escrito pelo handler mantém a mensagem do servidor', () => {
    // Este é o caminho bom: o handler rodou, viu `muito_grande` e escreveu em PT-BR. O
    // conserto do 413 do Fastify não pode ter custado ESTA mensagem.
    const nosso = { error: 'muito_grande', message: mensagemDeRecusa('muito_grande') };
    expect(falhaDoUpload(413, nosso).message).toBe(mensagemDeRecusa('muito_grande'));
  });

  it('415 de formato não suportado chega inteiro à tela', () => {
    const nosso = {
      error: 'formato_nao_suportado',
      message: mensagemDeRecusa('formato_nao_suportado'),
    };
    const f = falhaDoUpload(415, nosso);
    expect(f.message).toBe(mensagemDeRecusa('formato_nao_suportado'));
    expect(f.message).toMatch(/PDF/);
  });

  it('outro envelope do Fastify não vaza inglês — cai na frase da casa', () => {
    const f = falhaDoUpload(400, {
      statusCode: 400,
      error: 'Bad Request',
      message: 'Unexpected token in JSON',
    });
    expect(f.message).not.toContain('Unexpected token');
    expect(f.message).toBe('Algo saiu do esperado. Tenta de novo?');
  });

  it('sem corpo nenhum continua respondendo em PT-BR pelo status', () => {
    expect(falhaDoUpload(500, null).kind).toBe('unavailable');
    expect(falhaDoUpload(401, null).kind).toBe('unauthenticated');
  });

  it('nenhuma saída deixa passar texto em inglês do servidor', () => {
    // A garantia é sobre o EFEITO, não sobre o rótulo: qualquer combinação de envelope
    // automático precisa terminar numa frase escrita aqui.
    const nossas = new Set([
      MSG_MUITO_GRANDE,
      'Algo saiu do esperado. Tenta de novo?',
      'Estou meio indisponível agora. Tenta de novo em instantes.',
      'Sua sessão expirou. Entra de novo, é rapidinho.',
      'Não encontrei isso.',
    ]);
    for (const status of [400, 401, 404, 413, 415, 500, 502]) {
      const f = falhaDoUpload(status, {
        statusCode: status,
        error: 'Payload Too Large',
        message: 'Request body is too large',
      });
      expect(nossas.has(f.message)).toBe(true);
    }
  });
});
