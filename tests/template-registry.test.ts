import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  buildTemplatePayload,
  humanizeTemplate,
  templatesEnabled,
} from '../apps/api/src/config/template-registry.js';

// Limpa as envs que o registry lê, pra cada teste partir de estado conhecido.
const ENV_KEYS = [
  'WHATSAPP_TEMPLATES_ENABLED',
  'ZPRO_TEMPLATE_LANG',
  'ZPRO_TEMPLATE_PHARMACY_QUOTE',
  'ZPRO_TEMPLATE_CLINIC_OUTREACH',
  'ZPRO_TEMPLATE_GENERAL',
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

describe('humanizeTemplate', () => {
  it('farmácia: insere itens + região e se identifica como Xarlote', () => {
    const txt = humanizeTemplate('pharmacy_quote', ['Dipirona 1g (1 caixa)', 'Setor Oeste']);
    expect(txt).toContain('Xarlote');
    expect(txt).toContain('Dipirona 1g (1 caixa)');
    expect(txt).toContain('Setor Oeste');
  });
  it('clínica: insere a especialidade e NÃO pede região', () => {
    const txt = humanizeTemplate('clinic_outreach', ['cardiologia']);
    expect(txt).toContain('cardiologia');
    expect(txt.toLowerCase()).not.toContain('entregar');
  });
});

describe('buildTemplatePayload', () => {
  it('farmácia: 2 variáveis → payload com nome/idioma default e ordem preservada', () => {
    const p = buildTemplatePayload('pharmacy_quote', ['itens', 'região']);
    expect(p).toEqual({ name: 'cotacao_medicamento', language: 'pt_BR', variables: ['itens', 'região'] });
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
  it('respeita override de nome e idioma por env', () => {
    process.env['ZPRO_TEMPLATE_PHARMACY_QUOTE'] = 'cotacao_v2';
    process.env['ZPRO_TEMPLATE_LANG'] = 'pt_PT';
    const p = buildTemplatePayload('pharmacy_quote', ['x', 'y']);
    expect(p.name).toBe('cotacao_v2');
    expect(p.language).toBe('pt_PT');
  });
});
