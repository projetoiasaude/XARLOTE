/**
 * O nudge que entrou no meio de um caso que um humano estava resolvendo.
 *
 * 24/08/2026: às 15:48 a Duda recebeu a confirmação de uma consulta inexistente; às
 * 18:09 o estado foi corrigido no banco; às 18:53 o worker de nudge disparou sozinho
 * "as opções de consulta que te mandei ainda estão de pé", antes de qualquer explicação.
 * Não havia como pausar: todo estado vivo dispara algum vigilante.
 */
import { describe, it, expect } from 'vitest';
import {
  emPausaDeOutreach, comPausaDeOutreach, motivoDaPausa,
  PAUSA_PADRAO_MS, PAUSA_MAXIMA_MS, CHAVE_PAUSA,
} from '../packages/shared/src/outreach-hold.js';

const AGORA = Date.parse('2026-08-24T21:00:00Z');

describe('a pausa que faltava', () => {
  it('sem metadata, nada está pausado', () => {
    expect(emPausaDeOutreach(null, AGORA)).toBe(false);
    expect(emPausaDeOutreach({}, AGORA)).toBe(false);
    expect(emPausaDeOutreach({ [CHAVE_PAUSA]: 'ontem' }, AGORA)).toBe(false);
  });

  it('depois que um humano fala, o robô recua', () => {
    const meta = comPausaDeOutreach({}, AGORA, PAUSA_PADRAO_MS, 'mensagem manual');
    expect(emPausaDeOutreach(meta, AGORA + 3_600_000)).toBe(true);
    expect(motivoDaPausa(meta)).toBe('mensagem manual');
  });

  it('e volta a falar sozinho quando a pausa vence — silêncio eterno é a falha oposta', () => {
    const meta = comPausaDeOutreach({}, AGORA, PAUSA_PADRAO_MS, 'x');
    expect(emPausaDeOutreach(meta, AGORA + PAUSA_PADRAO_MS + 1000)).toBe(false);
  });

  it('nunca ENCURTA uma pausa existente: vale a mais longa', () => {
    // Dois humanos falando com o mesmo paciente não podem, sem querer, destravar o robô.
    const longa = comPausaDeOutreach({}, AGORA, 24 * 3_600_000, 'primeiro');
    const depois = comPausaDeOutreach(longa, AGORA, 1 * 3_600_000, 'segundo');
    expect(emPausaDeOutreach(depois, AGORA + 12 * 3_600_000)).toBe(true);
  });

  it('respeita o teto de segurança', () => {
    const absurda = comPausaDeOutreach({}, AGORA, 999 * 3_600_000, 'x');
    expect(emPausaDeOutreach(absurda, AGORA + PAUSA_MAXIMA_MS + 1000)).toBe(false);
  });

  it('não muta a entrada e preserva o resto do metadata', () => {
    const antes = { reengage_template_at: '2026-08-01T00:00:00Z' };
    const depois = comPausaDeOutreach(antes, AGORA, PAUSA_PADRAO_MS, 'x');
    expect(antes).toEqual({ reengage_template_at: '2026-08-01T00:00:00Z' });
    expect(depois['reengage_template_at']).toBe('2026-08-01T00:00:00Z');
  });
});
