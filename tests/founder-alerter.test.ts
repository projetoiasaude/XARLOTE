import { describe, it, expect } from 'vitest';
import { chooseFounderChannel, FOUNDER_TEMPLATE_DAILY_CAP } from '../apps/api/src/handlers/founder-alerter.js';

/**
 * Blinda o canal do alerta ao fundador.
 *
 * 🔴 POR QUE (auditoria 04/08): os 12 pontos de alerta do `anomaly-detector` chamavam só o
 * Telegram, e `TELEGRAM_BOT_TOKEN` nunca foi configurado. Linha real de produção:
 *
 *   debug [telegram] Telegram não configurado — alerta
 *                    "💊 Remédio/consulta NÃO entregue (janela fechada)" silenciado
 *
 * O detector do anti-hipertensivo do Arthur FUNCIONAVA — só não tinha para onde falar.
 *
 * A decisão que este teste protege: o alerta tem que chegar mesmo fora da janela WABA de
 * 24h. Um canal de alerta que só funciona quando o fundador escreveu nas últimas 24h não
 * é um canal de alerta — e o caso em que ele mais precisa do aviso (madrugada, fim de
 * semana) é exatamente o caso em que ele NÃO escreveu recentemente.
 */

const base = {
  windowOpen: false,
  templatesOn: true,
  templatesUsedToday: 0,
  cap: FOUNDER_TEMPLATE_DAILY_CAP,
  severity: 'warn' as const,
};

describe('chooseFounderChannel', () => {
  it('janela aberta → texto livre (é grátis, e o alerta chega igual)', () => {
    expect(chooseFounderChannel({ ...base, windowOpen: true })).toBe('text');
  });

  it('🔴 janela FECHADA → template (é o ponto: o alerta chega de madrugada também)', () => {
    expect(chooseFounderChannel(base)).toBe('template');
  });

  it('template desligado + janela fechada → BLOQUEADO, e isso é registrado como incidente', () => {
    expect(chooseFounderChannel({ ...base, templatesOn: false })).toBe('blocked');
  });

  it('teto diário do caminho pago barra alerta comum', () => {
    expect(chooseFounderChannel({ ...base, templatesUsedToday: FOUNDER_TEMPLATE_DAILY_CAP })).toBe('blocked');
    expect(chooseFounderChannel({ ...base, templatesUsedToday: FOUNDER_TEMPLATE_DAILY_CAP - 1 })).toBe('template');
  });

  it('🔴 `critical` FURA o teto — dose de anti-hipertensivo não entregue vale o template', () => {
    expect(chooseFounderChannel({ ...base, templatesUsedToday: 99, severity: 'critical' })).toBe('template');
  });

  it('mas `critical` não fura template DESLIGADO (kill-switch é kill-switch)', () => {
    expect(chooseFounderChannel({ ...base, templatesOn: false, severity: 'critical' })).toBe('blocked');
  });

  it('janela aberta ignora teto e kill-switch — texto livre não custa nem gasta HSM', () => {
    expect(chooseFounderChannel({ ...base, windowOpen: true, templatesOn: false, templatesUsedToday: 999 })).toBe('text');
  });

  it('o teto é de 8/dia: cobre um incidente real com folga, sem torrar a conta num loop', () => {
    expect(FOUNDER_TEMPLATE_DAILY_CAP).toBe(8);
  });
});
