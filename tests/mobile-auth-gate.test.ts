import { describe, it, expect } from 'vitest';
import { decideGate, shouldRelock, RELOCK_AFTER_MS } from '../apps/mobile/src/lib/auth/route-decision.js';
import { resendState, codeSecondsLeft, formatCountdown, OTP_WINDOW_MS } from '../apps/mobile/src/lib/otp-timer.js';

/**
 * A porta que o app abre, e o relógio do código.
 *
 * A guarda de rota é função pura justamente pra que um loop de redirecionamento
 * apareça como teste vermelho e não como tela piscando no celular do paciente.
 */

const BASE = {
  restored: true,
  hasSession: true,
  consentRequired: false,
  lockEnabled: false,
  unlocked: true,
};

describe('decideGate — ordem das portas', () => {
  it('antes de ler o disco não decide nada', () => {
    // Sem isto, app JÁ LOGADO mostra a tela de login por um frame a cada arranque.
    expect(decideGate({ ...BASE, restored: false, hasSession: false })).toBe('loading');
    expect(decideGate({ ...BASE, restored: false, hasSession: true })).toBe('loading');
  });

  it('sem sessão só existe login', () => {
    expect(decideGate({ ...BASE, hasSession: false })).toBe('auth');
  });

  it('o cadeado vem ANTES do consentimento', () => {
    // Quem pegou o celular alheio não pode nem ler os termos de saúde do dono.
    expect(decideGate({ ...BASE, lockEnabled: true, unlocked: false, consentRequired: true })).toBe('lock');
  });

  it('consentimento bloqueia o app, mas só depois de destravado', () => {
    expect(decideGate({ ...BASE, lockEnabled: true, unlocked: true, consentRequired: true })).toBe('consent');
    expect(decideGate({ ...BASE, consentRequired: true })).toBe('consent');
  });

  it('tudo em ordem → app', () => {
    expect(decideGate(BASE)).toBe('app');
    expect(decideGate({ ...BASE, lockEnabled: true, unlocked: true })).toBe('app');
  });

  it('cadeado ligado não trava quem já destravou nesta sessão', () => {
    expect(decideGate({ ...BASE, lockEnabled: true, unlocked: true })).toBe('app');
  });

  it('cadeado DESLIGADO nunca manda pro lock, mesmo com unlocked=false', () => {
    // Guarda contra o estado impossível: sem cadeado, "travado" não existe. Se
    // escapasse, o paciente cairia numa tela de biometria que ele nunca ligou.
    expect(decideGate({ ...BASE, lockEnabled: false, unlocked: false })).toBe('app');
  });

  it('sem sessão ganha de tudo — inclusive de um cadeado remanescente', () => {
    expect(decideGate({ ...BASE, hasSession: false, lockEnabled: true, unlocked: false })).toBe('auth');
  });
});

describe('shouldRelock', () => {
  const AGORA = 1_800_000_000_000;

  it('nunca esteve em background → não trava', () => {
    expect(shouldRelock(null, AGORA)).toBe(false);
  });

  it('ida rápida ao WhatsApp pra copiar o código NÃO re-trava', () => {
    // É literalmente o fluxo de login. Re-travar aqui prenderia o paciente fora.
    expect(shouldRelock(AGORA - 20_000, AGORA)).toBe(false);
  });

  it('celular esquecido na mesa re-trava', () => {
    expect(shouldRelock(AGORA - RELOCK_AFTER_MS - 1, AGORA)).toBe(true);
  });

  it('exatamente no limite já trava (fail-closed)', () => {
    expect(shouldRelock(AGORA - RELOCK_AFTER_MS, AGORA)).toBe(true);
  });
});

describe('resendState — respeita os tetos reais do servidor', () => {
  const T = 1_800_000_000_000;

  it('primeiro envio: 60s de espera antes de poder reenviar', () => {
    const s = resendState([T], T + 10_000);
    expect(s.canResend).toBe(false);
    expect(s.waitS).toBe(50);
    expect(s.remaining).toBe(2);
  });

  it('passado o cooldown, libera', () => {
    const s = resendState([T], T + 61_000);
    expect(s.canResend).toBe(true);
    expect(s.waitS).toBe(0);
  });

  it('no 3º pedido dentro da janela, esgota — reenviar daria 429', () => {
    const s = resendState([T, T + 70_000, T + 140_000], T + 210_000);
    expect(s.exhausted).toBe(true);
    expect(s.canResend).toBe(false);
    expect(s.remaining).toBe(0);
  });

  it('a espera do esgotado conta do pedido MAIS ANTIGO, que é quando abre vaga', () => {
    const agora = T + 210_000;
    const s = resendState([T, T + 70_000, T + 140_000], agora);
    expect(s.waitS).toBe(Math.ceil((OTP_WINDOW_MS - 210_000) / 1000));
  });

  it('pedido velho sai da janela e devolve a vaga', () => {
    const agora = T + OTP_WINDOW_MS + 1000;
    const s = resendState([T, T + 70_000, T + 140_000], agora);
    expect(s.exhausted).toBe(false);
    expect(s.remaining).toBe(1);
    expect(s.canResend).toBe(true);
  });

  it('sem nenhum envio ainda, pode enviar', () => {
    const s = resendState([], T);
    expect(s.canResend).toBe(true);
    expect(s.remaining).toBe(3);
  });
});

describe('relógio do código', () => {
  const T = 1_800_000_000_000;

  it('conta os 5 minutos e para no zero (nunca negativo)', () => {
    expect(codeSecondsLeft(T, 300, T)).toBe(300);
    expect(codeSecondsLeft(T, 300, T + 120_000)).toBe(180);
    expect(codeSecondsLeft(T, 300, T + 400_000)).toBe(0);
  });

  it('formata como relógio', () => {
    expect(formatCountdown(300)).toBe('5:00');
    expect(formatCountdown(65)).toBe('1:05');
    expect(formatCountdown(9)).toBe('0:09');
    expect(formatCountdown(0)).toBe('0:00');
  });
});
