/**
 * Quem pode agir no registro de quem.
 *
 * Este é o módulo que separa ATOR de SUJEITO — a distinção que não existia no produto até
 * aqui, porque `findUserByPhone(telefone)` sempre devolveu uma pessoa só. Os testes abaixo
 * cercam as três invariantes: o padrão é sempre o próprio, o vínculo é verificado e nunca
 * inferido, e ambiguidade não vira chute.
 */
import { describe, it, expect } from 'vitest';
import {
  podeAtuarSobre, resolverSujeito, vinculosAtivos, descreverVinculo, descreverParentesco,
  type CareLinkView,
} from '../packages/shared/src/care-access.js';

const FILHO = 'u-filho';
const MAE = 'u-mae';
const NETO = 'u-neto';

const vinculoMae: CareLinkView = {
  subjectUserId: MAE, subjectName: 'Maria', relation: 'mae', kind: 'vinculo', status: 'ativo',
};
const vinculoFilhoPequeno: CareLinkView = {
  subjectUserId: NETO, subjectName: 'Pedro', relation: 'filho', kind: 'dependente', status: 'ativo',
};

describe('o padrão é sempre o próprio', () => {
  it('agir sobre si mesmo não depende de vínculo nenhum', () => {
    expect(podeAtuarSobre(FILHO, FILHO, [], 'agir')).toEqual({ pode: true, via: 'proprio' });
  });

  it('sem `para_quem`, o sujeito é o ator — mesmo com vínculos disponíveis', () => {
    // A regra que impede o pior acidente: silêncio nunca roteia pra terceiro.
    expect(resolverSujeito(null, { userId: FILHO, nome: 'Hiago' }, [vinculoMae]))
      .toEqual({ kind: 'proprio', userId: FILHO });
    expect(resolverSujeito('   ', { userId: FILHO, nome: 'Hiago' }, [vinculoMae]))
      .toEqual({ kind: 'proprio', userId: FILHO });
  });
});

describe('o vínculo é verificado, nunca inferido', () => {
  it('sem vínculo, não passa', () => {
    const v = podeAtuarSobre(FILHO, MAE, [], 'ver');
    expect(v.pode).toBe(false);
    if (!v.pode) expect(v.motivo).toBe('sem_vinculo');
  });

  it('com vínculo ativo, passa pra ver e pra agir', () => {
    expect(podeAtuarSobre(FILHO, MAE, [vinculoMae], 'ver').pode).toBe(true);
    expect(podeAtuarSobre(FILHO, MAE, [vinculoMae], 'agir').pode).toBe(true);
  });

  it('revogado deixa de valer NA HORA, e o motivo é distinto de nunca ter existido', () => {
    const revogado = { ...vinculoMae, status: 'revogado' as const };
    const v = podeAtuarSobre(FILHO, MAE, [revogado], 'ver');
    expect(v.pode).toBe(false);
    if (!v.pode) expect(v.motivo).toBe('vinculo_revogado');
  });

  it('cuidar NÃO inclui falar com farmácia/consultório em nome do outro', () => {
    // Degrau explícito de propósito: envolve dinheiro e um terceiro real, e é decisão de
    // produto ainda não tomada. Não checar seria conceder por omissão.
    const v = podeAtuarSobre(FILHO, MAE, [vinculoMae], 'falar');
    expect(v.pode).toBe(false);
    if (!v.pode) expect(v.motivo).toBe('capacidade_nao_concedida');
  });

  it('vínculo de OUTRA pessoa não serve pra este sujeito', () => {
    expect(podeAtuarSobre(FILHO, MAE, [vinculoFilhoPequeno], 'ver').pode).toBe(false);
  });
});

describe('resolver de quem é a ação', () => {
  const ator = { userId: FILHO, nome: 'Hiago' };

  it('acha pelo nome', () => {
    const r = resolverSujeito('Maria', ator, [vinculoMae]);
    expect(r).toMatchObject({ kind: 'vinculo', userId: MAE });
  });

  it('acha pelo parentesco ("minha mãe")', () => {
    expect(resolverSujeito('minha mãe', ator, [vinculoMae])).toMatchObject({ kind: 'vinculo', userId: MAE });
  });

  it('"pra mim" volta pro próprio', () => {
    expect(resolverSujeito('pra mim', ator, [vinculoMae])).toEqual({ kind: 'proprio', userId: FILHO });
  });

  it('🔴 com UM vínculo só, um alvo irreconhecível NÃO cai no prontuário dele', () => {
    // `resolveEntityRef` tem resgate `only-one`: com um candidato só, devolve esse
    // candidato mesmo sem casar o texto. Se a lista fosse só das pessoas cuidadas, um
    // "para_quem" sem sentido escreveria calado no registro da mãe. O ator entra na lista
    // justamente pra esse resgate nunca ter um alvo único.
    const r = resolverSujeito('Joaquina Nogueira', ator, [vinculoMae]);
    expect(r.kind).not.toBe('vinculo');
    expect(['desconhecido', 'ambiguo']).toContain(r.kind);
  });

  it('dois nomes possíveis ⇒ ambíguo, com os nomes pra perguntar', () => {
    const duasMarias: CareLinkView[] = [
      vinculoMae,
      { subjectUserId: 'u-sogra', subjectName: 'Maria', relation: 'outro', kind: 'vinculo', status: 'ativo' },
    ];
    const r = resolverSujeito('Maria', ator, duasMarias);
    expect(r.kind).toBe('ambiguo');
    if (r.kind === 'ambiguo') expect(r.nomes.length).toBeGreaterThanOrEqual(2);
  });

  it('vínculo revogado não é candidato', () => {
    const revogado = [{ ...vinculoMae, status: 'revogado' as const }];
    expect(resolverSujeito('Maria', ator, revogado).kind).not.toBe('vinculo');
  });

  it('sem vínculo nenhum, qualquer alvo cai em desconhecido — nunca no próprio por acidente', () => {
    const r = resolverSujeito('minha mãe', ator, []);
    expect(r.kind).toBe('desconhecido');
  });
});

describe('como isso é dito em voz alta', () => {
  it('a linha do prompt nomeia a pessoa e o parentesco', () => {
    const linha = descreverVinculo(vinculoMae);
    expect(linha).toContain('Maria');
    expect(linha).toContain('mãe dele');
  });

  it('dependente é apresentado como perfil sem WhatsApp', () => {
    expect(descreverVinculo(vinculoFilhoPequeno)).toContain('sem WhatsApp');
  });

  it('parentesco desconhecido não quebra nem inventa', () => {
    expect(descreverParentesco('xyz')).toBe('sob cuidado dele');
    expect(descreverParentesco('')).toBe('sob cuidado dele');
  });

  it('vinculosAtivos filtra os revogados', () => {
    const todos = [vinculoMae, { ...vinculoFilhoPequeno, status: 'revogado' as const }];
    expect(vinculosAtivos(todos)).toHaveLength(1);
  });
});
