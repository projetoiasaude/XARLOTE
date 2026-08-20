/**
 * `semOCard` — a remoção do card no JSONB canônico de `conversations.memory_cards`.
 *
 * A função é pequena e a tentação é não testá-la. Mas ela decide se um aprendizado que a
 * pessoa mandou apagar some do arquivo que a LGPD alcança, e o modo de falhar dela é
 * silencioso: devolver a lista intacta e a rota responder 204 assim mesmo. A pessoa veria
 * "pronto, tirei", pediria a portabilidade dos próprios dados, e o card estaria lá.
 */
import { describe, it, expect } from 'vitest';
import { semOCard } from '../apps/api/src/routes/app/memory.js';

const card = (id: string, texto = 'algo') => ({ id, kind: 'fact', text: texto });

describe('semOCard — tira o card certo', () => {
  it('remove o card e preserva os outros, na ordem', () => {
    const antes = [card('a'), card('b'), card('c')];
    const depois = semOCard(antes, 'b');
    expect(depois).not.toBeNull();
    expect(depois!.map((c) => c.id)).toEqual(['a', 'c']);
  });

  it('remove o primeiro e o último sem sobrar buraco', () => {
    expect(semOCard([card('a'), card('b')], 'a')!.map((c) => c.id)).toEqual(['b']);
    expect(semOCard([card('a'), card('b')], 'b')!.map((c) => c.id)).toEqual(['a']);
  });

  it('lista com um só card fica vazia, e isso NÃO é "não achei"', () => {
    const depois = semOCard([card('unico')], 'unico');
    expect(depois).toEqual([]);
    // O `[]` precisa ser distinguível de `null`: um é "apaguei o último", o outro é
    // "não estava aqui". Confundir os dois faz a rota pular a gravação e o card voltar.
    expect(depois).not.toBeNull();
  });
});

describe('semOCard — diz quando não havia nada a tirar', () => {
  it('id ausente devolve null, não a lista intacta', () => {
    expect(semOCard([card('a'), card('b')], 'z')).toBeNull();
  });

  it('lista vazia devolve null', () => {
    expect(semOCard([], 'a')).toBeNull();
  });
});

describe('semOCard — JSONB é dado de fora e vem torto', () => {
  it('card sem id não derruba nem é confundido com o alvo', () => {
    const antes = [{ kind: 'fact', text: 'sem id' }, card('a')];
    expect(semOCard(antes, 'a')!.length).toBe(1);
    // E procurar por string vazia não pode varrer os cards sem id.
    expect(semOCard(antes, '')).toBeNull();
  });

  it('id numérico casa com a string do parâmetro de rota', () => {
    // O JSONB aceita qualquer forma; o `:id` da rota chega sempre como string. Sem a
    // normalização, um card gravado com id numérico seria impossível de apagar.
    const antes = [{ id: 42, kind: 'fact', text: 'x' }];
    expect(semOCard(antes, '42')).toEqual([]);
  });

  it('id nulo ou indefinido não casa com nada', () => {
    const antes = [{ id: null, text: 'a' }, { text: 'b' }];
    expect(semOCard(antes, 'null')).toBeNull();
    expect(semOCard(antes, 'undefined')).toBeNull();
  });

  it('não muta o array recebido', () => {
    const antes = [card('a'), card('b')];
    semOCard(antes, 'a');
    expect(antes.map((c) => c.id)).toEqual(['a', 'b']);
  });
});
