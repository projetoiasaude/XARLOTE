/**
 * O degrau abaixo do primário não pode ser um abismo — nem cego.
 *
 * ─── AUDITORIA 08/09/2026 ────────────────────────────────────────────────────────
 * A cadeia de fallback era `[gpt-4.1-mini, gpt-4o-mini]` para qualquer primário. No
 * τ²-Bench Airline rodado pelo OpenRouter em 03/09 (121 modelos, agente multi-turno
 * chamando ferramentas sob política — o trabalho da Xarlote), `gpt-4.1-mini` faz 44,0%
 * e o modelo de produção faz 75,2%. O fallback do OpenRouter é silencioso: o primário
 * cai e a Xarlote segue respondendo 31 pontos pior, sem sinal nenhum.
 *
 * E a armadilha da correção: GLM 5.2/5.3 são TEXTO PURO. Promover o GLM a fallback sem
 * olhar modalidade faria um turno com foto cair num modelo que não enxerga — a mesma
 * família de falha do exame da Ludmila (04/09), em que a imagem sumiu em silêncio.
 */
import { describe, expect, it } from 'vitest';
import { cadeiaDeFallback, turnoTemImagem, userContentWithImage, type ChatMessage } from '../packages/llm/src/client.js';

const texto = (t: string): ChatMessage => ({ role: 'user', content: t });
const comFoto = (): ChatMessage => ({ role: 'user', content: userContentWithImage('olha esse exame', ['data:image/jpeg;base64,AAAA']) });

describe('turnoTemImagem', () => {
  it('turno de texto puro não tem imagem', () => {
    expect(turnoTemImagem([texto('sistema'), texto('tomei')])).toBe(false);
  });
  it('turno com foto tem', () => {
    expect(turnoTemImagem([texto('sistema'), comFoto()])).toBe(true);
  });
  it('acha a imagem mesmo em mensagem antiga do histórico (foto re-anexada)', () => {
    expect(turnoTemImagem([comFoto(), texto('o que acha desse exame?')])).toBe(true);
  });
  it('content null (assistant só com tool_calls) não quebra', () => {
    expect(turnoTemImagem([{ role: 'assistant', content: null }])).toBe(false);
  });
});

describe('cadeia de TEXTO — o abismo fechado', () => {
  it('primário GLM 5.3 cai no GLM 5.2 (75,2% no τ²), não no gpt-4.1-mini (44,0%)', () => {
    expect(cadeiaDeFallback('z-ai/glm-5.3', false)).toEqual(['z-ai/glm-5.2', 'openai/gpt-4.1-mini']);
  });
  it('o ÚLTIMO degrau é de outro fornecedor — uma queda da Z.ai não derruba a cadeia toda', () => {
    const c = cadeiaDeFallback('z-ai/glm-5.3', false);
    expect(c[c.length - 1]!.startsWith('z-ai/')).toBe(false);
  });
  it('não duplica o primário quando ele já está na cadeia', () => {
    expect(cadeiaDeFallback('z-ai/glm-5.2', false)).toEqual(['openai/gpt-4.1-mini']);
    expect(cadeiaDeFallback('openai/gpt-4.1-mini', false)).toEqual(['z-ai/glm-5.2']);
  });
});

describe('cadeia de VISÃO — todo degrau tem que ENXERGAR', () => {
  it('turno com foto nunca cai num modelo texto-only (GLM 5.2/5.3 fora)', () => {
    const c = cadeiaDeFallback('z-ai/glm-5.3', true);
    expect(c.some((m) => m.startsWith('z-ai/glm-5.2') || m.startsWith('z-ai/glm-5.3'))).toBe(false);
    expect(c).toEqual(['openai/gpt-4.1-mini', 'openai/gpt-4o-mini']);
  });
  it('o vision_model de hoje mantém o fallback que já existia', () => {
    expect(cadeiaDeFallback('openai/gpt-4.1-mini', true)).toEqual(['openai/gpt-4o-mini']);
  });
  it('nenhum modelo texto-only aparece em cadeia de visão, para qualquer primário', () => {
    const soTexto = ['z-ai/glm-5.2', 'z-ai/glm-5.3'];
    for (const primario of ['z-ai/glm-5.3', 'z-ai/glm-5.2', 'openai/gpt-4.1-mini', 'google/gemini-3.8-flash']) {
      expect(cadeiaDeFallback(primario, true).filter((m) => soTexto.includes(m))).toEqual([]);
    }
  });
});
