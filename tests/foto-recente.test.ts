/**
 * "O que acha desse exame?" 9 segundos depois da foto — respondido sem a foto (04/09/2026).
 */
import { describe, expect, it } from 'vitest';
import { selecionarFotosRecentes, JANELA_FOTO_RECENTE_MS } from '../packages/shared/src/foto-recente.js';

const brt = (iso: string) => new Date(`${iso}-03:00`).toISOString();
const foto = (over: Partial<{ id: string; direction: string; content_type: string; media_storage_path: string | null; media_mime: string | null; created_at: string }> = {}) => ({
  id: 'img', direction: 'in', content_type: 'image', media_storage_path: 'inbound/2026-09-04/bee95a71.jpg', media_mime: 'image/jpeg', created_at: brt('2026-09-04T16:54:51'), ...over,
});
const AGORA = new Date(brt('2026-09-04T16:55:00'));

describe('a foto de há pouco', () => {
  it('seleciona a foto do paciente enviada 9 s antes', () => {
    expect(selecionarFotosRecentes([foto()], { agora: AGORA }).map((m) => m.id)).toEqual(['img']);
  });
  it('fora da janela, não', () => {
    const velha = foto({ created_at: new Date(AGORA.getTime() - JANELA_FOTO_RECENTE_MS - 1000).toISOString() });
    expect(selecionarFotosRecentes([velha], { agora: AGORA })).toEqual([]);
  });
  it('só do PACIENTE, só imagem, só com arquivo guardado, e nunca PDF', () => {
    expect(selecionarFotosRecentes([foto({ direction: 'out' })], { agora: AGORA })).toEqual([]);
    expect(selecionarFotosRecentes([foto({ content_type: 'document' })], { agora: AGORA })).toEqual([]);
    expect(selecionarFotosRecentes([foto({ media_storage_path: null })], { agora: AGORA })).toEqual([]);
    expect(selecionarFotosRecentes([foto({ media_mime: 'application/pdf' })], { agora: AGORA })).toEqual([]);
  });
  it('no máximo 2, da mais nova pra mais velha', () => {
    const msgs = [
      foto({ id: 'a', created_at: brt('2026-09-04T16:40:00') }),
      foto({ id: 'b', created_at: brt('2026-09-04T16:50:00') }),
      foto({ id: 'c', created_at: brt('2026-09-04T16:54:51') }),
    ];
    expect(selecionarFotosRecentes(msgs, { agora: AGORA }).map((m) => m.id)).toEqual(['c', 'b']);
  });
});
