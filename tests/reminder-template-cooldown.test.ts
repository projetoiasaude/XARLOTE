import { describe, it, expect } from 'vitest';
import {
  reengageCooldownElapsed,
  reengageIntervalMs,
  localDayKey,
  CRITICAL_TEMPLATE_MIN_GAP_MS,
  COOLDOWN_TOLERANCE_MS,
  nextBlockedStreak,
  shouldPauseUndeliverable,
} from '../apps/api/src/config/template-registry.js';

/**
 * Blinda o cooldown do template de re-engajamento.
 *
 * 🔴 CASO ARTHUR (auditoria 04/08). Ele toma Neblock 5mg (anti-hipertensivo), NUNCA
 * respondeu uma mensagem (`last_active_at` null → janela WABA fechada pra sempre → o
 * template HSM é o ÚNICO canal que resta), e o lembrete dispara todo dia às 10:00Z.
 *
 * Números REAIS do banco em 04/08: 7 dos últimos 16 dias `window_blocked` — 44% de
 * não-entrega de um remédio de pressão. E o alerta que gritaria estava mudo por falta do
 * token do Telegram.
 *
 * A causa não é sorte, é aritmética: `reengageIntervalMs` devolve EXATAMENTE 24h pra
 * crítico, e `users.metadata.reengage_template_at` é gravado no instante do ENVIO
 * (medido em prod: `2026-08-03T10:00:25.120Z`, 25 segundos depois do disparo). No dia
 * seguinte, às 10:00:0X, `agora - carimbo` dá 23h59m3Xs < 24h → BLOQUEADO. Dois dias
 * depois passa, recarimba, e alterna pra sempre.
 */

const TZ = 'America/Sao_Paulo';
const HORA = 3_600_000;
const DIA = 24 * HORA;

describe('🔴 a alternância do Arthur: 24h cravadas contra carimbo que anda', () => {
  // O carimbo REAL lido de produção, e o disparo real do lembrete no dia seguinte.
  const CARIMBO_REAL = Date.parse('2026-08-03T10:00:25.120Z');
  const DISPARO_DIA_SEGUINTE = Date.parse('2026-08-04T10:00:03.000Z');

  it('a comparação crua em ms BLOQUEIA o remédio no dia seguinte (o bug)', () => {
    const cooldown = reengageIntervalMs(30 * DIA, true); // mudo há 30 dias, crítico
    expect(cooldown).toBe(DIA);
    // 23h59m37s — falta pouco mais de 20 segundos. É este `>=` que quebrava.
    expect(DISPARO_DIA_SEGUINTE - CARIMBO_REAL >= cooldown).toBe(false);
  });

  it('✅ por DIA LOCAL o remédio passa — é outro dia do calendário', () => {
    expect(reengageCooldownElapsed({
      nowMs: DISPARO_DIA_SEGUINTE,
      lastTemplateMs: CARIMBO_REAL,
      cooldownMs: reengageIntervalMs(30 * DIA, true),
      critical: true,
      timeZone: TZ,
    })).toBe(true);
  });

  it('✅ 14 dias seguidos de lembrete diário entregam TODOS (era 1 dia sim, 1 não)', () => {
    let carimbo = 0;
    const entregues: string[] = [];
    const bloqueados: string[] = [];
    for (let dia = 0; dia < 14; dia += 1) {
      // Disparo às 10:00 + jitter crescente; o carimbo sempre 25s depois do envio.
      const disparo = Date.parse('2026-08-04T10:00:00Z') + dia * DIA + dia * 1_500;
      const liberou = reengageCooldownElapsed({
        nowMs: disparo,
        lastTemplateMs: carimbo,
        cooldownMs: reengageIntervalMs(30 * DIA, true),
        critical: true,
        timeZone: TZ,
      });
      if (liberou) { entregues.push(localDayKey(disparo, TZ)); carimbo = disparo + 25_000; }
      else bloqueados.push(localDayKey(disparo, TZ));
    }
    expect(bloqueados).toEqual([]);
    expect(entregues).toHaveLength(14);
  });

  it('a comparação crua, no mesmo cenário, perde quase metade dos dias', () => {
    let carimbo = 0;
    let bloqueados = 0;
    for (let dia = 0; dia < 14; dia += 1) {
      const disparo = Date.parse('2026-08-04T10:00:00Z') + dia * DIA + dia * 1_500;
      if (carimbo && disparo - carimbo < DIA) bloqueados += 1;
      else carimbo = disparo + 25_000;
    }
    expect(bloqueados).toBeGreaterThan(5); // a perda que estava em produção
  });
});

describe('reengageCooldownElapsed — crítico', () => {
  const base = Date.parse('2026-08-04T13:00:00Z'); // 10:00 BRT

  it('nunca mandou template antes → libera', () => {
    expect(reengageCooldownElapsed({ nowMs: base, lastTemplateMs: 0, cooldownMs: DIA, critical: true, timeZone: TZ })).toBe(true);
  });

  it('mesmo dia local → NÃO libera (o teto de 1×/dia continua valendo)', () => {
    const maisTarde = base + 8 * HORA; // 18:00 BRT, mesmo dia
    expect(localDayKey(base, TZ)).toBe(localDayKey(maisTarde, TZ));
    expect(reengageCooldownElapsed({ nowMs: maisTarde, lastTemplateMs: base, cooldownMs: DIA, critical: true, timeZone: TZ })).toBe(false);
  });

  it('dia diferente mas menos de 6h de intervalo → NÃO libera (piso absoluto)', () => {
    // 23:50 BRT e 00:10 BRT: dias diferentes, 20 minutos de distância.
    const noite = Date.parse('2026-08-04T02:50:00Z');   // 23:50 BRT de 03/08
    const madrugada = Date.parse('2026-08-04T03:10:00Z'); // 00:10 BRT de 04/08
    expect(localDayKey(noite, TZ)).not.toBe(localDayKey(madrugada, TZ));
    expect(madrugada - noite).toBeLessThan(CRITICAL_TEMPLATE_MIN_GAP_MS);
    expect(reengageCooldownElapsed({ nowMs: madrugada, lastTemplateMs: noite, cooldownMs: DIA, critical: true, timeZone: TZ })).toBe(false);
  });

  it('o fuso é o DO PACIENTE — o mesmo instante pode ser outro dia', () => {
    const t = Date.parse('2026-08-04T02:00:00Z'); // 23:00 BRT de 03/08 · 02:00 em Lisboa
    expect(localDayKey(t, 'America/Sao_Paulo')).toBe('2026-08-03');
    expect(localDayKey(t, 'Europe/Lisbon')).toBe('2026-08-04');
  });

  it('fuso inválido não explode — cai em São Paulo', () => {
    expect(localDayKey(Date.parse('2026-08-04T13:00:00Z'), 'Marte/Olympus')).toBe('2026-08-04');
  });
});

describe('reengageCooldownElapsed — não-crítico mantém o back-off por silêncio', () => {
  const base = Date.parse('2026-08-04T13:00:00Z');

  it('mudo há 5 dias → back-off de 48h; 24h depois ainda não libera', () => {
    const cooldown = reengageIntervalMs(5 * DIA, false);
    expect(cooldown).toBe(48 * HORA);
    expect(reengageCooldownElapsed({ nowMs: base + DIA, lastTemplateMs: base, cooldownMs: cooldown, critical: false, timeZone: TZ })).toBe(false);
    expect(reengageCooldownElapsed({ nowMs: base + 2 * DIA, lastTemplateMs: base, cooldownMs: cooldown, critical: false, timeZone: TZ })).toBe(true);
  });

  it('a tolerância de 5 min mata o "faltou um segundinho" em qualquer cadência', () => {
    const cooldown = 20 * HORA;
    const quase = base + cooldown - 30_000; // 30s a menos
    expect(quase - base >= cooldown).toBe(false);
    expect(reengageCooldownElapsed({ nowMs: quase, lastTemplateMs: base, cooldownMs: cooldown, critical: false, timeZone: TZ })).toBe(true);
  });

  it('mas a tolerância NÃO vira um segundo template no mesmo período', () => {
    const cooldown = 20 * HORA;
    const cedoDemais = base + cooldown - COOLDOWN_TOLERANCE_MS - 60_000;
    expect(reengageCooldownElapsed({ nowMs: cedoDemais, lastTemplateMs: base, cooldownMs: cooldown, critical: false, timeZone: TZ })).toBe(false);
  });
});

/**
 * 🔴 CASO ANTÔNIA (auditoria 04/08) — pausa por indeliverabilidade crônica.
 *
 * Ela tem 8 lembretes de hidratação por dia e está muda desde 30/07. Em 04/08 todos os 8
 * apareciam `window_blocked` no banco, todos os dias, indefinidamente — a 1000 pacientes
 * mudos são ~8.000 tentativas/dia que a Meta rejeitaria de qualquer forma, mais 8 linhas
 * de log idênticas por paciente por dia.
 *
 * A pausa suspende a TENTATIVA, nunca o lembrete: o status segue `pending` e a condição é
 * reavaliada a cada tick, então a retomada é automática no instante em que ela responder.
 */
describe('nextBlockedStreak — o contador anda 1×/dia, não 1×/ocorrência', () => {
  const TZ_ = 'America/Sao_Paulo';
  const d = (iso: string) => Date.parse(iso);

  it('primeira não-entrega da vida: streak 1, e é a primeira do dia', () => {
    const r = nextBlockedStreak({}, d('2026-08-04T13:00:00Z'), TZ_);
    expect(r).toEqual({ day: '2026-08-04', streak: 1, firstToday: true });
  });

  it('🔴 as outras 7 ocorrências do MESMO dia não andam nem relogam', () => {
    const prev = { day: '2026-08-04', streak: 3 };
    for (const hora of ['14:00', '16:30', '19:00', '21:30', '00:00']) {
      const r = nextBlockedStreak(prev, d(`2026-08-04T${hora === '00:00' ? '23:00' : hora}:00Z`), TZ_);
      expect(r.streak).toBe(3);
      expect(r.firstToday).toBe(false);
    }
  });

  it('dia seguinte: streak +1 e volta a poder logar', () => {
    const r = nextBlockedStreak({ day: '2026-08-04', streak: 3 }, d('2026-08-05T13:00:00Z'), TZ_);
    expect(r).toEqual({ day: '2026-08-05', streak: 4, firstToday: true });
  });

  it('buraco na sequência (entregou no meio) REINICIA em 1', () => {
    const r = nextBlockedStreak({ day: '2026-08-01', streak: 6 }, d('2026-08-04T13:00:00Z'), TZ_);
    expect(r.streak).toBe(1);
  });

  it('as ocorrências REAIS da Antônia por 7 dias: streak 7 e 7 logs, não 49', () => {
    // Horários exatos lidos do banco em 04/08 (UTC) — de 08:00 a 23:00 BRT, 2h30 apart.
    const HORAS_UTC = ['11:00', '13:30', '16:00', '18:30', '21:00', '23:30'];
    const OFFSET_23H_BRT = 15 * 3_600_000; // 02:00Z do dia seguinte = 23:00 BRT do MESMO dia local
    let prev: { day?: string; streak?: number } = {};
    let logs = 0;
    const diasVistos = new Set<string>();
    for (let dia = 0; dia < 7; dia += 1) {
      const base = d('2026-08-04T11:00:00Z') + dia * 86_400_000;
      const instantes = [...HORAS_UTC.map((h) => d(`2026-08-04T${h}:00Z`) + dia * 86_400_000), base + OFFSET_23H_BRT];
      for (const t of instantes) {
        const r = nextBlockedStreak(prev, t, TZ_);
        if (r.firstToday) logs += 1;
        diasVistos.add(r.day);
        prev = { day: r.day, streak: r.streak };
      }
    }
    expect(diasVistos.size).toBe(7); // os 7 disparos do dia caem TODOS no mesmo dia local
    expect(prev.streak).toBe(7);
    expect(logs).toBe(7); // era 1 log por ocorrência: 49
  });
});

describe('shouldPauseUndeliverable', () => {
  const base = { recurring: true, critical: false, pauseAfterDays: 7 };

  it('🔴 hidratação recorrente muda há 7 dias → PAUSA', () => {
    expect(shouldPauseUndeliverable({ ...base, blockedStreakDays: 7 })).toBe(true);
    expect(shouldPauseUndeliverable({ ...base, blockedStreakDays: 30 })).toBe(true);
  });

  it('antes de 7 dias segue tentando', () => {
    expect(shouldPauseUndeliverable({ ...base, blockedStreakDays: 6 })).toBe(false);
    expect(shouldPauseUndeliverable({ ...base, blockedStreakDays: 0 })).toBe(false);
  });

  it('🔴 MEDICAÇÃO/CONSULTA nunca pausa, nem depois de 100 dias', () => {
    expect(shouldPauseUndeliverable({ ...base, critical: true, blockedStreakDays: 100 })).toBe(false);
  });

  it('one-shot nunca pausa (tem o próprio resgate de re-tentativa)', () => {
    expect(shouldPauseUndeliverable({ ...base, recurring: false, blockedStreakDays: 100 })).toBe(false);
  });

  it('entrega zera o contador → não pausa mais (a retomada não depende de "despausar")', () => {
    expect(shouldPauseUndeliverable({ ...base, blockedStreakDays: 0 })).toBe(false);
  });
});
