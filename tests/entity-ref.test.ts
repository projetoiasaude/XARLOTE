import { describe, it, expect } from 'vitest';
import { isUuid, resolveEntityRef, loneNumberRef, type EntityCandidate } from '../packages/shared/src/entity-ref.js';

// Blinda a decisão que substitui "confiar no id que o LLM mandou".
// Incidentes reais de 30/07 que estão codificados aqui como teste:
//   - cancel_consultation({consultation_id:'act…'})            → placeholder inventado
//   - confirm_consultation({consultation_id:'Nilo Machado Junior'}) → NOME no lugar do uuid
//   - save_exam_result({message_id:'message_id'})              → nome do campo como valor
// E o risco de escala que ainda não aconteceu: uuid VÁLIDO de OUTRO paciente.

const MARCO: EntityCandidate = { id: '11111111-1111-4111-8111-111111111111', labels: ['endocrinologia', 'Dr. Marco Elísio Sócrates de Castro'] };
const RAFAEL: EntityCandidate = { id: '22222222-2222-4222-8222-222222222222', labels: ['reumatologia', 'Dr. Rafael Navarrete'] };
const DE_OUTRO_PACIENTE = '99999999-9999-4999-8999-999999999999';

describe('isUuid', () => {
  it('aceita uuid real e rejeita o que o modelo inventa', () => {
    expect(isUuid('11111111-1111-4111-8111-111111111111')).toBe(true);
    expect(isUuid('  11111111-1111-4111-8111-111111111111  ')).toBe(true);
    for (const junk of ['act', 'Nilo Machado Junior', 'message_id', '1', '13/08/2026 09:00', '', null, undefined, 42]) {
      expect(isUuid(junk)).toBe(false);
    }
  });
});

describe('resolveEntityRef — caso feliz e segurança', () => {
  it('uuid que é do paciente resolve exato', () => {
    expect(resolveEntityRef(MARCO.id, [MARCO, RAFAEL])).toEqual({ kind: 'exact', id: MARCO.id });
  });

  it('🔒 uuid VÁLIDO de outro paciente NUNCA é usado — cai no resgate pelo estado dele', () => {
    // Com uma consulta só, resolve pela dele (nunca a alheia).
    expect(resolveEntityRef(DE_OUTRO_PACIENTE, [MARCO])).toEqual({ kind: 'rescued', id: MARCO.id, why: 'only-one' });
    // Com várias, prefere perguntar a chutar — e o id alheio segue fora do resultado.
    const d = resolveEntityRef(DE_OUTRO_PACIENTE, [MARCO, RAFAEL]);
    expect(d.kind).toBe('ambiguous');
    expect(JSON.stringify(d)).not.toContain(DE_OUTRO_PACIENTE);
  });

  it('sem candidato nenhum → none/no-candidates (nunca inventa)', () => {
    expect(resolveEntityRef(MARCO.id, [])).toEqual({ kind: 'none', reason: 'no-candidates' });
  });
});

describe('resolveEntityRef — resgate por RÓTULO (é o que faz funcionar, não só não quebrar)', () => {
  it('nome parcial do médico resolve ("Rafael" ⊂ "Dr. Rafael Navarrete")', () => {
    expect(resolveEntityRef('Rafael', [MARCO, RAFAEL])).toEqual({ kind: 'rescued', id: RAFAEL.id, why: 'label' });
    expect(resolveEntityRef('Dr. Rafael Navarrete', [MARCO, RAFAEL])).toEqual({ kind: 'rescued', id: RAFAEL.id, why: 'label' });
  });

  it('especialidade resolve, com ou sem preposição', () => {
    expect(resolveEntityRef('reumatologia', [MARCO, RAFAEL])).toEqual({ kind: 'rescued', id: RAFAEL.id, why: 'label' });
    expect(resolveEntityRef('a consulta de endocrinologia', [MARCO, RAFAEL])).toEqual({ kind: 'rescued', id: MARCO.id, why: 'label' });
  });

  it('rótulo que casa com DUAS → ambíguo (pergunta, não chuta)', () => {
    const gemeas = [{ id: 'a', labels: ['reumatologia'] }, { id: 'b', labels: ['reumatologia'] }];
    expect(resolveEntityRef('reumatologia', gemeas)).toEqual({ kind: 'ambiguous', ids: ['a', 'b'] });
  });
});

describe('resolveEntityRef — a regra que evita agir na consulta ERRADA (caso Nilo)', () => {
  it('🔴 nome real que não bate com nada NÃO cai no resgate por eliminação', () => {
    // Ao vivo: modelo mandou "Nilo Machado Junior"; a única consulta ativa era a do Marco
    // Elísio. Resolver por "só tem uma" teria CONFIRMADO a consulta errada.
    expect(resolveEntityRef('Nilo Machado Junior', [MARCO])).toEqual({ kind: 'none', reason: 'label-mismatch' });
    expect(resolveEntityRef('Nilo Machado Junior', [MARCO, RAFAEL])).toEqual({ kind: 'none', reason: 'label-mismatch' });
  });

  it('mas LIXO sem significado com uma única entidade viva resolve nela (caso "pode cancelar")', () => {
    // O paciente disse "pode cancelar" logo após falar do Marco Elísio; o modelo mandou um
    // placeholder. Resolver na única consulta ativa é o comportamento certo.
    for (const junk of ['active', 'current', 'consultation_id', 'message_id', 'message_0', '1', 'null', 'undefined', 'xxx', '']) {
      expect(resolveEntityRef(junk, [MARCO])).toEqual({ kind: 'rescued', id: MARCO.id, why: 'only-one' });
    }
  });

  it('token DESCONHECIDO curto falha seguro em vez de adivinhar — e o loop se corrige', () => {
    // "act" não está na lista de ruído e pode ser o começo de um nome real. Na dúvida a
    // decisão é `none`: o modelo recebe "NADA FOI CANCELADO… as consultas são: com Dr.
    // Marco Elísio" e refaz a chamada com uma referência boa. Adivinhar aqui seria agir
    // na entidade errada — o único desfecho pior que não agir.
    expect(resolveEntityRef('act', [MARCO])).toEqual({ kind: 'none', reason: 'label-mismatch' });
  });

  it('lixo com VÁRIAS entidades vivas → ambíguo (pergunta qual)', () => {
    expect(resolveEntityRef('active', [MARCO, RAFAEL])).toEqual({ kind: 'ambiguous', ids: [MARCO.id, RAFAEL.id] });
  });
});

describe('resolveEntityRef — datas (o quote_id que veio como "13/08/2026 09:00")', () => {
  const q1 = { id: 'q1', labels: ['13/08/2026 09:00', 'Clínica A'] };
  const q2 = { id: 'q2', labels: ['14/08/2026 15:30', 'Clínica A'] };

  it('data casa com a cotação certa', () => {
    expect(resolveEntityRef('13/08/2026 09:00', [q1, q2])).toEqual({ kind: 'rescued', id: 'q1', why: 'label' });
  });

  it('data que não casa com nenhuma, mas só há UMA cotação → resolve nela', () => {
    // Data não carrega palavra: não vale a regra do label-mismatch (que é pra NOMES).
    expect(resolveEntityRef('20/09/2026 08:00', [q1])).toEqual({ kind: 'rescued', id: 'q1', why: 'only-one' });
  });

  it('data que não casa com nenhuma e há VÁRIAS → ambíguo', () => {
    expect(resolveEntityRef('20/09/2026 08:00', [q1, q2]).kind).toBe('ambiguous');
  });
});

describe('resolveEntityRef — vocabulário de ESCOLHA (o modelo diz "opção 1", não o uuid)', () => {
  // O bloco de contexto NUNCA expõe uuid de cotação: o paciente vê "1️⃣ 2️⃣" e o modelo
  // devolve "opção 1"/"a primeira". Sem esses tokens no ruído, "opcao" (≥3 letras) contava
  // como nome próprio e caía em label-mismatch — o resgate nunca resgatava o caso real.
  const q1 = { id: 'q1', labels: ['1', '13/08/2026 09:00'] };
  const q2 = { id: 'q2', labels: ['2', '14/08/2026 15:30'] };

  it('"opção 1" / "opcao 1" / "1" casam com a opção 1', () => {
    for (const raw of ['opção 1', 'opcao 1', 'option 1', '1', 'a opção 1']) {
      expect(resolveEntityRef(raw, [q1, q2])).toEqual({ kind: 'rescued', id: 'q1', why: 'label' });
    }
  });

  it('LIMITE CONHECIDO: ordinal por extenso sem número não identifica (fica ambíguo, não erra)', () => {
    // "a segunda" também é dia da semana em PT-BR — mapear pra 2 arriscaria confirmar o
    // horário errado. Preferimos a recusa: a mensagem de falha lista as opções REAIS, e o
    // modelo refaz a chamada com o horário. Errar aqui manda o paciente pra outra consulta.
    expect(resolveEntityRef('a segunda', [q1, q2]).kind).toBe('ambiguous');
    // Com uma opção só, o resgate por eliminação resolve.
    expect(resolveEntityRef('a primeira', [q1])).toEqual({ kind: 'rescued', id: 'q1', why: 'only-one' });
  });
});

describe('loneNumberRef — "quero a 2" é o NÚMERO DA OPÇÃO, não pedaço de data', () => {
  // Achado da 3ª revisão: normalizar zeros à esquerda (pra "9h30" casar com "09:30") fez o
  // mês "02" de 15/02/2026 virar o token "2" — e "opção 2" passou a casar com a data da
  // opção 1 também, virando ambíguo. Quem consome esta função dá precedência ao ordinal.
  it('extrai o número quando a referência é só um número (com ou sem "opção")', () => {
    expect(loneNumberRef('2')).toBe(2);
    expect(loneNumberRef('opção 2')).toBe(2);
    expect(loneNumberRef('a opcao 2')).toBe(2);
    expect(loneNumberRef('quero a 3')).toBe(null);   // "quero" é palavra: não é número solto
  });

  it('devolve null quando NÃO é número solto (data, hora, nome)', () => {
    expect(loneNumberRef('13/08/2026 09:00')).toBe(null);
    expect(loneNumberRef('9h30')).toBe(null);
    expect(loneNumberRef('Dr. Rafael')).toBe(null);
    expect(loneNumberRef('')).toBe(null);
    expect(loneNumberRef(null)).toBe(null);
  });

  it('"dia 11" é número solto — quem resolve decide se 11 é opção ou dia', () => {
    expect(loneNumberRef('dia 11')).toBe(11);
  });
});

describe('resolveEntityRef — horário no jeito que o brasileiro escreve', () => {
  // Achado da 2ª revisão: o rótulo é "11/08/2026, 09:30" e o paciente escreve "9h30".
  // Sem normalizar o zero à esquerda, '9' ≠ '09' e uma escolha INEQUÍVOCA virava
  // "não entendi, qual horário?" — o loop de insistência que já custou caro.
  const q1 = { id: 'q1', labels: ['1', '11/08/2026, 09:30', '11/08/2026', '09:30'] };
  const q2 = { id: 'q2', labels: ['2', '14/08/2026, 15:00', '14/08/2026', '15:00'] };

  it('9h30 / 9:30 / 09:30 resolvem a mesma opção', () => {
    for (const raw of ['9h30', '9:30', '09:30', 'às 9h30', 'terça 09:30']) {
      expect(resolveEntityRef(raw, [q1, q2])).toEqual({ kind: 'rescued', id: 'q1', why: 'label' });
    }
  });

  it('"dia 11" e "11/08" resolvem pela data', () => {
    for (const raw of ['dia 11', '11/08', 'no dia 11/08']) {
      expect(resolveEntityRef(raw, [q1, q2])).toEqual({ kind: 'rescued', id: 'q1', why: 'label' });
    }
  });

  it('hora cheia sem minuto casa a opção certa', () => {
    expect(resolveEntityRef('15h', [q1, q2])).toEqual({ kind: 'rescued', id: 'q2', why: 'label' });
  });
});

describe('resolveEntityRef — rótulo genérico não pode casar com tudo', () => {
  it('"consulta" (especialidade desconhecida) não identifica nada sozinho', () => {
    const generica = { id: 'g', labels: ['consulta'] };
    const outra = { id: 'o', labels: ['dermatologia'] };
    // 'consulta' é ruído dos dois lados → sem match por rótulo → ambíguo, não escolha cega.
    expect(resolveEntityRef('consulta', [generica, outra]).kind).toBe('ambiguous');
  });
});
