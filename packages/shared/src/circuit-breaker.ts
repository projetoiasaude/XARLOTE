/**
 * Circuit breaker genérico (F2.F5) — protege chamadas a dependências externas
 * (LLM/OpenRouter, Google Places, TTS, uazapi). Quando uma dependência começa a
 * falhar de forma sustentada, o breaker ABRE e passa a falhar RÁPIDO (sem esperar
 * timeout/retries a cada chamada) por um período de cooldown — depois testa de
 * novo (half-open). Isso evita que uma dependência caída derrube/atrase o app
 * inteiro (ex: OpenRouter fora = cada msg esperaria ~13s de retries; com o breaker
 * aberto, a Xarlote degrada na hora).
 *
 * Estados:
 *   closed   → tudo normal; conta falhas consecutivas.
 *   open     → falha rápido (CircuitOpenError) até passar o cooldown.
 *   half-open→ deixa 1 chamada de teste passar; sucesso fecha, falha reabre.
 *
 * Puro (sem I/O, sem deps) e com clock injetável (`now`) pra ser testável.
 */
export class CircuitOpenError extends Error {
  constructor(public readonly circuit: string) {
    super(`Circuit "${circuit}" está aberto (dependência indisponível)`);
    this.name = 'CircuitOpenError';
  }
}

export type CircuitState = 'closed' | 'open' | 'half-open';

export interface BreakerOptions {
  /** Falhas consecutivas pra abrir o circuito (default 5). */
  failureThreshold?: number;
  /** Tempo aberto antes de testar de novo, em ms (default 30s). */
  cooldownMs?: number;
  /** Sucessos em half-open pra fechar de vez (default 1). */
  successThreshold?: number;
  /** Clock injetável (default Date.now) — facilita testes determinísticos. */
  now?: () => number;
}

export class CircuitBreaker {
  private state: CircuitState = 'closed';
  private failures = 0;
  private successes = 0;
  private openedAt = 0;
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private readonly successThreshold: number;
  private readonly now: () => number;

  constructor(public readonly name: string, opts: BreakerOptions = {}) {
    this.failureThreshold = opts.failureThreshold ?? 5;
    this.cooldownMs = opts.cooldownMs ?? 30_000;
    this.successThreshold = opts.successThreshold ?? 1;
    this.now = opts.now ?? Date.now;
  }

  /** Estado atual, já aplicando a transição lazy open → half-open após o cooldown. */
  getState(): CircuitState {
    if (this.state === 'open' && this.now() - this.openedAt >= this.cooldownMs) {
      this.state = 'half-open';
      this.successes = 0;
    }
    return this.state;
  }

  /**
   * Roda `fn` sob proteção do breaker. Se o circuito estiver aberto, lança
   * CircuitOpenError SEM chamar `fn` (fail-fast). Sucesso/falha atualizam o estado.
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.getState() === 'open') {
      throw new CircuitOpenError(this.name);
    }
    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (err) {
      this.onFailure();
      throw err;
    }
  }

  private onSuccess(): void {
    if (this.state === 'half-open') {
      this.successes++;
      if (this.successes >= this.successThreshold) this.close();
    } else {
      this.failures = 0; // qualquer sucesso zera a contagem de falhas
    }
  }

  private onFailure(): void {
    if (this.state === 'half-open') {
      this.open(); // a chamada de teste falhou → reabre
      return;
    }
    this.failures++;
    if (this.failures >= this.failureThreshold) this.open();
  }

  private open(): void {
    this.state = 'open';
    this.openedAt = this.now();
  }

  private close(): void {
    this.state = 'closed';
    this.failures = 0;
    this.successes = 0;
  }
}

/** Registro (1 por processo) de breakers nomeados — mesmo nome = mesmo breaker. */
const registry = new Map<string, CircuitBreaker>();

export function getBreaker(name: string, opts?: BreakerOptions): CircuitBreaker {
  let b = registry.get(name);
  if (!b) {
    b = new CircuitBreaker(name, opts);
    registry.set(name, b);
  }
  return b;
}
