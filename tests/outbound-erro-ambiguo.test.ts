/**
 * A classificação de erro que decide entre PERDER e DUPLICAR (auditoria 22/09, P0-5).
 *
 * `claimSend` segura a trava quando o erro não prova que nada saiu. Isso está certo pro
 * ambíguo — mas uma queda de CONEXÃO (ECONNREFUSED, DNS) é prova: o request nem chegou a
 * ser feito. Ficando de fora, uma piscada de rede de 2s consumia a trava, a retentativa
 * era barrada como "duplicada", o job COMPLETAVA sem carimbo e o lembrete sumia — com o
 * dashboard dizendo "entregue".
 */
import { describe, it, expect } from 'vitest';
import { provesNothingWasSent } from '../apps/api/src/queues/outbound.queue.js';

describe('erros que PROVAM que nada saiu (trava é devolvida, retentativa reenvia)', () => {
  for (const [nome, err] of [
    ['4xx do zpro', new Error('zpro /url HTTP 400: {"success":false,"message":"body is a required field"}')],
    ['401 do zpro', new Error('zpro /text HTTP 401: token inválido')],
    ['4xx do axios (uazapi)', new Error('Request failed with status code 422')],
    ['recusa explícita 200 {success:false}', new Error('zpro /voice success=false ERR_CHANNEL_NOT_SUPPORTED')],
    ['conexão recusada', new Error('connect ECONNREFUSED 10.0.0.3:443')],
    ['DNS não resolveu', new Error('getaddrinfo ENOTFOUND api.zpro.local')],
    ['DNS temporário', new Error('getaddrinfo EAI_AGAIN api.zpro.local')],
    ['rede inalcançável', new Error('connect ENETUNREACH 10.0.0.3:443')],
    ['conexão resetada', new Error('read ECONNRESET')],
  ] as Array<[string, Error]>) {
    it(nome, () => expect(provesNothingWasSent(err)).toBe(true));
  }
});

describe('erros AMBÍGUOS (pode ter entregue — trava fica de pé, resgate é contado)', () => {
  for (const [nome, err] of [
    ['500 do zpro', new Error('zpro /url HTTP 500: internal error')],
    ['502 do gateway', new Error('zpro /url HTTP 502: bad gateway')],
    ['503 em manutenção', new Error('zpro /url HTTP 503: service unavailable')],
    ['timeout da requisição', new Error('timeout of 15000ms exceeded')],
    ['socket caiu depois de enviar', new Error('socket hang up')],
    ['erro sem forma conhecida', new Error('algo inesperado aconteceu')],
  ] as Array<[string, Error]>) {
    it(nome, () => expect(provesNothingWasSent(err)).toBe(false));
  }

  it('string solta e undefined não viram prova', () => {
    expect(provesNothingWasSent('falhou')).toBe(false);
    expect(provesNothingWasSent(undefined)).toBe(false);
  });

  it('4xx ECOADO no corpo de um 500 não vira prova (o código manda, não o texto)', () => {
    // Achado ao escrever este teste: a regex antiga procurava "4xx" em QUALQUER lugar da
    // mensagem, então um 500 cujo corpo ecoa o payload virava "nada saiu" — e a mensagem
    // seria reenviada mesmo podendo ter sido entregue.
    expect(provesNothingWasSent(new Error('zpro /url HTTP 500: {"detail":"status code 400 era esperado"}'))).toBe(false);
    expect(provesNothingWasSent(new Error('zpro /url HTTP 400: {"upstream":"HTTP 500"}'))).toBe(true);
  });
});
