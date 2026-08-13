import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  PIN_MAX_TENTATIVAS,
  SHARE_TTL_MAX_H,
  SHARE_TTL_PADRAO_H,
  avaliarShare,
  expiraEm,
  hashPin,
  hashShareToken,
  idadeEm,
  montarResumo,
  novoShareToken,
  pinConfere,
  pinValido,
  type ShareGrantRow,
} from '../apps/api/src/lib/share-grants.js';

/**
 * O link do médico.
 *
 * Este é o único objeto do sistema que entrega dado clínico **sem autenticação**: quem
 * tem o endereço, vê. Todo teste aqui existe porque a falha correspondente significa
 * prontuário aberto para quem não devia.
 */

const AGORA = Date.parse('2026-08-13T12:00:00.000Z');

function grant(over: Partial<ShareGrantRow> = {}): ShareGrantRow {
  return {
    expires_at: new Date(AGORA + 3_600_000).toISOString(),
    revoked_at: null,
    pin_hash: null,
    pin_salt: null,
    pin_attempts: 0,
    ...over,
  };
}

describe('o token', () => {
  it('tem 256 bits de entropia e sai em base64url', () => {
    const t = novoShareToken(randomBytes);
    // base64url de 32 bytes = 43 caracteres, sem padding e sem `+` ou `/`.
    expect(t).toHaveLength(43);
    expect(t).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('dois tokens nunca colidem', () => {
    const vistos = new Set(Array.from({ length: 500 }, () => novoShareToken(randomBytes)));
    expect(vistos.size).toBe(500);
  });

  it('o banco guarda só o HASH — vazar o banco não entrega links vivos', () => {
    const t = novoShareToken(randomBytes);
    const h = hashShareToken(t);
    expect(h).toHaveLength(64);
    expect(h).not.toContain(t);
    expect(hashShareToken(t)).toBe(h); // determinístico, senão o link nunca abriria
  });
});

describe('a validade', () => {
  it('o padrão são 72 horas', () => {
    expect(expiraEm(undefined, AGORA).getTime()).toBe(AGORA + SHARE_TTL_PADRAO_H * 3_600_000);
  });

  it('nunca passa do teto de 7 dias, mesmo se pedirem um ano', () => {
    // Link de prontuário que não morre sozinho é uma porta que fica aberta pra sempre.
    expect(expiraEm(99_999, AGORA).getTime()).toBe(AGORA + SHARE_TTL_MAX_H * 3_600_000);
  });

  it('não aceita validade zero ou negativa', () => {
    expect(expiraEm(0, AGORA).getTime()).toBe(AGORA + 3_600_000);
    expect(expiraEm(-5, AGORA).getTime()).toBe(AGORA + 3_600_000);
  });
});

describe('o PIN', () => {
  it('exige exatamente 4 dígitos', () => {
    expect(pinValido('1234')).toBe(true);
    expect(pinValido('123')).toBe(false);
    expect(pinValido('12345')).toBe(false);
    expect(pinValido('12a4')).toBe(false);
    expect(pinValido(undefined)).toBe(false);
    expect(pinValido('')).toBe(false);
  });

  it('o sal é POR LINK — sem ele, uma tabela de 10 mil resolve todos de uma vez', () => {
    const a = hashPin('1234', 'sal-a');
    const b = hashPin('1234', 'sal-b');
    expect(a).not.toBe(b);
  });

  it('confere o certo e recusa o errado', () => {
    const salt = 'sal-fixo';
    const h = hashPin('4321', salt);
    expect(pinConfere('4321', salt, h)).toBe(true);
    expect(pinConfere('4320', salt, h)).toBe(false);
  });

  it('hash de tamanho errado não derruba a comparação', () => {
    // `timingSafeEqual` LANÇA quando os buffers têm tamanhos diferentes — um hash
    // truncado no banco viraria erro 500 em vez de "PIN errado".
    expect(pinConfere('1234', 'sal', 'abc')).toBe(false);
  });
});

describe('avaliarShare — quem entra e quem não entra', () => {
  it('link vivo e sem PIN abre', () => {
    expect(avaliarShare(grant(), undefined, AGORA)).toEqual({ kind: 'ok' });
  });

  it('revogado NÃO abre', () => {
    expect(avaliarShare(grant({ revoked_at: new Date(AGORA).toISOString() }), undefined, AGORA).kind)
      .toBe('indisponivel');
  });

  it('expirado NÃO abre', () => {
    const g = grant({ expires_at: new Date(AGORA - 1000).toISOString() });
    expect(avaliarShare(g, undefined, AGORA).kind).toBe('indisponivel');
  });

  it('data de expiração corrompida NÃO abre', () => {
    // Fail-closed: um `expires_at` ilegível não pode virar "sem expiração".
    expect(avaliarShare(grant({ expires_at: 'não é data' }), undefined, AGORA).kind).toBe('indisponivel');
  });

  it('revogado e expirado são INDISTINGUÍVEIS de inexistente', () => {
    // É o ponto: distinguir confirmaria ao atacante que o token existiu, e transformaria
    // a busca por tokens válidos num jogo com feedback.
    const revogado = avaliarShare(grant({ revoked_at: new Date(AGORA).toISOString() }), undefined, AGORA);
    const expirado = avaliarShare(grant({ expires_at: new Date(AGORA - 1).toISOString() }), undefined, AGORA);
    expect(revogado).toEqual(expirado);
  });
});

describe('avaliarShare com PIN', () => {
  const salt = 'sal-do-link';
  const comPin = (over: Partial<ShareGrantRow> = {}) =>
    grant({ pin_hash: hashPin('1234', salt), pin_salt: salt, ...over });

  it('sem PIN fornecido, PEDE o PIN — não nega', () => {
    const v = avaliarShare(comPin(), undefined, AGORA);
    expect(v.kind).toBe('pin_necessario');
    if (v.kind === 'pin_necessario') expect(v.tentativasRestantes).toBe(PIN_MAX_TENTATIVAS);
  });

  it('PIN certo abre', () => {
    expect(avaliarShare(comPin(), '1234', AGORA)).toEqual({ kind: 'ok' });
  });

  it('PIN errado gasta uma tentativa e informa quantas sobram', () => {
    const v = avaliarShare(comPin({ pin_attempts: 1 }), '0000', AGORA);
    expect(v.kind).toBe('pin_necessario');
    // 5 - 1 já gastas - 1 desta = 3
    if (v.kind === 'pin_necessario') expect(v.tentativasRestantes).toBe(3);
  });

  it('a ÚLTIMA tentativa errada trava, e a trava é indistinguível de inexistente', () => {
    const v = avaliarShare(comPin({ pin_attempts: PIN_MAX_TENTATIVAS - 1 }), '0000', AGORA);
    expect(v.kind).toBe('indisponivel');
  });

  it('já travado não aceita nem o PIN CERTO', () => {
    expect(avaliarShare(comPin({ pin_attempts: PIN_MAX_TENTATIVAS }), '1234', AGORA).kind)
      .toBe('indisponivel');
  });

  it('link EXPIRADO nem chega a avaliar o PIN', () => {
    // Ordem importa: se o PIN fosse avaliado antes, um link morto ainda aceitaria
    // tentativas — e cada tentativa é um sinal de que o token existe.
    const g = comPin({ expires_at: new Date(AGORA - 1).toISOString() });
    expect(avaliarShare(g, '1234', AGORA).kind).toBe('indisponivel');
  });

  it('grant com pin_hash mas SEM sal é tratado como sem PIN, não como erro', () => {
    // Estado impossível pelo caminho normal; se acontecer, abrir é melhor que 500 —
    // e o link continua limitado por validade e revogação.
    const g = grant({ pin_hash: 'hash-sem-sal', pin_salt: null });
    expect(avaliarShare(g, undefined, AGORA)).toEqual({ kind: 'ok' });
  });
});

describe('idadeEm', () => {
  it('calcula a idade em anos completos', () => {
    expect(idadeEm('1990-08-13', AGORA)).toBe(36);
  });

  it('data ausente ou inválida vira null, nunca 0', () => {
    // 0 seria lido como "recém-nascido" numa tela clínica.
    expect(idadeEm(null, AGORA)).toBeNull();
    expect(idadeEm('não é data', AGORA)).toBeNull();
    expect(idadeEm('1700-01-01', AGORA)).toBeNull();
  });
});

describe('montarResumo — o que o médico vê', () => {
  const dados = {
    user: {
      preferred_name: 'Fulana',
      full_name: 'Fulana de Teste',
      birth_date: '1990-08-13',
      adherence_score_30d: 0.8,
    },
    alergias: [{ substance: 'Dipirona', reaction: 'urticária', severity: 'grave' }],
    medicamentos: [{ medication_name: 'Losartana', dosage: '50mg', frequency: '1x/dia' }],
    condicoes: [{ name: 'hipertensão', onset_date: '2020-01-01' }],
    exames: Array.from({ length: 20 }, (_, i) => ({ exam_type: `exame ${i}`, exam_date: '2026-08-01' })),
  };

  it('leva o quadro clínico e a idade', () => {
    const r = montarResumo(dados, AGORA);
    expect(r.paciente.idade).toBe(36);
    expect(r.alergias[0]!.substancia).toBe('Dipirona');
    expect(r.medicamentos[0]!.nome).toBe('Losartana');
    expect(r.adesao_30d).toBe(0.8);
  });

  it('NÃO leva telefone, CPF, endereço, conversas nem memória', () => {
    // Esta página pode ser encaminhada adiante. Menos dado exposto, menos dano.
    const texto = JSON.stringify(montarResumo(dados, AGORA));
    for (const proibido of ['phone', 'telefone', 'cpf', 'document', 'endereco', 'address', 'mensage', 'memor']) {
      expect(texto.toLowerCase(), proibido).not.toContain(proibido);
    }
  });

  it('mostra a IDADE e não a data de nascimento', () => {
    expect(JSON.stringify(montarResumo(dados, AGORA))).not.toContain('1990-08-13');
  });

  it('limita os exames a 10 — resumo é resumo', () => {
    expect(montarResumo(dados, AGORA).exames).toHaveLength(10);
  });

  it('paciente sem nada não vira resumo quebrado', () => {
    const vazio = montarResumo(
      { user: {}, alergias: [], medicamentos: [], condicoes: [], exames: [] },
      AGORA,
    );
    expect(vazio.paciente.nome).toBeNull();
    expect(vazio.paciente.idade).toBeNull();
    expect(vazio.alergias).toEqual([]);
    expect(vazio.adesao_30d).toBeNull();
  });
});
