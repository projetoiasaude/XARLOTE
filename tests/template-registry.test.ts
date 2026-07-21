import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  buildTemplatePayload,
  humanizeTemplate,
  templatesEnabled,
  pharmacyColdOpen,
  reengageTemplateEnabled,
  buildReengageTemplate,
  reengageReasonForReminder,
  REENGAGE_REASON_SILENT,
  reengageIntervalMs,
} from '../apps/api/src/config/template-registry.js';

// Limpa as envs que o registry lê, pra cada teste partir de estado conhecido.
const ENV_KEYS = [
  'WHATSAPP_TEMPLATES_ENABLED',
  'ZPRO_TEMPLATE_LANG',
  'ZPRO_TEMPLATE_PHARMACY_QUOTE',
  'ZPRO_TEMPLATE_CLINIC_OUTREACH',
  'ZPRO_TEMPLATE_GENERAL',
  'ZPRO_TEMPLATE_COTACAO_APPROVED',
  'ZPRO_TEMPLATE_REENGAGE_APPROVED',
  'ZPRO_TEMPLATE_REENGAGE',
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

// ─── Re-engajamento do PACIENTE (reengajamento_lembrete) — 2 variáveis ───────
// Corpo APROVADO na Meta (não alterar sem reaprovar):
//   Oi, {{1}}! Aqui é a Xarlote,\n\n{{2}}\n\nTô por aqui com você pro que precisar, é só
//   me responder nesta conversa.
describe('reengajamento_lembrete (patient-facing, 2 vars)', () => {
  it('gate default é OFF; liga só com a env exatamente "true"', () => {
    expect(reengageTemplateEnabled()).toBe(false);
    process.env['ZPRO_TEMPLATE_REENGAGE_APPROVED'] = 'True';
    expect(reengageTemplateEnabled()).toBe(false); // case-sensitive de propósito
    process.env['ZPRO_TEMPLATE_REENGAGE_APPROVED'] = 'true';
    expect(reengageTemplateEnabled()).toBe(true);
  });

  it('monta 2 variáveis (nome + motivo) e o corpo aprovado', () => {
    const t = buildReengageTemplate('Dona Maria', 'Passei só pra te lembrar de tomar o seu Puran T4 hoje às 8h, em jejum. Não vale esquecer, tá?');
    expect(t.name).toBe('lembrete_compromisso'); // template ATIVO na Meta (não reengajamento_lembrete)
    expect(t.variables).toHaveLength(2);
    expect(t.variables[0]).toBe('Dona Maria');
    expect(t.variables[1]).toContain('Puran T4');
    expect(t.text).toBe(
      'Oii, Dona Maria! Aqui é a Xarlote,\n\n' +
      'Passei só pra te lembrar de tomar o seu Puran T4 hoje às 8h, em jejum. Não vale esquecer, tá?\n\n' +
      'Tô por aqui com você pro que precisar, é só me responder nesta conversa. 💜',
    );
  });

  it('SANITIZA as variáveis — a Meta rejeita parâmetro com \\n/\\t/espaço duplo', () => {
    const t = buildReengageTemplate('  Ana\nPaula  ', 'Linha 1\n\nLinha 2\tcom tab');
    expect(t.variables[0]).toBe('Ana Paula');
    expect(t.variables[1]).toBe('Linha 1 Linha 2 com tab');
    for (const v of t.variables) expect(v).not.toMatch(/[\r\n\t]|\s{2,}/);
  });

  it('nome do template sobreponível por env (se a Meta aprovou com outro nome)', () => {
    process.env['ZPRO_TEMPLATE_REENGAGE'] = 'reativacao_paciente';
    expect(buildReengageTemplate('Ana', 'oi').name).toBe('reativacao_paciente');
  });

  it('motivo vazio cai na reativação pura (nunca manda {{2}} em branco)', () => {
    const t = buildReengageTemplate('Ana', '   ');
    expect(t.variables[1]).toBe(REENGAGE_REASON_SILENT);
  });

  it('motivo por tipo de lembrete segue o estilo aprovado (formato de rótulo)', () => {
    expect(reengageReasonForReminder({ type: 'medication', title: 'Neblock 5mg' }, 'hoje às 7h'))
      .toBe('Passei pra te lembrar do seu remédio hoje às 7h: Neblock 5mg. Não vale esquecer, tá?');
    expect(reengageReasonForReminder({ type: 'appointment', title: 'Consulta Dr. Ferdinando' }, 'amanhã às 16h30'))
      .toBe('Passando pra lembrar do seu compromisso amanhã às 16h30: Consulta Dr. Ferdinando.');
    expect(reengageReasonForReminder({ type: 'custom', title: 'Beber água' }, null))
      .toBe('Passei pra te lembrar: Beber água.');
  });

  it('título que é FRASE DE AÇÃO não vira "tomar o seu {frase}" robótico (Antônia 20/07)', () => {
    // Incidente ao vivo: "de tomar o seu Passar remédio nas sobrancelhas" — o dois-pontos resolve.
    const r = reengageReasonForReminder({ type: 'medication', title: 'Passar remédio nas sobrancelhas' }, 'hoje às 15h');
    expect(r).toBe('Passei pra te lembrar do seu remédio hoje às 15h: Passar remédio nas sobrancelhas. Não vale esquecer, tá?');
    expect(r).not.toContain('tomar o seu Passar');
  });

  it('lembrete sem título não gera frase quebrada', () => {
    expect(reengageReasonForReminder({ type: 'medication', title: null }, null))
      .toContain('seu lembrete de saúde');
  });
});

// ─── Back-off do template de re-engajamento por tempo de silêncio (auditoria 20/07) ─────────
describe('reengageIntervalMs (back-off do HSM pago por silêncio)', () => {
  const HOUR = 60 * 60_000;
  const DAY = 24 * HOUR;

  it('silêncio < 3 dias → 20h (≈ diário, ainda vale tentar todo dia)', () => {
    expect(reengageIntervalMs(0)).toBe(20 * HOUR);
    expect(reengageIntervalMs(1 * DAY)).toBe(20 * HOUR);
    expect(reengageIntervalMs(2.9 * DAY)).toBe(20 * HOUR);
  });

  it('silêncio 3–7 dias → 48h (a cada 2 dias)', () => {
    expect(reengageIntervalMs(3 * DAY)).toBe(48 * HOUR);
    expect(reengageIntervalMs(6.9 * DAY)).toBe(48 * HOUR);
  });

  it('silêncio 7–14 dias → 72h (a cada 3 dias)', () => {
    expect(reengageIntervalMs(7 * DAY)).toBe(72 * HOUR);
    expect(reengageIntervalMs(13.9 * DAY)).toBe(72 * HOUR);
  });

  it('silêncio > 14 dias → 7 dias (semanal — para de queimar template no vazio)', () => {
    expect(reengageIntervalMs(14 * DAY)).toBe(7 * DAY);
    expect(reengageIntervalMs(40 * DAY)).toBe(7 * DAY);
    expect(reengageIntervalMs(Infinity)).toBe(7 * DAY); // nunca falou por WhatsApp
  });

  it('é monotônico — nunca fica MAIS frequente quanto mais tempo mudo', () => {
    let prev = 0;
    for (const d of [0, 2, 3, 5, 7, 10, 14, 30]) {
      const v = reengageIntervalMs(d * DAY);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });
});
