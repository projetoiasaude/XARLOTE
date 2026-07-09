import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  buildTemplatePayload,
  humanizeTemplate,
  templatesEnabled,
  pharmacyColdOpen,
} from '../apps/api/src/config/template-registry.js';

// Limpa as envs que o registry lê, pra cada teste partir de estado conhecido.
const ENV_KEYS = [
  'WHATSAPP_TEMPLATES_ENABLED',
  'ZPRO_TEMPLATE_LANG',
  'ZPRO_TEMPLATE_PHARMACY_QUOTE',
  'ZPRO_TEMPLATE_CLINIC_OUTREACH',
  'ZPRO_TEMPLATE_GENERAL',
  'ZPRO_TEMPLATE_COTACAO_APPROVED',
];
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('templatesEnabled (gate de segurança)', () => {
  it('default é OFF', () => {
    expect(templatesEnabled()).toBe(false);
  });
  it("só liga com exatamente 'true'", () => {
    process.env['WHATSAPP_TEMPLATES_ENABLED'] = 'true';
    expect(templatesEnabled()).toBe(true);
    process.env['WHATSAPP_TEMPLATES_ENABLED'] = '1';
    expect(templatesEnabled()).toBe(false);
    process.env['WHATSAPP_TEMPLATES_ENABLED'] = 'TRUE';
    expect(templatesEnabled()).toBe(false);
  });
});

describe('humanizeTemplate (bate com o corpo aprovado na Meta)', () => {
  it('farmácia: corpo exato aprovado, com item {{1}} e região {{2}}', () => {
    const txt = humanizeTemplate('pharmacy_quote', ['Dipirona 1g (1 caixa)', 'Setor Oeste']);
    expect(txt).toBe(
      'Oi, tudo bem? Você tem Dipirona 1g (1 caixa) disponível? É para entregar Setor Oeste. Consegue me passar o preço e o prazo de entrega, por favor?',
    );
    expect(txt.toLowerCase()).not.toContain('xarlote'); // humanizado: sem auto-apresentação
  });
  it('clínica: corpo exato, {{1}} é a necessidade inteira; NÃO pede região', () => {
    const txt = humanizeTemplate('clinic_outreach', ['uma consulta de cardiologia']);
    expect(txt).toBe(
      'Oi, tudo bem? Aqui é a Xarlote, assistente de saúde. Estou ajudando um paciente que precisa de uma consulta de cardiologia e gostaria de saber o valor e a disponibilidade de horário. Vocês conseguem me ajudar, por favor?',
    );
    expect(txt.toLowerCase()).not.toContain('entregar');
  });
  it('geral (coringa): corpo exato com o assunto {{1}}', () => {
    const txt = humanizeTemplate('general', ['um orçamento de fórmula manipulada']);
    expect(txt).toBe(
      'Oi, tudo bem? Aqui é a Xarlote, assistente de saúde. Estou ajudando um cliente e preciso falar com vocês sobre um orçamento de fórmula manipulada. Vocês conseguem me ajudar com isso? Fico no aguardo, obrigada!',
    );
  });
});

describe('pharmacyColdOpen (cotacao_medicamento ainda pendente → coringa)', () => {
  it('DEFAULT (não aprovado): usa contato_geral com assunto "um orçamento de …"', () => {
    const t = pharmacyColdOpen('Dipirona 1g (1 caixa)', 'Setor Oeste');
    expect(t.key).toBe('general');
    expect(t.variables).toHaveLength(1);
    expect(t.variables[0]).toBe('um orçamento de Dipirona 1g (1 caixa) para entrega na região Setor Oeste');
    // e o payload monta com o template aprovado contato_geral
    expect(buildTemplatePayload(t.key, t.variables).name).toBe('contato_geral');
  });
  it('quando cotacao_medicamento aprovado: usa o dedicado (2 vars)', () => {
    process.env['ZPRO_TEMPLATE_COTACAO_APPROVED'] = 'true';
    const t = pharmacyColdOpen('Dipirona 1g (1 caixa)', 'Setor Oeste');
    expect(t.key).toBe('pharmacy_quote');
    expect(t.variables).toEqual(['Dipirona 1g (1 caixa)', 'Setor Oeste']);
    expect(buildTemplatePayload(t.key, t.variables).name).toBe('cotacao_medicamento_2');
  });
});

describe('buildTemplatePayload', () => {
  it('farmácia: 2 variáveis → payload com nome/idioma default e ordem preservada', () => {
    const p = buildTemplatePayload('pharmacy_quote', ['itens', 'região']);
    expect(p).toEqual({ name: 'cotacao_medicamento_2', language: 'pt_BR', variables: ['itens', 'região'] });
  });
  it('clínica: 1 variável', () => {
    const p = buildTemplatePayload('clinic_outreach', ['dermatologia']);
    expect(p.variables).toEqual(['dermatologia']);
    expect(p.name).toBe('atendimento_clinica');
  });
  it('LANÇA se a contagem de variáveis não bate com a Meta', () => {
    expect(() => buildTemplatePayload('pharmacy_quote', ['só-uma'])).toThrow();
    expect(() => buildTemplatePayload('clinic_outreach', ['a', 'b'])).toThrow();
  });
  it('LANÇA com variável vazia (a Meta rejeita slot em branco)', () => {
    expect(() => buildTemplatePayload('pharmacy_quote', ['itens', '   '])).toThrow();
  });
  it('LIMPA variáveis (trim + colapsa espaços/newlines) antes de enviar', () => {
    const p = buildTemplatePayload('pharmacy_quote', ['  Dipirona   1g \n', ' Setor  Oeste ']);
    expect(p.variables).toEqual(['Dipirona 1g', 'Setor Oeste']);
  });
  it('LIMITA o tamanho da variável (~900 chars, a Meta rejeita gigante)', () => {
    const huge = 'x'.repeat(2000);
    const p = buildTemplatePayload('clinic_outreach', [huge]);
    expect(p.variables[0]!.length).toBe(900);
  });
  it('respeita override de nome e idioma por env', () => {
    process.env['ZPRO_TEMPLATE_PHARMACY_QUOTE'] = 'cotacao_v2';
    process.env['ZPRO_TEMPLATE_LANG'] = 'pt_PT';
    const p = buildTemplatePayload('pharmacy_quote', ['x', 'y']);
    expect(p.name).toBe('cotacao_v2');
    expect(p.language).toBe('pt_PT');
  });
});
