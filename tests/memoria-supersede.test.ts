/**
 * `patchDoSupersede` — o que a Xarlote grava quando um aprendizado NOVO casa
 * semanticamente com um que ela já tinha.
 *
 * Por que este teste existe: até 31/08/2026 o dedupe semântico atualizava só
 * `last_seen_at` e `confidence` e DESCARTAVA o texto novo. A pessoa dizia "agora
 * prefiro cartão", isso casava ~0,87 com "prefere pagar no Pix", e o resultado era
 * o card ERRADO ganhando +0,05 de confiança. A memória não se corrigia — só se
 * reforçava, e no sentido errado.
 *
 * Isso desbotava sozinho enquanto `preference` tinha meia-vida de 180 dias. A
 * migration 0031 tirou o decay a pedido do fundador (preferência e episódio valem
 * para sempre) — e sem este conserto o card errado seria ETERNO. É por isso que o
 * modo de falhar aqui é silencioso e caro: ninguém vê nada acontecer, e a Xarlote
 * simplesmente age sobre uma preferência que a pessoa já corrigiu.
 */
import { describe, it, expect } from 'vitest';
import { patchDoSupersede } from '../packages/db/src/memory.js';

const AGORA = '2026-08-31T12:00:00.000Z';
const emb = (v: number) => Array.from({ length: 1536 }, () => v);

describe('patchDoSupersede — o texto mais recente vence', () => {
  it('reescreve o texto quando a pessoa corrige a preferência', () => {
    const patch = patchDoSupersede(
      { text: 'prefere pagar no Pix', confidence: 0.85 },
      { text: 'agora prefere pagar no cartão', embedding: emb(0.1) },
      AGORA,
    );
    expect(patch.text).toBe('agora prefere pagar no cartão');
    // O embedding TEM que acompanhar: sem isso o card seria encontrado pela
    // redação velha e mostrado com a nova — a pior das combinações.
    expect(patch.embedding).toBeDefined();
    expect(patch.confidence).toBeCloseTo(0.9);
    expect(patch.last_seen_at).toBe(AGORA);
  });

  it('texto idêntico é só reencontro: refresca e não reescreve', () => {
    const patch = patchDoSupersede(
      { text: 'é alérgica a dipirona', confidence: 0.9 },
      { text: 'é alérgica a dipirona', embedding: emb(0.2) },
      AGORA,
    );
    expect(patch.text).toBeUndefined();
    expect(patch.embedding).toBeUndefined();
    expect(patch.confidence).toBeCloseTo(0.95);
  });

  it('confiança satura em 1 e nunca passa disso', () => {
    const patch = patchDoSupersede(
      { text: 'x', confidence: 0.99 },
      { text: 'y', embedding: emb(0.3) },
      AGORA,
    );
    expect(patch.confidence).toBe(1);
  });

  it('card sem confiança cai no default 0.8 em vez de virar NaN', () => {
    const patch = patchDoSupersede(
      { text: 'x', confidence: undefined as unknown as number },
      { text: 'y', embedding: emb(0.4) },
      AGORA,
    );
    expect(patch.confidence).toBeCloseTo(0.85);
    expect(Number.isNaN(patch.confidence)).toBe(false);
  });

  it('quando a própria pessoa diz, o card deixa de ser inferido', () => {
    const patch = patchDoSupersede(
      { text: 'toma losartana de manhã', confidence: 0.8 },
      { text: 'toma losartana 50mg às 7h', embedding: emb(0.5), source: 'self_reported' },
      AGORA,
    );
    expect(patch.source).toBe('self_reported');
  });

  it('uma INFERÊNCIA não rebaixa o que a pessoa afirmou', () => {
    // O `source` só sobe. Se a Xarlote deduzir algo por cima de um card que a
    // pessoa ditou, o card continua marcado como dito por ela — senão a origem do
    // dado apodrece a cada turno e o badge do perfil passa a mentir.
    const patch = patchDoSupersede(
      { text: 'toma losartana 50mg às 7h', confidence: 0.9 },
      { text: 'parece tomar losartana pela manhã', embedding: emb(0.6), source: 'inferred' },
      AGORA,
    );
    expect(patch.source).toBeUndefined();
  });

  it('embedding ausente ou de tamanho errado não grava vetor quebrado', () => {
    // Se o /embeddings falhou, o texto ainda deve ser corrigido — mas gravar um
    // vetor de dimensão errada estouraria o insert e perderia a correção inteira.
    const semEmb = patchDoSupersede({ text: 'a', confidence: 0.8 }, { text: 'b' }, AGORA);
    expect(semEmb.text).toBe('b');
    expect(semEmb.embedding).toBeUndefined();

    const curto = patchDoSupersede(
      { text: 'a', confidence: 0.8 },
      { text: 'b', embedding: [0.1, 0.2] },
      AGORA,
    );
    expect(curto.text).toBe('b');
    expect(curto.embedding).toBeUndefined();
  });

  it('tags vazias não apagam as que já existiam', () => {
    const patch = patchDoSupersede(
      { text: 'a', confidence: 0.8 },
      { text: 'b', embedding: emb(0.7), tags: [] },
      AGORA,
    );
    expect(patch.tags).toBeUndefined();
  });
});
