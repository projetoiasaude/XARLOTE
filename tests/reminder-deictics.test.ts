import { describe, expect, it } from 'vitest';
import { normalizeReminderBody } from '../packages/shared/src/reminder-deictics.js';

// Fusos: America/Sao_Paulo = UTC-3. Autoria e disparo em UTC (como no banco).
const TZ = 'America/Sao_Paulo';

describe('normalizeReminderBody (incidente Elizabeth 09/07 — dêitico congelado na criação)', () => {
  it('CASO ELIZABETH LITERAL: "Amanhã é dia da quimioterapia" criado 08/07, dispara 09/07 7h → "Hoje"', () => {
    const r = normalizeReminderBody('Oi Elizabet! Amanhã é dia da quimioterapia, 7h da manhã. Já se preparou? Tudo vai dar certo 💙', {
      authoredAtIso: '2026-07-08T14:12:52Z', // 11:12 BRT de 08/07
      fireAtIso: '2026-07-09T10:00:00Z',     // 07:00 BRT de 09/07
      timeZone: TZ,
    });
    expect(r.changed).toBe(true);
    expect(r.body).toBe('Oi Elizabet! Hoje é dia da quimioterapia, 7h da manhã. Já se preparou? Tudo vai dar certo 💙');
  });

  it('preserva capitalização e acento ("amanha" sem acento também casa)', () => {
    const r = normalizeReminderBody('amanha é a consulta', {
      authoredAtIso: '2026-07-08T12:00:00Z',
      fireAtIso: '2026-07-09T12:00:00Z',
      timeZone: TZ,
    });
    expect(r.body).toBe('hoje é a consulta');
  });

  it('VÉSPERA legítima com event_at: dispara 1 dia antes do evento → "amanhã" mantido', () => {
    const r = normalizeReminderBody('Amanhã às 16h30 é a consulta com o Dr. Ferdinando!', {
      authoredAtIso: '2026-07-10T12:00:00Z',
      fireAtIso: '2026-07-12T23:00:00Z',   // 20h BRT de 12/07 (véspera)
      eventAtIso: '2026-07-13T19:30:00Z',  // consulta 16h30 BRT de 13/07
      timeZone: TZ,
    });
    expect(r.changed).toBe(false);
    expect(r.body).toContain('Amanhã');
  });

  it('VÉSPERA com event_at mas body escrito errado ("hoje") → corrige pra "amanhã"', () => {
    const r = normalizeReminderBody('Hoje às 16h30 é a consulta!', {
      authoredAtIso: '2026-07-10T12:00:00Z',
      fireAtIso: '2026-07-12T23:00:00Z',
      eventAtIso: '2026-07-13T19:30:00Z',
      timeZone: TZ,
    });
    expect(r.changed).toBe(true);
    expect(r.body).toBe('Amanhã às 16h30 é a consulta!');
  });

  it('RECORRENTE com "hoje" genérico criado dias antes → INTACTO (diff negativo não mexe)', () => {
    // Glauber: "você tomou a creatina hoje?" criado 08/07, dispara todo dia
    const r = normalizeReminderBody('Glauber, você tomou a creatina hoje? Me confirma pra eu ficar tranquila 💪', {
      authoredAtIso: '2026-07-08T12:11:21Z',
      fireAtIso: '2026-07-15T15:00:00Z', // uma semana depois
      timeZone: TZ,
    });
    expect(r.changed).toBe(false);
  });

  it('one-shot de HOJE mesmo ("hoje às 15h" criado de manhã, dispara à tarde) → intacto', () => {
    const r = normalizeReminderBody('Hoje às 15h: pingar o colírio!', {
      authoredAtIso: '2026-07-09T11:00:00Z',
      fireAtIso: '2026-07-09T18:00:00Z',
      timeZone: TZ,
    });
    expect(r.changed).toBe(false);
  });

  it('"depois de amanhã" criado dia D, dispara D+2 → "hoje" (e não corrompe o "amanhã" interno)', () => {
    const r = normalizeReminderBody('Depois de amanhã é o exame de sangue, em jejum!', {
      authoredAtIso: '2026-07-08T12:00:00Z',
      fireAtIso: '2026-07-10T09:00:00Z',
      timeZone: TZ,
    });
    expect(r.changed).toBe(true);
    expect(r.body).toBe('Hoje é o exame de sangue, em jejum!');
  });

  it('"depois de amanhã" disparando D+1 → "amanhã"', () => {
    const r = normalizeReminderBody('depois de amanhã é o exame', {
      authoredAtIso: '2026-07-08T12:00:00Z',
      fireAtIso: '2026-07-09T09:00:00Z',
      timeZone: TZ,
    });
    expect(r.body).toBe('amanhã é o exame');
  });

  it('IDEMPOTENTE: rodar na criação e de novo no disparo não degrada', () => {
    // Criação: "amanhã"@08/07 disparo 09/07 → "hoje"
    const created = normalizeReminderBody('Amanhã é dia da quimioterapia!', {
      authoredAtIso: '2026-07-08T14:12:52Z',
      fireAtIso: '2026-07-09T10:00:00Z',
      timeZone: TZ,
    });
    // Disparo: re-normaliza a row (authored = created_at do banco)
    const dispatched = normalizeReminderBody(created.body, {
      authoredAtIso: '2026-07-08T14:12:52Z',
      fireAtIso: '2026-07-09T10:00:06Z',
      timeZone: TZ,
    });
    expect(dispatched.body).toBe('Hoje é dia da quimioterapia!');
  });

  it('não casa dêitico dentro de palavra ("hojel"/"amanhãzinha" ficam)', () => {
    const r = normalizeReminderBody('amanhãzinha cedo', {
      authoredAtIso: '2026-07-08T12:00:00Z',
      fireAtIso: '2026-07-09T12:00:00Z',
      timeZone: TZ,
    });
    expect(r.changed).toBe(false);
  });

  it('virada de dia no FUSO DO USUÁRIO: criado 23h BRT (=02h UTC do dia seguinte) conta como o dia BRT', () => {
    // 08/07 23:30 BRT = 09/07 02:30 UTC. "amanhã" dito aí = 09/07 BRT.
    const r = normalizeReminderBody('Amanhã tem consulta!', {
      authoredAtIso: '2026-07-09T02:30:00Z',
      fireAtIso: '2026-07-09T12:00:00Z', // 09/07 09:00 BRT — o "amanhã" da autoria
      timeZone: TZ,
    });
    expect(r.body).toBe('Hoje tem consulta!');
  });

  it('datas inválidas / body vazio → fail-open, nada muda', () => {
    expect(normalizeReminderBody('Amanhã é a quimio', {
      authoredAtIso: 'lixo', fireAtIso: '2026-07-09T10:00:00Z', timeZone: TZ,
    }).changed).toBe(false);
    expect(normalizeReminderBody('', {
      authoredAtIso: '2026-07-08T12:00:00Z', fireAtIso: '2026-07-09T10:00:00Z', timeZone: TZ,
    }).changed).toBe(false);
    expect(normalizeReminderBody(null, {
      authoredAtIso: '2026-07-08T12:00:00Z', fireAtIso: '2026-07-09T10:00:00Z', timeZone: TZ,
    }).body).toBe('');
  });

  it('sem timeZone usa America/Sao_Paulo por padrão', () => {
    const r = normalizeReminderBody('Amanhã é dia da quimioterapia!', {
      authoredAtIso: '2026-07-08T14:12:52Z',
      fireAtIso: '2026-07-09T10:00:00Z',
    });
    expect(r.body).toBe('Hoje é dia da quimioterapia!');
  });

  it('múltiplos dêiticos no mesmo body, cada um re-ancorado', () => {
    const r = normalizeReminderBody('Amanhã é a quimio e depois de amanhã a consulta.', {
      authoredAtIso: '2026-07-08T12:00:00Z',
      fireAtIso: '2026-07-09T09:00:00Z',
      timeZone: TZ,
    });
    expect(r.body).toBe('Hoje é a quimio e amanhã a consulta.');
  });
});

describe('normalizeReminderBody — endurecimento do review 10/07', () => {
  const TZ2 = 'America/Sao_Paulo';

  it('#11: event_at com dêiticos MISTOS → ignora event_at e ancora cada um pela autoria (o "hoje" do preparo não vira "amanhã")', () => {
    // Véspera criada e disparada no mesmo dia: "Amanhã consulta / Hoje separa exames"
    const r = normalizeReminderBody('Amanhã às 16h30 é a consulta! Hoje à noite deixa os exames separados 💙', {
      authoredAtIso: '2026-07-12T15:00:00Z',
      fireAtIso: '2026-07-12T23:00:00Z',   // 20h BRT do mesmo dia
      eventAtIso: '2026-07-13T19:30:00Z',  // evento amanhã — NÃO pode reescrever o "Hoje"
      timeZone: TZ2,
    });
    expect(r.changed).toBe(false);
    expect(r.body).toContain('Amanhã às 16h30');
    expect(r.body).toContain('Hoje à noite');
  });

  it('#11: event_at com UM dêitico continua re-ancorando (caso véspera corrigido)', () => {
    const r = normalizeReminderBody('Hoje às 16h30 é a consulta!', {
      authoredAtIso: '2026-07-10T12:00:00Z',
      fireAtIso: '2026-07-12T23:00:00Z',
      eventAtIso: '2026-07-13T19:30:00Z',
      timeZone: TZ2,
    });
    expect(r.body).toBe('Amanhã às 16h30 é a consulta!');
  });

  it('#12: timezone inválido no banco NÃO lança — fail-open com body intacto', () => {
    expect(() => normalizeReminderBody('Amanhã é a quimio', {
      authoredAtIso: '2026-07-08T12:00:00Z',
      fireAtIso: '2026-07-09T10:00:00Z',
      timeZone: 'Brasilia',
    })).not.toThrow();
    const r = normalizeReminderBody('Amanhã é a quimio', {
      authoredAtIso: '2026-07-08T12:00:00Z',
      fireAtIso: '2026-07-09T10:00:00Z',
      timeZone: 'Brasilia',
    });
    expect(r.changed).toBe(false);
  });
});
