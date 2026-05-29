import * as Sentry from '@sentry/node';

let enabled = false;

/**
 * Inicializa o Sentry (F1.B1) SE `SENTRY_DSN` estiver setado — caso contrário
 * é no-op (dev/local não precisa). Só captura erros (tracesSampleRate=0, sem
 * APM). PII é raspada em beforeSend (regra LGPD do projeto).
 */
export function initSentry(): void {
  const dsn = process.env['SENTRY_DSN'];
  if (!dsn) return;
  Sentry.init({
    dsn,
    environment: process.env['NODE_ENV'] ?? 'development',
    release: process.env['RAILWAY_GIT_COMMIT_SHA'] || undefined,
    tracesSampleRate: 0,
    sendDefaultPii: false,
    beforeSend(event) {
      // Remove qualquer dado de request potencialmente sensível.
      if (event.request) {
        delete event.request.cookies;
        delete event.request.headers;
        delete event.request.data;
        delete event.request.query_string;
      }
      // Usuário: mantém só id, nunca telefone/email/nome.
      if (event.user) {
        event.user = event.user.id ? { id: String(event.user.id) } : {};
      }
      return event;
    },
  });
  enabled = true;
}

export function isSentryEnabled(): boolean {
  return enabled;
}

const PII_KEYS = /phone|telefone|cpf|address|endereco|lat|lng|latitude|longitude|pix|email|name|nome|token|key|secret|authorization/i;

function redactContext(ctx: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(ctx)) {
    out[k] = PII_KEYS.test(k) ? '[redacted]' : v;
  }
  return out;
}

/** Captura uma exceção com contexto extra (sem PII). No-op se Sentry off. */
export function captureError(err: unknown, context?: Record<string, unknown>): void {
  if (!enabled) return;
  Sentry.captureException(err, (scope) => {
    if (context) scope.setExtras(redactContext(context));
    return scope;
  });
}

/** Garante o flush dos eventos antes de encerrar o processo (graceful shutdown). */
export async function closeSentry(): Promise<void> {
  if (enabled) {
    try {
      await Sentry.close(2000);
    } catch {
      /* ignore */
    }
  }
}
