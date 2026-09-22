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
 * TRABALHO EM VOO — o que o `app.close()` sozinho NÃO espera.
 *
 * O turno do paciente roda em `setImmediate` DEPOIS de o webhook já ter respondido 200
 * (é o que mantém o webhook rápido). Só que o shutdown drenava apenas requests HTTP —
 * e o request já tinha terminado. Resultado: todo `railway up` matava os turnos em
 * andamento, o zpro não reentrega (recebeu 200) e o paciente ficava mudo. Um deploy no
 * meio de um turno de emergência é o pior caso concreto disso.
 *
 * Aqui só existe o registro; quem espera é o disposer em `server.ts`.
 */
const emVoo = new Set<Promise<unknown>>();

/** Acompanha uma promessa até ela assentar. Devolve a MESMA promessa. */
export function acompanharEmVoo<T>(p: Promise<T>): Promise<T> {
  emVoo.add(p);
  /**
   * ⚠️ `then` COM OS DOIS BRAÇOS, e não `p.finally(...)`.
   *
   * `finally` devolve uma promessa DERIVADA que rejeita junto com `p` — e ninguém a
   * trata. No Node 20 uma rejeição não tratada DERRUBA O PROCESSO: cada turno que
   * falhasse mataria a API inteira. Peguei escrevendo o teste (`lifecycle-em-voo`),
   * antes de existir em produção.
   *
   * Com os dois braços, a derivada é sempre cumprida (a rejeição fica tratada aqui) e
   * `p` — a que volta pra quem chamou — segue rejeitando normalmente, pro webhook logar
   * e mandar pro Sentry.
   */
  p.then(
    () => { emVoo.delete(p); },
    () => { emVoo.delete(p); },
  );
  return p;
}

export function quantosEmVoo(): number {
  return emVoo.size;
}

/**
 * Espera o que está em voo, com teto. Devolve quantos NÃO terminaram a tempo — número
 * que vale um log: é exatamente a conta de pacientes que podem ter ficado sem resposta.
 */
export async function drenarEmVoo(tetoMs: number): Promise<number> {
  if (emVoo.size === 0) return 0;
  const todos = Promise.allSettled([...emVoo]);
  const estouro = new Promise<'estouro'>((r) => setTimeout(() => r('estouro'), tetoMs).unref?.());
  const quem = await Promise.race([todos.then(() => 'fim' as const), estouro]);
  return quem === 'fim' ? 0 : emVoo.size;
}

/**
 * Instala handlers de SIGTERM/SIGINT pra encerramento limpo (F1.A5).
 * Railway envia SIGTERM em TODO redeploy; sem isto, requests e jobs em voo
 * morrem no meio. Roda os disposers em ordem, com timeout duro de segurança.
 */
/**
 * Rede de segurança do PROCESSO.
 *
 * Não existia nenhuma (auditoria 22/09): no Node 20, uma única rejeição não tratada
 * DERRUBA o processo — e com `restartPolicyMaxRetries = 3` no Railway, três quedas
 * seguidas deixam o serviço parado até alguém perceber. Pior: sem handler, a queda não
 * deixava rastro nem no log nem no Sentry, então o sintoma era "a Xarlote ficou muda".
 *
 * `unhandledRejection` NÃO derruba aqui: quase sempre é um `void algo()` esquecido num
 * caminho lateral, e matar a API por isso troca um bug pequeno por um apagão. Vai pro
 * log como `error` (é o que o detector de anomalia enxerga) e pro Sentry.
 *
 * `uncaughtException` MANTÉM o comportamento padrão de sair: depois dele o estado do
 * processo é suspeito, e seguir rodando é pior que reiniciar. A diferença é que agora
 * ele sai deixando rastro.
 */
export function instalarRedeDeSegurancaDoProcesso(
  app: FastifyInstance,
  aoCapturar?: (err: unknown, ctx: Record<string, unknown>) => void,
): void {
  process.on('unhandledRejection', (motivo) => {
    app.log.error({ err: motivo }, 'unhandledRejection — o processo SEGUE vivo de propósito');
    aoCapturar?.(motivo, { phase: 'unhandledRejection' });
  });

  process.on('uncaughtException', (err) => {
    app.log.error({ err }, 'uncaughtException — encerrando (estado do processo não é confiável)');
    aoCapturar?.(err, { phase: 'uncaughtException' });
    // Dá um instante pro log/Sentry saírem antes de morrer.
    setTimeout(() => process.exit(1), 500).unref();
  });
}

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
