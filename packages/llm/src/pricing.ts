/**
 * Estimativa de custo de LLM (F1.B3/B4) — converte tokens em US$, levando em
 * conta o DESCONTO de cache (F2.G3): tokens de input servidos do cache custam
 * uma fração do preço normal.
 *
 * Preços são ESTIMATIVAS (lista pública dos provedores, por 1M de tokens). O
 * objetivo é dar visibilidade de custo/turno e disparar alerta de teto — não é
 * fatura contábil. Ajuste os números conforme o provider/modelo real.
 */
export interface ModelPricing {
  /** US$ por 1M tokens de input "fresco" (não cacheado). */
  inUsdPerM: number;
  /** US$ por 1M tokens de input servidos do CACHE (bem mais barato). */
  cachedInUsdPerM: number;
  /** US$ por 1M tokens de output. */
  outUsdPerM: number;
}

// Preços aproximados (lista OpenAI/OpenRouter, jul/2026). Chaves em minúsculas.
const PRICING: Record<string, ModelPricing> = {
  // Modelo PRINCIPAL desde 07/2026 (OpenRouter). Valores da página oficial:
  // prompt $0.93/M, completion $3/M, cache-read $0.18/M.
  'z-ai/glm-5.2': { inUsdPerM: 0.93, cachedInUsdPerM: 0.18, outUsdPerM: 3.0 },
  'openai/gpt-4.1-mini': { inUsdPerM: 0.4, cachedInUsdPerM: 0.1, outUsdPerM: 1.6 },
  'openai/gpt-4o-mini': { inUsdPerM: 0.15, cachedInUsdPerM: 0.075, outUsdPerM: 0.6 },
  'openai/gpt-4.1': { inUsdPerM: 2.0, cachedInUsdPerM: 0.5, outUsdPerM: 8.0 },
  'openai/gpt-4o': { inUsdPerM: 2.5, cachedInUsdPerM: 1.25, outUsdPerM: 10.0 },
};

// Fallback quando o modelo não está no mapa (usa o do modelo padrão do projeto).
const DEFAULT_PRICING: ModelPricing = PRICING['openai/gpt-4.1-mini']!;

// Modelos já avisados (evita spammar o log quando cai no default silenciosamente —
// foi o que aconteceu na troca pro glm-5.2: custo calculado com preço errado sem aviso).
const warnedUnknown = new Set<string>();

export function pricingFor(model: string | null | undefined): ModelPricing {
  if (!model) return DEFAULT_PRICING;
  const hit = PRICING[model] ?? PRICING[model.toLowerCase()];
  if (hit) return hit;
  if (!warnedUnknown.has(model)) {
    warnedUnknown.add(model);
    console.warn(`[pricing] modelo "${model}" sem preço no mapa — usando o do gpt-4.1-mini (custo pode estar errado). Adicione em packages/llm/src/pricing.ts.`);
  }
  return DEFAULT_PRICING;
}

/**
 * Custo estimado em US$ de uma chamada, descontando os tokens cacheados.
 *   tokensIn   = total de input reportado (inclui os cacheados)
 *   cachedTokens = quantos desses vieram do cache (custam cachedInUsdPerM)
 *   tokensOut  = tokens de output
 */
export function estimateCostUsd(
  model: string | null | undefined,
  tokensIn: number,
  cachedTokens: number,
  tokensOut: number,
): number {
  const p = pricingFor(model);
  const cached = Math.max(0, Math.min(cachedTokens || 0, tokensIn || 0));
  const freshIn = Math.max(0, (tokensIn || 0) - cached);
  return (
    (freshIn * p.inUsdPerM + cached * p.cachedInUsdPerM + (tokensOut || 0) * p.outUsdPerM) / 1_000_000
  );
}
