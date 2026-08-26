/**
 * care-invite — o código de 6 dígitos que abre um vínculo de cuidado.
 *
 * ─── A DIREÇÃO É A PROTEÇÃO ───────────────────────────────────────────────────
 * Quem gera o código é **quem vai ser cuidado**, na própria Xarlote, e o entrega a quem
 * vai cuidar. Nunca o contrário.
 *
 * A alternativa — o cuidador digitar o telefone e o sistema perguntar "fulano quer
 * acompanhar sua saúde, autoriza?" — parece mais gentil e é bem pior: transforma qualquer
 * pessoa com um número de telefone num vetor de convite não-solicitado, contra uma
 * população que atende tudo e clica em tudo. Um dígito errado manda o pedido pra um
 * estranho. Aqui, o código só existe porque alguém deliberadamente pediu um pra dar.
 *
 * ─── MECÂNICA ─────────────────────────────────────────────────────────────────
 * Espelha `otp.ts`, que já é a escola da casa: só o hash no banco, salt por linha, pepper
 * de env, `attempts` incrementado ANTES de comparar (fecha a corrida de força bruta), e
 * `timingSafeEqual`. As diferenças são de propósito:
 *
 *   • TTL de 30min, não 5. O OTP vai pro WhatsApp da própria pessoa e ela digita em
 *     seguida. Este aqui uma senhora lê em voz alta pro filho no telefone — e ela vai
 *     procurar os óculos primeiro.
 *   • 5 tentativas, não 3. Errar ditando número por telefone é normal; o espaço de busca
 *     de 1 milhão com 5 tentativas continua desprezível.
 *
 * PURO: sem I/O, sem relógio, RNG injetado.
 */
import { createHash, timingSafeEqual } from 'crypto';

/** Tempo pra alguém ditar seis dígitos por telefone, com folga. */
export const CARE_INVITE_TTL_MS = 30 * 60_000;
export const CARE_INVITE_MAX_ATTEMPTS = 5;
export const CARE_INVITE_LENGTH = 6;

/** Quantos convites abertos uma pessoa pode ter ao mesmo tempo. */
export const CARE_INVITE_MAX_ABERTOS = 3;

export function generateCareCode(randomInt: (min: number, maxExclusive: number) => number): string {
  return String(randomInt(0, 1_000_000)).padStart(CARE_INVITE_LENGTH, '0');
}

export function hashCareCode(code: string, salt: string, pepper: string): string {
  return createHash('sha256').update(`care:${pepper}:${salt}:${code}`).digest('hex');
}

/** Só dígitos, do tamanho certo. Aceita "123 456" e "123-456" — gente dita com pausa. */
export function normalizarCodigo(bruto: unknown): string | null {
  const digitos = String(bruto ?? '').replace(/\D/g, '');
  return digitos.length === CARE_INVITE_LENGTH ? digitos : null;
}

export interface CareInviteRow {
  code_hash: string;
  salt: string;
  /** JÁ incrementado pelo chamador antes de avaliar. */
  attempts: number;
  max_attempts: number;
  expires_at: string;
  consumed_at: string | null;
  user_id: string;
}

export type CareInviteVerdict = 'ok' | 'expired' | 'exhausted' | 'consumed' | 'mismatch' | 'proprio';

/**
 * O convite serve pra este resgate?
 *
 * Ordem deliberada, igual à do OTP: consumido/vencido/esgotado NUNCA respondem "mismatch",
 * pra não dar sinal de força bruta sobre um alvo morto. E `proprio` vem antes da
 * comparação — resgatar o próprio código não é erro de digitação, é confusão de fluxo, e
 * merece uma resposta que explique em vez de dizer "código errado".
 */
export function evaluateCareInvite(
  row: CareInviteRow,
  input: { code: string; pepper: string; nowMs: number; resgatadorUserId: string },
): CareInviteVerdict {
  if (row.consumed_at) return 'consumed';
  if (Date.parse(row.expires_at) <= input.nowMs) return 'expired';
  if (row.attempts > row.max_attempts) return 'exhausted';
  if (row.user_id === input.resgatadorUserId) return 'proprio';

  const esperado = Buffer.from(row.code_hash, 'hex');
  const oferecido = Buffer.from(hashCareCode(input.code, row.salt, input.pepper), 'hex');
  if (esperado.length !== oferecido.length || !timingSafeEqual(esperado, oferecido)) {
    return 'mismatch';
  }
  return 'ok';
}

/** O que dizer a quem tentou resgatar. Sem revelar se o código existe. */
export function explicarVerdict(v: CareInviteVerdict): string {
  switch (v) {
    case 'ok': return 'código válido';
    case 'proprio': return 'esse código é seu — quem precisa digitá-lo é a pessoa que vai te acompanhar';
    case 'consumed':
    case 'expired':
    case 'exhausted':
    case 'mismatch':
      // Desfecho ÚNICO pros quatro (escola do `avaliarShare`): distinguir "existe mas
      // venceu" de "não existe" transformaria a rota num oráculo de códigos válidos.
      return 'esse código não vale mais. Peça um novo pra pessoa que você vai acompanhar';
  }
}
