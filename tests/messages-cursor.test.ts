import { describe, it, expect } from 'vitest';
import { encodeCursor, decodeCursor } from '../apps/api/src/lib/messages-cursor.js';

/**
 * Blinda o cursor keyset da paginação do chat. O cursor é opaco pro cliente e
 * `decodeCursor` NUNCA lança — lixo vira null (o endpoint responde 400).
 */

describe('cursor keyset', () => {
  it('roundtrip preserva createdAt e id', () => {
    const c = { createdAt: '2026-08-06T12:00:00.123+00:00', id: 'ec1f69c8-4b08-4e06-9468-1ba1bbbbf732' };
    expect(decodeCursor(encodeCursor(c))).toEqual(c);
  });

  it.each([
    ['vazio', ''],
    ['null', null],
    ['undefined', undefined],
    ['lixo', 'n@o-e-base64!!!'],
    ['base64 de não-JSON', Buffer.from('só texto').toString('base64url')],
    ['JSON sem os campos', Buffer.from(JSON.stringify({ a: 1 })).toString('base64url')],
    ['createdAt não-data', Buffer.from(JSON.stringify({ createdAt: 'ontem', id: 'x' })).toString('base64url')],
  ])('%s → null, sem lançar', (_nome, raw) => {
    expect(decodeCursor(raw as string | null | undefined)).toBeNull();
  });
});
