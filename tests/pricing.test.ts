import { describe, it, expect } from 'vitest';
import { estimateCostUsd, pricingFor } from '../packages/llm/src/pricing.js';

describe('estimateCostUsd', () => {
  it('cobra input fresco + output (sem cache) no preço cheio', () => {
    // gpt-4.1-mini: in 0.40, out 1.60 por 1M
    const c = estimateCostUsd('openai/gpt-4.1-mini', 1_000_000, 0, 1_000_000);
    expect(c).toBeCloseTo(0.4 + 1.6, 6);
  });

  it('aplica o desconto de cache no input cacheado', () => {
    // 1M input, TODO cacheado (0.10/1M) + 0 output → muito mais barato que 0.40
    const cached = estimateCostUsd('openai/gpt-4.1-mini', 1_000_000, 1_000_000, 0);
    expect(cached).toBeCloseTo(0.1, 6);
    const fresh = estimateCostUsd('openai/gpt-4.1-mini', 1_000_000, 0, 0);
    expect(cached).toBeLessThan(fresh); // cache é mais barato
  });

  it('cenário real (~98% cache) custa bem menos que sem cache', () => {
    const withCache = estimateCostUsd('openai/gpt-4.1-mini', 10_275, 10_112, 33);
    const noCache = estimateCostUsd('openai/gpt-4.1-mini', 10_275, 0, 33);
    expect(withCache).toBeLessThan(noCache);
    expect(withCache).toBeGreaterThan(0);
  });

  it('cachedTokens nunca passa de tokensIn (clamp)', () => {
    const c = estimateCostUsd('openai/gpt-4.1-mini', 100, 99999, 0);
    const allCached = estimateCostUsd('openai/gpt-4.1-mini', 100, 100, 0);
    expect(c).toBeCloseTo(allCached, 9);
  });

  it('modelo desconhecido usa fallback (não quebra, custo > 0)', () => {
    const c = estimateCostUsd('algum/modelo-novo', 1000, 0, 100);
    expect(c).toBeGreaterThan(0);
    expect(pricingFor('algum/modelo-novo')).toEqual(pricingFor('openai/gpt-4.1-mini'));
  });

  it('lida com null/undefined sem quebrar', () => {
    expect(estimateCostUsd(null, 0, 0, 0)).toBe(0);
    expect(estimateCostUsd(undefined, 100, 0, 50)).toBeGreaterThan(0);
  });
});
