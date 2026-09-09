/**
 * "Faltam X dias pra acabar a caixa!" — com o X literal — saiu pra um paciente real cinco
 * dias seguidos (Glauber, 04–08/09/2026). O corpo abaixo é o que estava no banco.
 */
import { describe, expect, it } from 'vitest';
import { sanitizarCorpoDeLembrete, temPlaceholder } from '../packages/shared/src/reminder-body.js';

const BODY_REAL = 'Oi Glauber! Hora do Levofloxacino 500mg 💊 Toma 1 comprimido agora, depois das 13h30. Faltam X dias pra acabar a caixa!';

describe('o placeholder que foi entregue', () => {
  it('derruba a oração com "X dias" e mantém o resto intacto', () => {
    const r = sanitizarCorpoDeLembrete(BODY_REAL);
    expect(r.removidas).toEqual(['Faltam X dias pra acabar a caixa!']);
    expect(r.body).toBe('Oi Glauber! Hora do Levofloxacino 500mg 💊 Toma 1 comprimido agora, depois das 13h30.');
  });
  it('é idempotente', () => {
    const uma = sanitizarCorpoDeLembrete(BODY_REAL).body;
    expect(sanitizarCorpoDeLembrete(uma).body).toBe(uma);
  });
  it('contagem DE VERDADE não é placeholder', () => {
    const r = sanitizarCorpoDeLembrete('Hora do antibiótico 💊 Faltam 3 dias pra acabar a caixa!');
    expect(r.removidas).toEqual([]);
    expect(r.body).toContain('Faltam 3 dias');
  });
});

describe('outras marcas que o modelo já usou', () => {
  it.each([
    'Oi {nome}! Hora do remédio.',
    'Oi {{nome}}, tomou?',
    'Hora do [remédio] 💊',
    'Toma <dose> agora.',
    'Restam N doses.',
    'Faltam XX dias.',
    'Nome do paciente, hora do remédio.',
    'Preencher aqui.',
    'Hora do remédio ____',
  ])('%s → é placeholder', (frase) => {
    expect(temPlaceholder(frase)).toBe(true);
  });
  it.each([
    'Oi Pedro! Hora da Losartana 💊 Já tomou?',
    'Toma 2 comprimidos com água.',
    'Hoje é dia da quimioterapia, 7h!',
    'Exame de raio-x às 10h.',
    'Aplica a loção na barba 🧴',
  ])('%s → texto normal, passa', (frase) => {
    expect(temPlaceholder(frase)).toBe(false);
  });
  it('tudo placeholder → body null (o dispatcher usa o título)', () => {
    expect(sanitizarCorpoDeLembrete('Faltam X dias!').body).toBeNull();
    expect(sanitizarCorpoDeLembrete('').body).toBeNull();
    expect(sanitizarCorpoDeLembrete(null).body).toBeNull();
  });
});
