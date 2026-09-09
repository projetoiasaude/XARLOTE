/**
 * Cofre da credencial de laboratório — cifra o que vai pra fila e redige o que vai pro banco.
 *
 * ─── POR QUE ISTO EXISTE ─────────────────────────────────────────────────────
 * A senha do portal do laboratório é a única senha de terceiro que a Xarlote toca. Hoje ela
 * não guarda senha de NADA: o acesso dela é código de uso único, e o banco dela não abre
 * porta em lugar nenhum. Este arquivo é o que mantém isso verdadeiro mesmo com a busca de
 * exames ligada:
 *
 *   1. A credencial vai para a fila BullMQ CIFRADA (Redis não cifra em repouso). Só o worker
 *      decifra, e só na hora de digitar no formulário.
 *   2. `assistant_tasks.tool_input` guarda os args crus do modelo — sem redigir, a senha iria
 *      para o Postgres em texto puro, para sempre. `redigirCredenciais` roda ANTES do insert.
 *   3. Nenhuma das funções aqui loga nada. Nunca.
 *
 * AES-256-GCM: cifra autenticada — um byte alterado no payload invalida a decifra, então um
 * job adulterado não digita lixo num portal. IV de 12 bytes aleatório por mensagem.
 * Chave: `LAB_VAULT_KEY`, 32 bytes em hex (64 chars). Sem a chave, a feature NÃO liga —
 * ver `labFetchDisponivel`.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

const ALG = 'aes-256-gcm';
const IV_BYTES = 12;

export function chaveDoCofre(env: NodeJS.ProcessEnv = process.env): Buffer | null {
  const hex = (env['LAB_VAULT_KEY'] ?? '').trim();
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) return null;
  return Buffer.from(hex, 'hex');
}

/** A feature só existe com chave válida E flag explícita. Sem as duas, a tool nem é oferecida. */
export function labFetchDisponivel(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['LAB_FETCH_ENABLED'] === 'true' && chaveDoCofre(env) !== null;
}

/**
 * Prontidão PROVADA: a chave que o worker grava no Redis depois de abrir um Chromium de
 * verdade, renovada a cada minuto. A API só oferece a tool ao modelo quando ela existe.
 * TTL curto de propósito: worker morto = tool some em ≤2 min, sem ninguém precisar avisar.
 */
export const LAB_FETCH_READY_KEY = 'lab-fetch:ready';
export const LAB_FETCH_READY_TTL_S = 120;

/** Config OK e um worker provou que abre navegador há menos de 2 min? Falha fechada. */
export async function labFetchPronto(
  redis: { get(key: string): Promise<string | null> },
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  if (!labFetchDisponivel(env)) return false;
  try {
    return (await redis.get(LAB_FETCH_READY_KEY)) !== null;
  } catch {
    return false;
  }
}

/** `iv.tag.ciphertext`, tudo em base64url. */
export function cifrar(texto: string, chave: Buffer): string {
  const iv = randomBytes(IV_BYTES);
  const c = createCipheriv(ALG, chave, iv);
  const enc = Buffer.concat([c.update(texto, 'utf8'), c.final()]);
  const tag = c.getAuthTag();
  return [iv, tag, enc].map((b) => b.toString('base64url')).join('.');
}

/** Devolve `null` para qualquer coisa que não seja exatamente o que `cifrar` produziu. */
export function decifrar(envelope: string, chave: Buffer): string | null {
  const partes = envelope.split('.');
  if (partes.length !== 3 || partes.some((p) => !p)) return null;
  try {
    const iv = Buffer.from(partes[0]!, 'base64url');
    const tag = Buffer.from(partes[1]!, 'base64url');
    const enc = Buffer.from(partes[2]!, 'base64url');
    if (iv.length !== IV_BYTES || tag.length !== 16) return null;
    const d = createDecipheriv(ALG, chave, iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
  } catch {
    return null;
  }
}

const CHAVES_SENSIVEIS = /^(senha|password|pass|pwd|token|login|usuario|usuário|user|protocolo)$/i;

/**
 * Cópia dos args com os campos de credencial substituídos. `login` e `protocolo` também:
 * o número do protocolo, sozinho, costuma ser chave de acesso em portal que não pede senha.
 * Recursivo e sem mutar a entrada — os args ainda vão ser usados de verdade logo em seguida.
 */
export function redigirCredenciais<T>(valor: T): T {
  if (Array.isArray(valor)) return valor.map((v) => redigirCredenciais(v)) as unknown as T;
  if (valor && typeof valor === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(valor as Record<string, unknown>)) {
      out[k] = CHAVES_SENSIVEIS.test(k) && typeof v === 'string' && v.length > 0 ? '[redigido]' : redigirCredenciais(v);
    }
    return out as T;
  }
  return valor;
}
