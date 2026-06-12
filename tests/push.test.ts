import { describe, expect, it } from 'vitest';
import { sendPush, isPushConfigured } from '../packages/integrations/src/push.js';

// Sem credenciais FCM no ambiente de teste → tudo é no-op gracioso.
describe('sendPush — sem credenciais (no-op gracioso)', () => {
  it('isPushConfigured = false sem env', () => {
    delete process.env['FCM_PROJECT_ID'];
    expect(isPushConfigured()).toBe(false);
  });

  it('retorna skipped sem quebrar', async () => {
    const r = await sendPush([{ token: 'abc', platform: 'ios' }], { title: 'oi', body: 'teste' });
    expect(r.skipped).toBe('no_credentials');
    expect(r.sent).toBe(0);
    expect(r.invalidTokens).toEqual([]);
  });

  it('lista vazia de alvos não chama nada', async () => {
    const r = await sendPush([], { title: 'oi', body: 'teste' });
    expect(r.sent).toBe(0);
  });
});
