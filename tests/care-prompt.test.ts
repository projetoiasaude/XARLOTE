/**
 * O bloco do prompt que ensina a Xarlote a cuidar de mais de uma pessoa.
 *
 * Ele só aparece quando existe vínculo — em 99% dos turnos o prompt tem que ficar
 * exatamente como era, sem gastar contexto nem sugerir uma capacidade que a pessoa não tem.
 */
import { describe, it, expect } from 'vitest';
import { buildXarloteSystemPrompt } from '../packages/llm/src/prompts/xarlote.system.js';
import type { CareLinkView } from '../packages/shared/src/care-access.js';

const MAE: CareLinkView = { subjectUserId: 'u1', subjectName: 'Maria', relation: 'mae', kind: 'vinculo', status: 'ativo' };
const FILHO: CareLinkView = { subjectUserId: 'u2', subjectName: 'Pedro', relation: 'filho', kind: 'dependente', status: 'ativo' };
const REVOGADO: CareLinkView = { subjectUserId: 'u3', subjectName: 'Antiga', relation: 'avo', kind: 'vinculo', status: 'revogado' };

describe('o bloco só existe quando faz sentido', () => {
  it('sem vínculo, o prompt não menciona cuidar de ninguém', () => {
    const p = buildXarloteSystemPrompt({ preferredName: 'Hiago' });
    expect(p).not.toContain('QUEM VOCÊ CUIDA');
    expect(p).not.toContain('para_quem');
  });

  it('lista vazia é o mesmo que não ter', () => {
    expect(buildXarloteSystemPrompt({ preferredName: 'Hiago', careLinks: [] })).not.toContain('QUEM VOCÊ CUIDA');
  });

  it('vínculo REVOGADO não aparece — nem o bloco', () => {
    const p = buildXarloteSystemPrompt({ preferredName: 'Hiago', careLinks: [REVOGADO] });
    expect(p).not.toContain('QUEM VOCÊ CUIDA');
    expect(p).not.toContain('Antiga');
  });
});

describe('com vínculo, ensina o que precisa', () => {
  const p = buildXarloteSystemPrompt({ preferredName: 'Hiago', careLinks: [MAE, FILHO, REVOGADO] });

  it('nomeia as pessoas vivas e o parentesco delas', () => {
    expect(p).toContain('Maria');
    expect(p).toContain('mãe dele');
    expect(p).toContain('Pedro');
    expect(p).toContain('filho dele');
  });

  it('e não vaza o vínculo revogado', () => {
    expect(p).not.toContain('Antiga');
  });

  it('diz que o dependente não tem WhatsApp próprio', () => {
    expect(p).toContain('sem WhatsApp');
  });

  it('ensina o argumento e deixa claro que o PADRÃO é o próprio', () => {
    expect(p).toContain('para_quem');
    expect(p).toMatch(/SEM esse campo/i);
  });

  it('proíbe o chute — a regra mais importante do bloco', () => {
    expect(p).toContain('NUNCA CHUTE');
    expect(p).toMatch(/PERGUNTE antes de registrar/i);
  });

  it('manda dizer em voz alta onde anotou', () => {
    expect(p).toMatch(/voz alta/i);
    expect(p).toContain('dona Maria');
  });

  it('avisa que farmácia e consulta em nome de outro NÃO estão disponíveis', () => {
    // Espelha, em português, o degrau `falar` que `podeAtuarSobre` recusa. Sem isto o
    // modelo tentaria e só descobriria pela recusa da tool, já tendo prometido ao paciente.
    expect(p).toMatch(/NÃO está disponível/i);
  });

  it('explica o caminho pra quem não está na lista', () => {
    expect(p).toContain('código');
  });
});
