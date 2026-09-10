/**
 * As guardas que faltavam entre um lembrete e o paciente — cada uma com o caso REAL que a
 * originou (07→10/09/2026). Ver o cabeçalho de reminder-guards.ts.
 */
import { describe, expect, it } from 'vitest';
import {
  pediuCancelarTudo, ehRruleComListaDeMinutos, agruparDuplicatasDeDisparo,
  shouldPauseRoutineSilent, avisoDePausaPorSilencio, consertarConfusiveis, ROUTINE_SILENT_PAUSE_DAYS,
} from '../packages/shared/src/reminder-guards.js';

describe('1. cancelar TUDO só com a fala do paciente', () => {
  it.each([
    'cancela todos os meus lembretes',
    'pode apagar tudo',
    'para de me lembrar de tudo',
    'tira todos os lembretes',
    'não quero mais nenhum lembrete',
    'cancela geral',
    'Desativa todos, por favor',
  ])('"%s" → pediu todos', (t) => expect(pediuCancelarTudo(t)).toBe(true));

  it.each([
    'Tenho de tomar 12 comprimidos, sendo um às 20 e outro às 8h ou seja de 12 em 12 horas por 6 dias', // o caso real de 08/09
    'Tomar esse as 11:30 antes do almoço e jantar às 20h por 45 dias',                                     // o caso real de 09/09
    'me lembra todo dia às 8h',        // "todo dia" é agenda, não "todos"
    'todos os dias às 20h',
    'cancela o da água',               // um grupo, não todos
    'isso',
    'Sim',
    'Tomei',
    '',
  ])('"%s" → NÃO pediu todos', (t) => expect(pediuCancelarTudo(t)).toBe(false));
  it('null/undefined não é pedido', () => {
    expect(pediuCancelarTudo(null)).toBe(false);
    expect(pediuCancelarTudo(undefined)).toBe(false);
  });
});

describe('2. dois minutos diferentes não cabem num rrule', () => {
  it('o rrule real da Domperidona (09/09) é lista de minutos', () => {
    expect(ehRruleComListaDeMinutos('FREQ=DAILY;BYHOUR=11,20;BYMINUTE=30,0')).toBe(true);
  });
  it('lista só em BYHOUR (mesmo minuto) não é', () => {
    expect(ehRruleComListaDeMinutos('FREQ=DAILY;BYHOUR=8,20;BYMINUTE=0')).toBe(false);
    expect(ehRruleComListaDeMinutos('FREQ=DAILY;BYHOUR=13;BYMINUTE=30')).toBe(false);
    expect(ehRruleComListaDeMinutos(null)).toBe(false);
  });
});

describe('3. mesmo paciente + mesmo título + mesmo minuto = uma mensagem', () => {
  const G = 'glauber';
  const as20 = '2026-09-08T23:00:00.000Z'; // 20:00 BRT
  it('as três Nimesulidas de 08/09: duas são duplicatas da mais antiga', () => {
    const due = [
      { id: 'a', user_id: G, title: 'Nimesulida 100mg', next_run_at: as20, created_at: '2026-09-08T19:18:34Z' },
      { id: 'c', user_id: G, title: 'Nimesulida 100mg', next_run_at: as20, created_at: '2026-09-08T19:20:41Z' },
      { id: 'b', user_id: G, title: 'nimesulida 100mg', next_run_at: '2026-09-08T23:00:20.000Z', created_at: '2026-09-08T19:20:38Z' },
    ];
    const d = agruparDuplicatasDeDisparo(due);
    expect(d.get('a')).toBeUndefined();   // dono = mais antigo
    expect(d.get('b')).toBe('a');         // maiúscula/minúscula e segundos não separam
    expect(d.get('c')).toBe('a');
  });
  it('títulos diferentes NÃO se fundem — "Venlafaxina" e "(reforço 21h30)" são desenho', () => {
    const due = [
      { id: 'v', user_id: 'r', title: 'Venlafaxina', next_run_at: '2026-09-09T00:00:00Z' },
      { id: 'r1', user_id: 'r', title: 'Venlafaxina (reforço 21h30)', next_run_at: '2026-09-09T00:00:00Z' },
    ];
    expect(agruparDuplicatasDeDisparo(due).size).toBe(0);
  });
  it('mesmo título em minutos diferentes NÃO se funde — é o "almoço e jantar" certo', () => {
    const due = [
      { id: 'x', user_id: G, title: 'Domperidona 10mg', next_run_at: '2026-09-10T14:30:00Z' },
      { id: 'y', user_id: G, title: 'Domperidona 10mg', next_run_at: '2026-09-10T23:00:00Z' },
    ];
    expect(agruparDuplicatasDeDisparo(due).size).toBe(0);
  });
  it('pacientes diferentes nunca se fundem', () => {
    const due = [
      { id: '1', user_id: 'a', title: 'Creatina', next_run_at: as20 },
      { id: '2', user_id: 'b', title: 'Creatina', next_run_at: as20 },
    ];
    expect(agruparDuplicatasDeDisparo(due).size).toBe(0);
  });
});

describe('4. rotina pausa quando a pessoa some; remédio nunca', () => {
  it('Ciro: creatina recorrente, mudo há 8 dias → pausa', () => {
    expect(shouldPauseRoutineSilent({ recurring: true, critical: false, silentDays: 8 })).toBe(true);
  });
  it('mudo há 3 dias → ainda não', () => {
    expect(shouldPauseRoutineSilent({ recurring: true, critical: false, silentDays: 3 })).toBe(false);
  });
  it('REMÉDIO nunca pausa por silêncio (Venlafaxina, Esomeprazol)', () => {
    expect(shouldPauseRoutineSilent({ recurring: true, critical: true, silentDays: 30 })).toBe(false);
  });
  it('one-shot nunca pausa (tem o próprio caminho de re-tentativa)', () => {
    expect(shouldPauseRoutineSilent({ recurring: false, critical: false, silentDays: 30 })).toBe(false);
  });
  it('nunca falou por WhatsApp (Infinity) = mudo desde sempre → pausa', () => {
    expect(shouldPauseRoutineSilent({ recurring: true, critical: false, silentDays: Infinity })).toBe(true);
  });
  it(`o limiar é ${ROUTINE_SILENT_PAUSE_DAYS} dias, inclusive`, () => {
    expect(shouldPauseRoutineSilent({ recurring: true, critical: false, silentDays: ROUTINE_SILENT_PAUSE_DAYS })).toBe(true);
    expect(shouldPauseRoutineSilent({ recurring: true, critical: false, silentDays: ROUTINE_SILENT_PAUSE_DAYS - 0.1 })).toBe(false);
  });
  it('o aviso cabe numa variável de template (≤300, sem quebra de linha) e diz como voltar', () => {
    const a = avisoDePausaPorSilencio('Creatina e Whey');
    expect(a.length).toBeLessThanOrEqual(300);
    expect(a).not.toMatch(/[\r\n\t]/);
    expect(a).toContain('Creatina e Whey');
    expect(a).toMatch(/mandar um oi/i);
    expect(a).not.toContain('—');
  });
});

describe('5. "Cansei os lembretes" é "Cancelei"', () => {
  it('as duas frases reais (08 e 09/09)', () => {
    expect(consertarConfusiveis('Cansei os lembretes antigos e criei um novo pra Nimesulida 100mg, todo dia às 8h e 20h, por 6 dias. Tá certinho assim?').texto)
      .toContain('Cancelei os lembretes antigos');
    expect(consertarConfusiveis('Cansei os lembretes antigos da Nimesulida e criei um novo pra Domperidona 10mg').texto)
      .toContain('Cancelei os lembretes antigos da Nimesulida');
  });
  it('"cansei" de verdade fica em paz', () => {
    expect(consertarConfusiveis('Cansei de esperar a farmácia responder.').reparos).toEqual([]);
    expect(consertarConfusiveis('Eu cansei, viu?').texto).toBe('Eu cansei, viu?');
  });
});
