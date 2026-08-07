/**
 * Quando o botão "reenviar código" pode aparecer.
 *
 * Isto existe porque o servidor tem tetos REAIS que a tela precisa respeitar antes
 * de bater neles: 3 códigos por 15 minutos e 6 por 24h, por telefone. Um botão que
 * fica clicável até tomar 429 gasta as tentativas do paciente e o deixa 15 minutos
 * de fora do app — sem entender por quê.
 *
 * A regra aqui é deliberadamente mais conservadora que a do servidor (3 na janela,
 * mas exigindo 60s entre um e outro): quem chegar ao limite descobre pela tela, com
 * texto, e não por um erro.
 */

/** Espelha `checkKeyedRateLimit('otp:p15:...', { max: 3, windowS: 15*60 })` na API. */
export const OTP_WINDOW_MS = 15 * 60_000;
export const OTP_MAX_IN_WINDOW = 3;
export const OTP_RESEND_COOLDOWN_MS = 60_000;

export interface ResendState {
  canResend: boolean;
  /** Segundos até liberar. 0 quando já pode (ou quando esgotou de vez). */
  waitS: number;
  /** Estourou o teto da janela — reenviar agora daria 429. */
  exhausted: boolean;
  /** Quantos ainda cabem na janela. */
  remaining: number;
}

/**
 * @param sentAtMs quando cada código foi pedido nesta sessão de login, em ordem
 *                 qualquer (a função ordena o que importa).
 */
export function resendState(sentAtMs: readonly number[], nowMs: number): ResendState {
  const naJanela = sentAtMs.filter((t) => nowMs - t < OTP_WINDOW_MS);
  const remaining = Math.max(0, OTP_MAX_IN_WINDOW - naJanela.length);

  if (remaining === 0) {
    // Espera até o pedido MAIS ANTIGO sair da janela — é quando abre uma vaga.
    const maisAntigo = Math.min(...naJanela);
    return {
      canResend: false,
      waitS: Math.ceil((OTP_WINDOW_MS - (nowMs - maisAntigo)) / 1000),
      exhausted: true,
      remaining: 0,
    };
  }

  const ultimo = sentAtMs.length ? Math.max(...sentAtMs) : null;
  const desdeUltimo = ultimo === null ? Infinity : nowMs - ultimo;
  if (desdeUltimo < OTP_RESEND_COOLDOWN_MS) {
    return {
      canResend: false,
      waitS: Math.ceil((OTP_RESEND_COOLDOWN_MS - desdeUltimo) / 1000),
      exhausted: false,
      remaining,
    };
  }

  return { canResend: true, waitS: 0, exhausted: false, remaining };
}

/** Segundos até o código atual expirar (o backend dá 5 minutos). */
export function codeSecondsLeft(sentAtMs: number, ttlS: number, nowMs: number): number {
  return Math.max(0, Math.ceil((sentAtMs + ttlS * 1000 - nowMs) / 1000));
}

/** "4:32" — contagem regressiva legível. */
export function formatCountdown(totalS: number): string {
  const m = Math.floor(totalS / 60);
  const s = totalS % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}
