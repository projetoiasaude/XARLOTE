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
  /**
   * O MESMO prazo em minutos, pra ordenar sem re-parsear texto.
   *
   * O número já existia dentro de `pickBestSla` e era jogado fora; quem quisesse
   * ordenar por rapidez tinha que interpretar "5 dias úteis" de volta. Guardar os
   * dois é a diferença entre comparar e adivinhar.
   */
  etaMinutes: number;
  /** Nome do SLA na rede ("SUPER EXPRESSA", "ENTREGA COM RECEITA") — pra log e diagnóstico. */
  slaName?: string;
  /**
   * RETIRADA: a loja escolhida (a mais rápida e, no empate, a mais PERTO).
   *
   * A simulação sempre devolveu o endereço e a distância de cada loja, e o parser jogava
   * fora. "Retira em 30 min" sem dizer ONDE não é uma promessa que a pessoa possa cumprir;
   * "retira em 30 min na loja da Av. República do Líbano, a 1,6 km" é.
   */
  store?: PickupStore | null;
}

export interface PickupStore {
  /** Marca/filial como a rede chama a loja ("Drogarias Pacheco - Filial Republica Do Libano 2"). */
  name: string;
  /** Rua + bairro, pronto pra ler ("Avenida República do Líbano, Setor Oeste"). */
  address: string | null;
  /** Distância do CEP até a loja, em km (null quando a rede não informa). */
  distanceKm: number | null;
  /** Label da rede IRMÃ (mesmo grupo no registro) cuja marca está na fachada — ver `marcarLojaDoGrupo`. */
  marcaDoGrupo?: string | null;
}

// ─── Cesta (pedido com N medicamentos numa MESMA rede → 1 carrinho) ───────────

/** Uma linha da cesta: o que o usuário pediu × o produto real casado na rede. */
export interface PlatformBasketLine {
  /** rótulo do que o usuário pediu (ex.: "Dorflex 300mg") */
  requested: string;
  productName: string;
  sku: string;
  sellerId: string;
  /** preço unitário no CEP (× qty já refletido no total) */
  price: number;
  qty: number;
  matchScore: number;
  /** link PRÓPRIO deste item — presente só quando a rede NÃO monta carrinho único (RD): aí
   * cada remédio tem seu link (senão o 2º item sumiria atrás do link do 1º — review HIGH). */
  productUrl?: string;
}

/** Cotação de uma REDE pra uma cesta: itens que ela tem, itens que faltam, total e 1 link. */
export interface PlatformBasketQuote {
  network: string;
  networkLabel: string;
  group: string;
  /** itens encontrados nessa rede (>=1) */
  lines: PlatformBasketLine[];
  /** rótulos dos itens que a rede NÃO tem */
  missing: string[];
  /** total da cesta no CEP (soma das linhas × qty) */
  total: number;
  available: boolean;
  delivery: FulfillmentOption | null;
  pickup: FulfillmentOption | null;
  /** UM link de carrinho com TODOS os itens encontrados (multi-sku) */
  checkoutUrl: string;
  pricedByCep: boolean;
  /**
   * A simulação da cesta EXATA rodou e não existe opção de entrega/retirada comum a todos
   * os itens (cada um chega de um jeito). Não é "sem entrega": é "confira no site".
   */
  semOpcaoComum?: boolean;
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
