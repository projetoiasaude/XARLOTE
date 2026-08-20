import { describe, it, expect } from 'vitest';
import {
  checarNome,
  fraseDeApelido,
  MAX_NOME,
  MIN_NOME,
  normalizarNome,
  primeiroNome,
  recadoDoProblema,
} from '../apps/mobile/src/features/profile/nome.js';

/**
 * O nome do paciente.
 *
 * A tela mostrava "Sem nome ainda" e não oferecia nada. Agora ela oferece um campo — e
 * campo que escreve num prontuário precisa recusar entrada errada ANTES de a Xarlote
 * gravar, porque depois de gravado ela chama a pessoa por aquilo durante meses.
 *
 * O outro teste que importa é o da FRASE: ela é o que sai daqui pra conversa e é o que a
 * Xarlote lê pra chamar `save_user_profile_fact`. Se alguém mexer na redação sem pensar,
 * este arquivo é que segura.
 */

describe('normalizarNome', () => {
  it('tira sobra das pontas, espaço duplo e quebra de linha', () => {
    expect(normalizarNome('  Maria   das Graças  ')).toBe('Maria das Graças');
    expect(normalizarNome('Ana\nPaula')).toBe('Ana Paula');
  });

  it('não muda a grafia — o que a pessoa escreveu é o que ela lê de volta', () => {
    expect(normalizarNome('márcia')).toBe('márcia');
    expect(normalizarNome('MARIA')).toBe('MARIA');
  });
});

describe('checarNome', () => {
  it('aceita nome comum', () => {
    expect(checarNome('Marina', null)).toEqual({ nome: 'Marina', problema: null, ok: true });
  });

  it('campo vazio não é erro pra mostrar — é "ainda não digitou"', () => {
    expect(checarNome('', null).problema).toBe('vazio');
    expect(checarNome('   ', null).problema).toBe('vazio');
    expect(recadoDoProblema('vazio')).toBeNull();
  });

  it('uma letra é quase sempre dedo errado', () => {
    expect(checarNome('M', null).problema).toBe('curto');
    expect(checarNome('Mo', null).ok).toBe(true);
    expect(MIN_NOME).toBe(2);
  });

  it('recusa acima do teto do campo', () => {
    expect(checarNome('a'.repeat(MAX_NOME), null).ok).toBe(true);
    expect(checarNome('a'.repeat(MAX_NOME + 1), null).problema).toBe('longo');
  });

  it('recusa dígito — o campo errado aqui costuma ser telefone, idade ou CPF', () => {
    // Deixar passar significa a Xarlote gravar "Maria 62" e chamar a pessoa assim.
    expect(checarNome('Maria 62', null).problema).toBe('numero');
    expect(checarNome('62998887766', null).problema).toBe('numero');
  });

  it('nome IGUAL ao que já vale não vira pedido — e acento/caixa não contam', () => {
    // Sem isso, o app gastaria um turno de conversa pra receber "combinado" de volta.
    expect(checarNome('Márcia', 'Marcia').problema).toBe('igual');
    expect(checarNome('marcia', 'Márcia').problema).toBe('igual');
    expect(checarNome('  Márcia ', 'Márcia').problema).toBe('igual');
    expect(recadoDoProblema('igual')).toBeNull();
  });

  it('mudança real de nome PASSA mesmo com nome atual definido', () => {
    expect(checarNome('Graça', 'Maria').ok).toBe(true);
  });

  it('devolve o nome já normalizado — é isto que vai no pedido, não o texto cru', () => {
    expect(checarNome('  Ana   Clara ', null).nome).toBe('Ana Clara');
  });

  it('todo problema visível tem recado; botão desabilitado calado é o defeito do login', () => {
    expect(recadoDoProblema('curto')).toBeTruthy();
    expect(recadoDoProblema('longo')).toContain(String(MAX_NOME));
    expect(recadoDoProblema('numero')).toBeTruthy();
    expect(recadoDoProblema(null)).toBeNull();
  });
});

describe('fraseDeApelido', () => {
  it('é um pedido de APELIDO, na primeira pessoa do paciente', () => {
    // Quem envia é ele; a linha aparece no histórico como dele. E o campo é
    // `preferred_name`: quem se chama Maria das Graças e quer ser chamada de Graça está
    // dizendo como quer ser chamada, não qual é o nome de registro.
    expect(fraseDeApelido('Graça')).toBe('Pode me chamar de Graça.');
  });

  it('normaliza antes de mandar — sem espaço duplo viajando pra conversa', () => {
    expect(fraseDeApelido('  Ana   Clara ')).toBe('Pode me chamar de Ana Clara.');
  });
});

describe('primeiroNome', () => {
  it('devolve null em vez de string vazia — "Bom dia, !" o paciente lê', () => {
    expect(primeiroNome(null)).toBeNull();
    expect(primeiroNome(undefined)).toBeNull();
    expect(primeiroNome('   ')).toBeNull();
  });

  it('pega o primeiro token de um nome composto', () => {
    expect(primeiroNome('Maria das Graças')).toBe('Maria');
    expect(primeiroNome('  Ana  ')).toBe('Ana');
  });
});
