/**
 * Auto-verificação da fala antes de sair pra um terceiro real.
 *
 * Nasceu do caso Glauber/IAD (29-30/07): a Xarlote mandou DUAS VEZES para uma clínica
 * "preciso de uma consulta de consulta". Não é o modelo que é ruim — é que entre gerar e
 * enviar não existia nenhuma etapa que relesse a frase.
 */
import { describe, expect, it } from 'vitest';
import { checkOutboundSanity } from '../packages/shared/src/sanity.js';
import { specialtyPhrase } from '../packages/shared/src/specialty.js';

describe('checkOutboundSanity — conserta o que tem conserto', () => {
  it('a frase REAL do incidente é reparada', () => {
    const r = checkOutboundSanity('Estou ajudando um paciente que precisa de uma consulta de consulta e gostaria de saber o valor.');
    expect(r.text).toContain('precisa de uma consulta e gostaria');
    expect(r.text).not.toMatch(/consulta de consulta/i);
    expect(r.blockers).toEqual([]);
    expect(r.repairs.length).toBeGreaterThan(0);
  });

  it('pega as outras degenerações da mesma família', () => {
    expect(checkOutboundSanity('um exame de exame').text).not.toMatch(/exame de exame/i);
    expect(checkOutboundSanity('uma consulta de médico').text).toContain('consulta médica');
  });

  it('NÃO mexe em frase legítima parecida', () => {
    // "consulta de cardiologia" e "exame de sangue" são corretos — não podem ser tocados.
    const ok = 'preciso de uma consulta de cardiologia e um exame de sangue';
    const r = checkOutboundSanity(ok);
    expect(r.text).toBe(ok);
    expect(r.repairs).toEqual([]);
    expect(r.blockers).toEqual([]);
  });
});

describe('checkOutboundSanity — bloqueia o que NÃO tem conserto seguro', () => {
  it('artefato de código nunca chega a um humano', () => {
    expect(checkOutboundSanity('valor: undefined').blockers.length).toBeGreaterThan(0);
    expect(checkOutboundSanity('paciente [object Object]').blockers.length).toBeGreaterThan(0);
    expect(checkOutboundSanity('horário {{2}} confirmado').blockers.length).toBeGreaterThan(0);
  });

  it('preposição órfã (variável vazia) bloqueia — não dá pra adivinhar o que faltou', () => {
    expect(checkOutboundSanity('preciso de uma consulta de  e o valor').blockers.length).toBeGreaterThan(0);
    expect(checkOutboundSanity('marcar com , por favor').blockers.length).toBeGreaterThan(0);
  });

  it('texto vazio não é enviado', () => {
    expect(checkOutboundSanity('').blockers.length).toBeGreaterThan(0);
    expect(checkOutboundSanity('  ').blockers.length).toBeGreaterThan(0);
  });

  it('mensagem normal passa limpa', () => {
    const r = checkOutboundSanity('Oi, tudo bem? Consegue me passar o valor da consulta?');
    expect(r.blockers).toEqual([]);
    expect(r.repairs).toEqual([]);
  });
});

// A raiz do incidente: os dois caminhos (texto livre e template) montavam o sintagma de
// formas diferentes, e só um tinha guarda contra especialidade genérica.
describe('specialtyPhrase — fonte única, genérico nunca vira "consulta de consulta"', () => {
  it('genérico devolve null (caller cai no rótulo neutro)', () => {
    for (const g of ['consulta', 'Consulta', 'médico', 'medica', 'especialista']) {
      expect(specialtyPhrase(g)).toBeNull();
    }
  });

  it('especialidade real é preservada', () => {
    expect(specialtyPhrase('gastroenterologia')).toBe('uma consulta de gastroenterologia');
    expect(specialtyPhrase('ginecologista')).toBe('um ginecologista');
  });
});
