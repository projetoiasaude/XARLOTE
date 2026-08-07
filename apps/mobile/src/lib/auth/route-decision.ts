/**
 * Qual porta o app abre — uma função pura, e por um motivo específico.
 *
 * Guarda de rota espalhada em `useEffect` de cada tela é a receita clássica do loop
 * de redirecionamento: a tela A manda pra B, B ainda não sabe que a sessão chegou e
 * manda de volta pra A, e o app pisca pra sempre. Com UMA função decidindo, o loop
 * vira um teste que falha em vez de um bug que o paciente vê.
 *
 * Ordem é lei: nada aparece antes de a sessão ser restaurada; sem sessão só existe
 * login; o cadeado vem ANTES do consentimento (quem pegou o celular alheio não pode
 * nem ler os termos de saúde do dono); e o consentimento vem antes de tudo mais.
 */

export type AuthGate = 'loading' | 'auth' | 'lock' | 'consent' | 'app';

export interface GateInput {
  /** O token store já foi lido do disco? Antes disso não se decide nada. */
  restored: boolean;
  hasSession: boolean;
  /** Ainda falta aceitar a versão corrente do consentimento de saúde. */
  consentRequired: boolean;
  /** O paciente ligou biometria nas configurações. */
  lockEnabled: boolean;
  /**
   * A sessão está destravada AGORA. Nasce `true` logo após o login (acabou de provar
   * quem é por OTP — pedir o dedo em seguida é atrito sem ganho) e `false` a cada
   * arranque frio ou volta do background depois do prazo.
   */
  unlocked: boolean;
}

export function decideGate(s: GateInput): AuthGate {
  if (!s.restored) return 'loading';
  if (!s.hasSession) return 'auth';
  if (s.lockEnabled && !s.unlocked) return 'lock';
  if (s.consentRequired) return 'consent';
  return 'app';
}

/** Rota concreta de cada porta (expo-router). */
export const GATE_ROUTE: Record<Exclude<AuthGate, 'loading'>, string> = {
  auth: '/(auth)/welcome',
  lock: '/lock',
  consent: '/(auth)/consent',
  app: '/',
};

/**
 * Quanto tempo em background até pedir a biometria de novo.
 *
 * Zero seria hostil: trocar de app pra ler o código no WhatsApp — que é EXATAMENTE
 * o fluxo de login — travaria o app na volta. 60s cobre esse ir-e-vir e ainda pega
 * o celular esquecido na mesa.
 */
export const RELOCK_AFTER_MS = 60_000;

export function shouldRelock(backgroundedAtMs: number | null, nowMs: number): boolean {
  if (backgroundedAtMs === null) return false;
  return nowMs - backgroundedAtMs >= RELOCK_AFTER_MS;
}
