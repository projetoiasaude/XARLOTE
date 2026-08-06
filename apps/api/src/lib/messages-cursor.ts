/**
 * messages-cursor — cursor keyset da paginação do chat.
 *
 * Por que keyset e não OFFSET: em escala, `OFFSET 5000` varre 5000 linhas pra jogar
 * fora; o keyset `(created_at, id) < (x, y)` usa o índice e custa o mesmo na página 1
 * e na página 1000. O `id` no par desempata mensagens no MESMO timestamp (acontece:
 * inserts em lote do worker).
 *
 * O cursor é opaco pro cliente (base64url de JSON) de propósito: o app não deve
 * construir nem interpretar cursores — o formato pode evoluir sem quebrar ninguém.
 * `decodeCursor` NUNCA lança: lixo → null → o chamador responde 400.
 */

export interface MessagesCursor {
  createdAt: string;
  id: string;
}

export function encodeCursor(c: MessagesCursor): string {
  return Buffer.from(JSON.stringify(c), 'utf8').toString('base64url');
}

export function decodeCursor(raw: string | undefined | null): MessagesCursor | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as unknown;
    if (
      typeof parsed === 'object' && parsed !== null
      && typeof (parsed as MessagesCursor).createdAt === 'string'
      && typeof (parsed as MessagesCursor).id === 'string'
      && Number.isFinite(Date.parse((parsed as MessagesCursor).createdAt))
    ) {
      return { createdAt: (parsed as MessagesCursor).createdAt, id: (parsed as MessagesCursor).id };
    }
    return null;
  } catch {
    return null;
  }
}
