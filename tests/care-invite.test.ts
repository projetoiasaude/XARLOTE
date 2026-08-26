/**
 * O código de 6 dígitos que abre um vínculo de cuidado.
 *
 * Quem gera é QUEM VAI SER CUIDADO, e entrega a quem vai cuidar. A direção é a proteção:
 * não existe convite não-solicitado, então não existe vetor de assédio nem de dígito
 * errado mandando um pedido de acesso pra um estranho.
 */
import { describe, it, expect } from 'vitest';
import {
  generateCareCode, hashCareCode, normalizarCodigo, evaluateCareInvite, explicarVerdict,
  CARE_INVITE_TTL_MS, CARE_INVITE_MAX_ATTEMPTS, CARE_INVITE_LENGTH,
  type CareInviteRow,
} from '../apps/api/src/lib/care-invite.js';

const PEPPER = 'pimenta-de-teste';
const AGORA = Date.parse('2026-08-25T12:00:00Z');
const MAE = 'u-mae';
const FILHO = 'u-filho';

function convite(over: Partial<CareInviteRow> = {}, code = '123456'): CareInviteRow {
  return {
    user_id: MAE,
    salt: 'sal',
    code_hash: hashCareCode(code, 'sal', PEPPER),
    attempts: 1,
    max_attempts: CARE_INVITE_MAX_ATTEMPTS,
    expires_at: new Date(AGORA + CARE_INVITE_TTL_MS).toISOString(),
    consumed_at: null,
    ...over,
  };
}

const resgate = (code: string, quem = FILHO) => ({ code, pepper: PEPPER, nowMs: AGORA, resgatadorUserId: quem });

describe('geração e forma', () => {
  it('sempre 6 dígitos, inclusive quando o sorteio dá número pequeno', () => {
    expect(generateCareCode(() => 42)).toBe('000042');
    expect(generateCareCode(() => 999_999)).toBe('999999');
    expect(generateCareCode(() => 0)).toHaveLength(CARE_INVITE_LENGTH);
  });

  it('o mesmo código com sais diferentes dá hashes diferentes', () => {
    expect(hashCareCode('123456', 'a', PEPPER)).not.toBe(hashCareCode('123456', 'b', PEPPER));
  });

  it('o pepper importa: dump do banco sozinho não forja código', () => {
    expect(hashCareCode('123456', 'a', PEPPER)).not.toBe(hashCareCode('123456', 'a', 'outra'));
  });

  it('aceita como a pessoa dita: com espaço, hífen, pontos', () => {
    expect(normalizarCodigo('123 456')).toBe('123456');
    expect(normalizarCodigo('123-456')).toBe('123456');
    expect(normalizarCodigo(' 1 2 3 4 5 6 ')).toBe('123456');
  });

  it('recusa o que não tem 6 dígitos', () => {
    expect(normalizarCodigo('12345')).toBeNull();
    expect(normalizarCodigo('1234567')).toBeNull();
    expect(normalizarCodigo('abcdef')).toBeNull();
    expect(normalizarCodigo(null)).toBeNull();
  });
});

describe('resgate', () => {
  it('código certo abre', () => {
    expect(evaluateCareInvite(convite(), resgate('123456'))).toBe('ok');
  });

  it('código errado não abre', () => {
    expect(evaluateCareInvite(convite(), resgate('654321'))).toBe('mismatch');
  });

  it('vencido nunca diz "errado" — não dá sinal sobre alvo morto', () => {
    const velho = convite({ expires_at: new Date(AGORA - 1000).toISOString() });
    expect(evaluateCareInvite(velho, resgate('123456'))).toBe('expired');
    // Nem mesmo com o código ERRADO ele revela que o código estava errado.
    expect(evaluateCareInvite(velho, resgate('000000'))).toBe('expired');
  });

  it('já usado não abre de novo', () => {
    const usado = convite({ consumed_at: new Date(AGORA - 60_000).toISOString() });
    expect(evaluateCareInvite(usado, resgate('123456'))).toBe('consumed');
  });

  it('tentativas esgotadas travam', () => {
    const travado = convite({ attempts: CARE_INVITE_MAX_ATTEMPTS + 1 });
    expect(evaluateCareInvite(travado, resgate('123456'))).toBe('exhausted');
  });

  it('a última tentativa ainda vale (o incremento é ANTES da avaliação)', () => {
    const ultima = convite({ attempts: CARE_INVITE_MAX_ATTEMPTS });
    expect(evaluateCareInvite(ultima, resgate('123456'))).toBe('ok');
  });

  it('🔴 resgatar o PRÓPRIO código é confusão de fluxo, não erro de digitação', () => {
    // A senhora gera o código e digita ela mesma. Dizer "código errado" a mandaria pedir
    // outro e repetir o engano pra sempre.
    expect(evaluateCareInvite(convite(), resgate('123456', MAE))).toBe('proprio');
  });

  it('e o próprio código é barrado ANTES de comparar o hash', () => {
    // Se a ordem estivesse invertida, quem digitasse o próprio código errado ouviria
    // "código errado" e nunca entenderia o que fez.
    expect(evaluateCareInvite(convite(), resgate('999999', MAE))).toBe('proprio');
  });
});

describe('o que a pessoa ouve', () => {
  it.each(['consumed', 'expired', 'exhausted', 'mismatch'] as const)(
    'os quatro desfechos ruins dão a MESMA resposta (%s) — a rota não é oráculo de códigos',
    (v) => {
      expect(explicarVerdict(v)).toBe(explicarVerdict('mismatch'));
    },
  );

  it('o próprio código ganha explicação de verdade', () => {
    const txt = explicarVerdict('proprio');
    expect(txt).not.toBe(explicarVerdict('mismatch'));
    expect(txt).toContain('seu');
  });
});
