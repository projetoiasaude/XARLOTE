/**
 * Telegram alerter — envia alertas críticos pra um channel/chat do fundador.
 *
 * Config via env:
 *   TELEGRAM_BOT_TOKEN — token do bot (BotFather)
 *   TELEGRAM_ALERT_CHAT_ID — chat_id (negativo se é grupo/canal)
 *
 * Throttling: cada (throttleKey) emite no máximo 1 mensagem por minuto.
 * Severity critical sempre passa, ignorando throttle.
 *
 * Falha silenciosa: se token/chat não configurados, só loga e segue.
 */
import { writeLog, writeEvent } from '@iasaude/db';

const lastSentByKey = new Map<string, number>();
const THROTTLE_MS = 60_000;

export interface TelegramAlertOpts {
  title: string;
  body: string;
  severity?: 'info' | 'warn' | 'high' | 'critical';
  throttleKey?: string;
}

export async function sendTelegramAlert(opts: TelegramAlertOpts): Promise<boolean> {
  const token = process.env['TELEGRAM_BOT_TOKEN'];
  const chatId = process.env['TELEGRAM_ALERT_CHAT_ID'];

  if (!token || !chatId) {
    await writeLog('debug', 'telegram', `Telegram não configurado — alerta "${opts.title}" silenciado`, {});
    return false;
  }

  // Throttle (critical pula throttle)
  const sev = opts.severity ?? 'warn';
  if (opts.throttleKey && sev !== 'critical') {
    const now = Date.now();
    const last = lastSentByKey.get(opts.throttleKey) ?? 0;
    if (now - last < THROTTLE_MS) {
      await writeLog('debug', 'telegram', `Alerta throttled: ${opts.throttleKey}`, {});
      return false;
    }
    lastSentByKey.set(opts.throttleKey, now);
  }

  const emoji = sev === 'critical' ? '🆘' : sev === 'high' ? '⚠️' : sev === 'warn' ? '⚠️' : 'ℹ️';
  const text = `${emoji} *${escapeMarkdown(opts.title)}*\n\n${escapeMarkdown(opts.body)}\n\n_Sev: ${sev}_`;

  try {
    const resp = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
      }),
      // 10s timeout
      signal: AbortSignal.timeout(10_000),
    });

    if (!resp.ok) {
      const txt = await resp.text().catch(() => '');
      await writeLog('warn', 'telegram', `Telegram retornou ${resp.status}: ${txt.slice(0, 200)}`, {});
      return false;
    }

    await writeEvent({
      eventName: 'telegram.alert.sent',
      severity: sev === 'critical' ? 'critical' : 'info',
      payload: { title: opts.title, severity: sev, throttle_key: opts.throttleKey },
    });

    return true;
  } catch (err) {
    await writeLog('warn', 'telegram', `Falha ao enviar Telegram: ${String(err).slice(0, 200)}`, {});
    return false;
  }
}

function escapeMarkdown(s: string): string {
  // Telegram Markdown V1 — escape pra evitar quebra de formatação
  return s.replace(/([_*[\]()~`>#+=|{}.!-])/g, '\\$1');
}
