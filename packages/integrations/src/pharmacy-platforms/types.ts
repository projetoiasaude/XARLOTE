/**
 * Cotação nas plataformas de e-commerce das grandes redes (VTEX) — sem parceria.
 * Ver docs/PHARMACY_PLATFORMS.md para o mapa das redes e o "molde" da API validado ao vivo.
 */

/** Produto retornado pela busca de catálogo (catalog_system/pub/products/search). */
export interface PlatformProduct {
  /** id da rede no registry (ex.: 'drogaria-sao-paulo') */
  network: string;
  /** rótulo humano (ex.: 'Drogaria São Paulo') */
  networkLabel: string;
  /** grupo econômico (dedup: São Paulo+Pacheco = DPSP) */
  group: string;
  productName: string;
  /** SKU (items[].itemId) — usado na simulação e no link de carrinho */
  sku: string;
  /** seller da oferta escolhida (1 = próprio; ≠1 = marketplace) — tem que casar no cart/simulação */
  sellerId: string;
  ean: string | null;
  /** preço-base do catálogo (reais) — o preço REAL por CEP vem da simulação */
  price: number;
  /** preço "de" (riscado), reais, quando há desconto */
  listPrice: number | null;
  /** disponibilidade grosseira do catálogo (o estoque real por região vem da simulação) */
  availableQuantity: number;
  /** URL canônica do produto */
  productUrl: string;
  /** princípio ativo, quando a rede expõe (ajuda o matching) */
  activeIngredient: string[] | null;
}

/** Preço + estoque + entrega POR CEP (orderForms/simulation). */
export interface PlatformFulfillment {
  /** preço no CEP (reais) */
  price: number;
  /** preço "de" (reais) quando há desconto */
  listPrice: number | null;
  available: boolean;
  /** melhor (mais rápida) opção de ENTREGA em domicílio, se houver */
  delivery: FulfillmentOption | null;
  /** melhor opção de RETIRADA na loja, se houver */
  pickup: FulfillmentOption | null;
}

export interface FulfillmentOption {
  /** texto do prazo já legível (ex.: "1 dia útil", "60 min") */
  etaText: string;
  /** frete em reais (0 = grátis) */
  feeReais: number;
}

/** Uma cotação de plataforma pronta pra entrar no pool e virar handoff. */
export interface PlatformQuote {
  network: string;
  networkLabel: string;
  group: string;
  productName: string;
  sku: string;
  /** preço efetivo (simulação por CEP quando disponível; senão catálogo) */
  price: number;
  listPrice: number | null;
  available: boolean;
  delivery: FulfillmentOption | null;
  pickup: FulfillmentOption | null;
  /** link de carrinho pré-montado (handoff — usuário só finaliza) */
  checkoutUrl: string;
  productUrl: string;
  /** confiança do match pedido↔produto (0..1) — abaixo do limiar não apresentamos */
  matchScore: number;
  /** true quando o preço veio da simulação por CEP (não só do catálogo) */
  pricedByCep: boolean;
}
