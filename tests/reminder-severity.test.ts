import { describe, it, expect } from 'vitest';
import {
  isCriticalReminderType,
  isLowUrgencyReminderType,
  reminderTemplatePriority,
} from '../apps/api/src/config/template-registry.js';

/**
 * Blinda a severidade POR CONSEQUÊNCIA e a definição única de "crítico".
 *
 * No fim de semana 01-03/08 houve 24 warns de lembrete não entregue, quase todos de ÁGUA —
 * afogando o único que importava (o anti-hipertensivo do Arthur). O nível era escolhido pelo
 * caminho de código ("uma entrega falhou"), não pela consequência ("um paciente perdeu a
 * dose"). E "crítico" existia em QUATRO codificações paralelas que podiam divergir.
 */
describe('isCriticalReminderType — remédio e consulta', () => {
  it('medication e appointment são críticos: não-entrega tem consequência clínica', () => {
    expect(isCriticalReminderType('medication')).toBe(true);
    expect(isCriticalReminderType('appointment')).toBe(true);
  });

  it('água, exercício, custom e sono NÃO são críticos', () => {
    for (const t of ['hydration', 'exercise', 'custom', 'sleep']) {
      expect(isCriticalReminderType(t)).toBe(false);
    }
  });

  it('tipo desconhecido/ausente não é crítico (falha pro lado silencioso, não pro alarme)', () => {
    expect(isCriticalReminderType(undefined)).toBe(false);
    expect(isCriticalReminderType(null)).toBe(false);
    expect(isCriticalReminderType('tipo_que_nao_existe')).toBe(false);
  });
});

describe('isLowUrgencyReminderType — o degrau de baixo, que NÃO é o complemento do crítico', () => {
  it('água, exercício e custom são baixa urgência', () => {
    for (const t of ['hydration', 'exercise', 'custom']) {
      expect(isLowUrgencyReminderType(t)).toBe(true);
    }
  });

  it('🔴 sono NÃO é crítico E NÃO é baixa urgência — o degrau do meio existe', () => {
    // Este é o motivo de haver dois limiares em vez de um booleano: `sleep` não isenta do
    // cap de medicação, mas o push dele também não é cortado. Colapsar os dois numa única
    // negação (`!isCritical`) faria o lembrete de sono perder o push.
    expect(isCriticalReminderType('sleep')).toBe(false);
    expect(isLowUrgencyReminderType('sleep')).toBe(false);
  });

  it('medicação e consulta nunca são baixa urgência', () => {
    expect(isLowUrgencyReminderType('medication')).toBe(false);
    expect(isLowUrgencyReminderType('appointment')).toBe(false);
  });
});

describe('os dois limiares derivam da MESMA prioridade (uma fonte só)', () => {
  it('crítico ⇔ prioridade ≥ a de appointment; baixa urgência ⇔ prioridade 0', () => {
    for (const t of ['medication', 'appointment', 'sleep', 'hydration', 'exercise', 'custom', 'zzz']) {
      expect(isCriticalReminderType(t)).toBe(reminderTemplatePriority(t) >= reminderTemplatePriority('appointment'));
      expect(isLowUrgencyReminderType(t)).toBe(reminderTemplatePriority(t) === 0);
    }
  });

  it('nenhum tipo é crítico e baixa urgência ao mesmo tempo', () => {
    for (const t of ['medication', 'appointment', 'sleep', 'hydration', 'exercise', 'custom']) {
      expect(isCriticalReminderType(t) && isLowUrgencyReminderType(t)).toBe(false);
    }
  });
});

describe('o nível do log que o dispatcher escolhe', () => {
  // Espelha a expressão do worker: `isCritical ? 'warn' : 'info'`.
  const nivel = (type: string) => (isCriticalReminderType(type) ? 'warn' : 'info');

  it('remédio não entregue é warn; água não entregue é info (o caso do fim de semana)', () => {
    expect(nivel('medication')).toBe('warn');   // Neblock 5mg do Arthur
    expect(nivel('appointment')).toBe('warn');
    expect(nivel('hydration')).toBe('info');    // os 20+ warns de água
    expect(nivel('exercise')).toBe('info');
  });
});
