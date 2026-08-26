/**
 * De quem é a ação.
 *
 * Toda tool escreve com `.eq('user_id', ctx.userId)`. No momento em que esse id pode ser
 * outra pessoa, um erro aqui é um registro de dose ou um lembrete de remédio caindo no
 * prontuário errado. Os testes abaixo cercam as três defesas em camadas.
 */
import { describe, it, expect } from 'vitest';
import {
  resolverAlvoDaTool, aceitaSujeito, emergenciaSobreQuemCuido,
  TOOLS_COM_SUJEITO, PASSADO_RE, TERCEIRO_RE,
} from '../packages/shared/src/care-tools.js';
import type { CareLinkView } from '../packages/shared/src/care-access.js';

const FILHO = 'u-filho';
const MAE = 'u-mae';
const ator = (vinculos: CareLinkView[] = []) => ({ userId: FILHO, nome: 'Hiago', vinculos });

const mae: CareLinkView = {
  subjectUserId: MAE, subjectName: 'Maria', relation: 'mae', kind: 'vinculo', status: 'ativo',
};

describe('camada 1 — silêncio é sempre o próprio', () => {
  it('sem `para_quem`, a ação é do ator, mesmo com vínculos', () => {
    expect(resolverAlvoDaTool('create_reminder', {}, ator([mae])))
      .toEqual({ ok: true, subjectUserId: FILHO, via: 'proprio' });
  });

  it('`para_quem` vazio ou só espaço também é o próprio', () => {
    expect(resolverAlvoDaTool('create_reminder', { para_quem: '  ' }, ator([mae])).ok).toBe(true);
    expect(resolverAlvoDaTool('create_reminder', { para_quem: '' }, ator([mae])))
      .toMatchObject({ via: 'proprio' });
  });

  it('args ausentes não quebram', () => {
    expect(resolverAlvoDaTool('create_reminder', null, ator([mae]))).toMatchObject({ via: 'proprio' });
    expect(resolverAlvoDaTool('create_reminder', undefined, ator())).toMatchObject({ via: 'proprio' });
  });
});

describe('camada 2 — a lista fechada é o mecanismo', () => {
  it('as tools de prontuário aceitam alvo', () => {
    for (const t of TOOLS_COM_SUJEITO) expect(aceitaSujeito(t)).toBe(true);
  });

  it.each([
    'start_pharmacy_order', 'confirm_order_selection', 'message_supplier',
    'start_consultation_search', 'confirm_consultation_selection', 'cancel_consultation',
    'nudge_consultation', 'contact_establishment', 'cancel_order',
  ])('%s NUNCA é redirecionável — fala com terceiro', (tool) => {
    expect(aceitaSujeito(tool)).toBe(false);
    const r = resolverAlvoDaTool(tool, { para_quem: 'minha mãe' }, ator([mae]));
    expect(r.ok).toBe(false);
  });

  it('e a recusa é EM VOZ ALTA, não em silêncio', () => {
    // Ignorar o argumento faria a ação cair no registro do ator enquanto o modelo anuncia
    // que foi pra outra pessoa. A mensagem tem que dizer que nada foi feito.
    const r = resolverAlvoDaTool('start_pharmacy_order', { para_quem: 'minha mãe' }, ator([mae]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.mensagem).toContain('NADA FOI FEITO');
  });
});

describe('camada 3 — resolver quem é', () => {
  it('acha pelo nome e pelo parentesco', () => {
    expect(resolverAlvoDaTool('create_reminder', { para_quem: 'Maria' }, ator([mae])))
      .toMatchObject({ ok: true, subjectUserId: MAE, via: 'vinculo' });
    expect(resolverAlvoDaTool('create_reminder', { para_quem: 'minha mãe' }, ator([mae])))
      .toMatchObject({ ok: true, subjectUserId: MAE });
  });

  it('sem vínculo nenhum, explica como conectar em vez de registrar no lugar', () => {
    const r = resolverAlvoDaTool('create_reminder', { para_quem: 'minha mãe' }, ator([]));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.mensagem).toContain('NADA FOI FEITO');
      expect(r.mensagem).toContain('código');
    }
  });

  it('nome desconhecido lista quem ele cuida — e NÃO registra', () => {
    const r = resolverAlvoDaTool('create_reminder', { para_quem: 'Joaquina' }, ator([mae]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.mensagem).toContain('Maria');
  });

  it('ambíguo manda PERGUNTAR', () => {
    const duas: CareLinkView[] = [
      mae,
      { subjectUserId: 'u-sogra', subjectName: 'Maria', relation: 'outro', kind: 'vinculo', status: 'ativo' },
    ];
    const r = resolverAlvoDaTool('create_reminder', { para_quem: 'Maria' }, ator(duas));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.mensagem).toContain('PERGUNTE');
  });

  it('vínculo revogado não é alvo válido', () => {
    const morto = [{ ...mae, status: 'revogado' as const }];
    expect(resolverAlvoDaTool('create_reminder', { para_quem: 'Maria' }, ator(morto)).ok).toBe(false);
  });
});

describe('emergência sobre quem ele cuida', () => {
  it('🔴 "minha mãe está com dor no peito" agora ESCALA quando ela é vinculada', () => {
    // Hoje isso não aciona o SAMU: a guarda de terceira pessoa suprime tudo. Com vínculo,
    // é silêncio sobre um infarto — quem escreveu está do lado dela.
    const r = emergenciaSobreQuemCuido('minha mãe está com dor no peito agora', { userId: FILHO, nome: 'Hiago' }, [mae]);
    expect(r?.subjectUserId).toBe(MAE);
  });

  it('sem vínculo, o comportamento de hoje fica intacto', () => {
    expect(emergenciaSobreQuemCuido('minha mãe está com dor no peito', { userId: FILHO, nome: 'Hiago' }, [])).toBeNull();
  });

  it('🔴 PASSADO continua suprimindo, mesmo com vínculo', () => {
    // "Semana passada minha mãe teve dor no peito, cota AAS" não é emergência — e este é
    // o caso que a separação dos dois regexes existe pra preservar.
    expect(emergenciaSobreQuemCuido(
      'semana passada minha mãe teve dor no peito, quero cotar AAS',
      { userId: FILHO, nome: 'Hiago' }, [mae],
    )).toBeNull();
  });

  it('os dois motivos de não escalar são de fato distintos', () => {
    expect(PASSADO_RE.test('semana passada')).toBe(true);
    expect(PASSADO_RE.test('minha mãe')).toBe(false);
    expect(TERCEIRO_RE.test('minha mãe')).toBe(true);
    expect(TERCEIRO_RE.test('semana passada')).toBe(false);
  });

  it('terceiro NÃO vinculado (um amigo) não escala', () => {
    expect(emergenciaSobreQuemCuido('um amigo está com falta de ar', { userId: FILHO, nome: 'Hiago' }, [mae])).toBeNull();
  });

  it('primeira pessoa não passa por aqui (não é terceiro)', () => {
    expect(emergenciaSobreQuemCuido('estou com dor no peito', { userId: FILHO, nome: 'Hiago' }, [mae])).toBeNull();
  });

  it('texto vazio não quebra', () => {
    expect(emergenciaSobreQuemCuido('', { userId: FILHO, nome: 'Hiago' }, [mae])).toBeNull();
  });
});
