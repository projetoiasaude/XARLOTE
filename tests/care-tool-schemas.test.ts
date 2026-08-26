/**
 * As duas listas de "tools que aceitam alvo" precisam ser a MESMA.
 *
 * O schema em `xarlote-tools.ts` é o que o modelo enxerga; `TOOLS_COM_SUJEITO` é o que o
 * executor honra. Se divergirem, os dois modos de falha são ruins e silenciosos:
 *
 *   • schema TEM e executor NÃO → o modelo preenche `para_quem`, o executor ignora, e a
 *     ação cai no registro do ATOR enquanto a Xarlote anuncia que foi pra outra pessoa;
 *   • executor TEM e schema NÃO → capacidade que existe e ninguém alcança.
 *
 * Nenhum dos dois aparece em teste de unidade das partes. Só aqui.
 */
import { describe, it, expect } from 'vitest';
import { xarloteTools } from '../packages/llm/src/tools/xarlote-tools.js';
import { TOOLS_COM_SUJEITO, aceitaSujeito } from '../packages/shared/src/care-tools.js';

/** Tools cujo schema declara `para_quem`. */
function comParaQuemNoSchema(): string[] {
  return xarloteTools
    .filter((t) => {
      const props = (t.function?.parameters as { properties?: Record<string, unknown> } | undefined)?.properties;
      return Boolean(props && 'para_quem' in props);
    })
    .map((t) => t.function.name)
    .sort();
}

describe('schema e executor falam da mesma lista', () => {
  it('o teste realmente encontra as tools (não passa por não achar nada)', () => {
    expect(xarloteTools.length).toBeGreaterThan(20);
    expect(comParaQuemNoSchema().length).toBeGreaterThan(0);
  });

  it('as duas listas são idênticas', () => {
    expect(comParaQuemNoSchema()).toEqual([...TOOLS_COM_SUJEITO].sort());
  });

  it('e o predicado do executor concorda com o schema, tool a tool', () => {
    for (const t of xarloteTools) {
      const props = (t.function?.parameters as { properties?: Record<string, unknown> } | undefined)?.properties;
      expect(aceitaSujeito(t.function.name)).toBe(Boolean(props && 'para_quem' in props));
    }
  });
});

describe('as tools que falam com terceiros ficam de fora', () => {
  it.each([
    'start_pharmacy_order', 'confirm_order_selection', 'message_supplier', 'cancel_order',
    'start_consultation_search', 'confirm_consultation_selection', 'cancel_consultation',
    'nudge_consultation', 'contact_establishment', 'relay_answer_to_establishment',
    'forward_media_to_establishment', 'expand_pharmacy_search',
  ])('%s não declara `para_quem`', (nome) => {
    const t = xarloteTools.find((x) => x.function.name === nome);
    expect(t, `tool ${nome} não existe mais — revise esta lista`).toBeDefined();
    const props = (t!.function?.parameters as { properties?: Record<string, unknown> }).properties;
    expect(props && 'para_quem' in props).toBe(false);
  });
});

describe('a descrição do argumento ensina o que precisa', () => {
  it('diz pra OMITIR quando é do próprio, e pra PERGUNTAR na dúvida', () => {
    const t = xarloteTools.find((x) => x.function.name === 'create_reminder')!;
    const props = (t.function.parameters as { properties: Record<string, { description?: string }> }).properties;
    const d = props['para_quem']?.description ?? '';
    expect(d).toMatch(/OMITA/);
    expect(d).toMatch(/PERGUNTE/);
  });
});
