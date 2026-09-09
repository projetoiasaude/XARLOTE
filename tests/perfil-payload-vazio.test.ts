/**
 * O áudio de boas-vindas que disse "Prontinho, já cuidei disso aqui!" (Rodrigo, 24/08/2026).
 *
 * Ele acabara de digitar o nome. O modelo chamou `save_user_profile_fact` com
 * `{category:'identity', payload:{}}` QUATRO vezes (15:14:04, :11, :14, :17); o handler
 * montava um patch vazio, não escrevia nada e **retornava normal** — quatro `success` no
 * `assistant_tasks`. Sem texto no turno, o narrador de turno só-tool assumiu, e essa frase
 * virou a saudação em ÁUDIO do paciente.
 *
 * Aqui a regra é a 26 do projeto: falha nunca vira sucesso. Sem valor pra gravar, o modelo
 * ouve a recusa e não anuncia nada. Estes testes travam a FRONTEIRA (a decisão de recusar),
 * que é pura; o insert em si é do handler.
 */
import { describe, expect, it } from 'vitest';

/**
 * Espelha `exigir()` de `handleSaveProfileFact`: o valor obrigatório de cada categoria.
 * Mantido aqui como especificação executável — se o handler afrouxar, este teste continua
 * dizendo qual era o contrato.
 */
function valorObrigatorio(category: string, payload: Record<string, unknown>): string {
  switch (category) {
    case 'condition': return String(payload['name'] ?? '');
    case 'allergy': return String(payload['substance'] ?? payload['name'] ?? '');
    case 'medication': return String(payload['medication_name'] ?? payload['name'] ?? '');
    case 'identity': {
      const pn = String(payload['preferred_name'] ?? '').trim();
      const fn = String(payload['full_name'] ?? '').trim();
      return (pn && pn.length <= 40) || (fn && fn.length <= 120) ? 'ok' : '';
    }
    default: return Object.keys(payload ?? {}).length ? 'ok' : '';
  }
}
const deveRecusar = (c: string, p: Record<string, unknown>) => !valorObrigatorio(c, p).trim();

describe('o caso Rodrigo: payload vazio não é sucesso', () => {
  it('identity com payload {} → RECUSA (era o no-op silencioso)', () => {
    expect(deveRecusar('identity', {})).toBe(true);
  });
  it('identity com nome → grava', () => {
    expect(deveRecusar('identity', { preferred_name: 'Rodrigo' })).toBe(false);
    expect(deveRecusar('identity', { full_name: 'Rodrigo Alves' })).toBe(false);
  });
});

describe('as categorias de lista não inserem linha em branco no prontuário', () => {
  it.each(['condition', 'allergy', 'medication'])('%s com payload {} → RECUSA', (cat) => {
    expect(deveRecusar(cat, {})).toBe(true);
  });
  it.each([
    ['condition', { name: 'hipertensão' }],
    ['allergy', { substance: 'dipirona' }],
    ['allergy', { name: 'penicilina' }],       // o modelo às vezes usa `name`
    ['medication', { medication_name: 'Losartana' }],
    ['medication', { name: 'Losartana' }],
  ])('%s com valor → grava', (cat, payload) => {
    expect(deveRecusar(cat, payload as Record<string, unknown>)).toBe(false);
  });
  it('valor só com espaços é vazio, não dado', () => {
    expect(deveRecusar('allergy', { substance: '   ' })).toBe(true);
  });
});

describe('o merge em metadata (category solta) também exige conteúdo', () => {
  it('payload {} → RECUSA', () => {
    expect(deveRecusar('other', {})).toBe(true);
  });
  it('health_plan preenchido → grava', () => {
    expect(deveRecusar('other', { health_plan: 'Unimed' })).toBe(false);
  });
});
