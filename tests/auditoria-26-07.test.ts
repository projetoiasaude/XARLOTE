/**
 * Auditoria de 26/07/2026 — regressões cobertas por teste.
 *
 * Contexto: varredura do uso real de sexta (24/07) e sábado (25/07) em produção.
 * 50 de 85 mensagens saíram como `window_blocked`; um paciente hipertenso (Neblock 5mg)
 * ficou 2 dias sem NENHUM lembrete; e o fluxo de consulta do Ciro mostrou duas vozes,
 * português quebrado e uma citação atribuída à clínica que ela nunca disse.
 */
import { describe, expect, it } from 'vitest';
import { specialtyPhrase } from '../packages/shared/src/specialty.js';
import { formatSupplierRelayToUser } from '../packages/shared/src/pharmacy.js';
import {
  reengageReasonForReminder,
  reminderTemplatePriority,
  SILENT_ASK_DAYS,
} from '../apps/api/src/config/template-registry.js';

describe('specialtyPhrase — sintagma da especialidade (caso Ciro 25/07)', () => {
  it('profissional ganha artigo: o bug literal "pra ver reumatologista"', () => {
    expect(specialtyPhrase('reumatologista')).toBe('um reumatologista');
    expect(specialtyPhrase('cardiologista')).toBe('um cardiologista');
    expect(specialtyPhrase('ortopedista')).toBe('um ortopedista');
  });

  it('área vira "uma consulta de X"', () => {
    expect(specialtyPhrase('cardiologia')).toBe('uma consulta de cardiologia');
    expect(specialtyPhrase('reumatologia')).toBe('uma consulta de reumatologia');
  });

  it('-atra e -loga são profissionais (psiquiatra, psicóloga)', () => {
    expect(specialtyPhrase('psiquiatra')).toBe('um psiquiatra');
    expect(specialtyPhrase('psicóloga')).toBe('uma psicóloga');
  });

  it('genérico não vira frase — evita "consulta de consulta"', () => {
    expect(specialtyPhrase('consulta')).toBeNull();
    expect(specialtyPhrase('médico')).toBeNull();
    expect(specialtyPhrase('')).toBeNull();
    expect(specialtyPhrase(null)).toBeNull();
    expect(specialtyPhrase(undefined)).toBeNull();
  });

  it('não empilha artigo quando o modelo já mandou o sintagma pronto', () => {
    expect(specialtyPhrase('um ortopedista')).toBe('um ortopedista');
    expect(specialtyPhrase('uma consulta de cardiologia')).toBe('uma consulta de cardiologia');
  });

  it('desconhecido nunca fica sem artigo', () => {
    expect(specialtyPhrase('check-up')).toBe('uma consulta de check-up');
  });
});

describe('formatSupplierRelayToUser — nunca fabricar citação (caso Ciro 25/07)', () => {
  // O texto abaixo é AUTORAL do LLM (arg `question` do request_clarification); a clínica
  // disse apenas "Qual a idade do paciente por favor".
  const llmText = 'A clínica perguntou a idade do paciente. Ciro, qual a sua idade?';

  it('paraphrase:true NÃO usa aspas nem "respondeu:" (não fabrica fala da clínica)', () => {
    const out = formatSupplierRelayToUser('Clínica Navarrete', llmText, { paraphrase: true });
    expect(out).not.toContain('"');
    expect(out).not.toContain('respondeu:');
    expect(out).toContain('qual a sua idade?');
  });

  it('paráfrase menciona o estabelecimento quando o texto não o nomeia', () => {
    const out = formatSupplierRelayToUser('Clínica Navarrete', 'Qual a sua idade?', { paraphrase: true });
    expect(out).toContain('Clínica Navarrete');
  });

  it('não repete o nome quando o texto já o menciona', () => {
    const out = formatSupplierRelayToUser('Drogamaris', 'A Drogamaris quer saber o complemento.', { paraphrase: true });
    expect(out).toBe('A Drogamaris quer saber o complemento.');
  });

  it('default (verbatim) segue citando — texto CRU do estabelecimento', () => {
    const out = formatSupplierRelayToUser('Drogamaris', 'Temos sim, R$ 42,90');
    expect(out).toContain('"Temos sim, R$ 42,90"');
    expect(out).toContain('respondeu');
  });
});

describe('reminderTemplatePriority — quem ganha o único template (casos Arthur/Antônia)', () => {
  it('medicação vence hidratação — o bug do Arthur', () => {
    expect(reminderTemplatePriority('medication')).toBeGreaterThan(reminderTemplatePriority('hydration'));
  });

  it('consulta vence exercício e custom', () => {
    expect(reminderTemplatePriority('appointment')).toBeGreaterThan(reminderTemplatePriority('exercise'));
    expect(reminderTemplatePriority('appointment')).toBeGreaterThan(reminderTemplatePriority('custom'));
  });

  it('tipo desconhecido/nulo tem a menor prioridade (nunca rouba o slot do remédio)', () => {
    expect(reminderTemplatePriority(null)).toBeLessThan(reminderTemplatePriority('medication'));
    expect(reminderTemplatePriority('qualquer-coisa')).toBeLessThan(reminderTemplatePriority('appointment'));
  });
});

describe('reengageReasonForReminder — pedir resposta após 2 dias de silêncio', () => {
  const med = { type: 'medication', title: 'Neblock 5mg' };

  it('paciente recente (< 2 dias) recebe só o lembrete, sem pedido', () => {
    const r = reengageReasonForReminder(med, 'hoje às 7h', 1);
    expect(r).toContain('Neblock 5mg');
    expect(r).not.toMatch(/me responde/i);
  });

  it('mudo há 2+ dias → PEDE resposta e explica o porquê', () => {
    const r = reengageReasonForReminder(med, 'hoje às 7h', SILENT_ASK_DAYS);
    expect(r).toMatch(/me responde aqui quando tomar/i);
    expect(r).toMatch(/tratamento t[áa] em dia/i);
  });

  it('consulta mudo há dias pede confirmação de leitura', () => {
    const r = reengageReasonForReminder({ type: 'appointment', title: 'Dr. Rafael 14h30' }, 'amanhã às 14h30', 5);
    expect(r).toMatch(/me responde aqui/i);
  });

  it('sem silentDays mantém o comportamento antigo (nunca pede)', () => {
    expect(reengageReasonForReminder(med, 'hoje às 7h')).not.toMatch(/me responde/i);
  });

  it('resultado é UMA linha (a Meta rejeita quebra de linha na variável)', () => {
    const r = reengageReasonForReminder(med, 'hoje às 7h', 9);
    expect(r).not.toMatch(/[\r\n\t]/);
    expect(r.length).toBeLessThanOrEqual(300);
  });

  it('título que é FRASE DE AÇÃO não vira "tomar o seu Passar remédio" (caso Antônia)', () => {
    const r = reengageReasonForReminder({ type: 'medication', title: 'Passar remédio nas sobrancelhas' }, 'hoje às 15h', 3);
    expect(r).toContain('Passar remédio nas sobrancelhas');
    expect(r).not.toMatch(/tomar o seu Passar/i);
  });
});
