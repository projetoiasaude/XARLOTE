import type { FastifyInstance } from 'fastify';

type Disposer = () => Promise<void> | void;

const disposers: Array<{ name: string; fn: Disposer }> = [];
let shuttingDown = false;

/** Registra um recurso pra ser encerrado no graceful shutdown (na ordem de registro). */
export function onShutdown(name: string, fn: Disposer): void {
  disposers.push({ name, fn });
}

/** True depois que SIGTERM/SIGINT chegou — handlers podem recusar trabalho novo. */
export function isShuttingDown(): boolean {
  return shuttingDown;
}

/**
 * Instala handlers de SIGTERM/SIGINT pra encerramento limpo (F1.A5).
 * Railway envia SIGTERM em TODO redeploy; sem isto, requests e jobs em voo
 * morrem no meio. Roda os disposers em ordem, com timeout duro de segurança.
 */
export function installShutdownHandlers(app: FastifyInstance): void {
  const handle = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info(`🛑 ${signal} recebido — iniciando graceful shutdown…`);

    const hardMs = Number(process.env['SHUTDOWN_TIMEOUT_MS'] ?? 25_000);
    const killer = setTimeout(() => {
      app.log.error(`shutdown excedeu ${hardMs}ms — saindo à força`);
      process.exit(1);
    }, hardMs);
    killer.unref();

    for (const d of disposers) {
      try {
        await d.fn();
        app.log.info(`  ✓ ${d.name}`);
      } catch (err) {
        app.log.error(err, `  ✗ falha ao encerrar ${d.name}`);
      }
    }

    clearTimeout(killer);
    app.log.info('✅ shutdown limpo');
    process.exit(0);
  };

  process.once('SIGTERM', () => void handle('SIGTERM'));
  process.once('SIGINT', () => void handle('SIGINT'));
}
