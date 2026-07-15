import { describe, expect, it } from 'vitest';
import {
  mapVtexProduct,
  parseVtexSimulation,
  parseVtexBasketSimulation,
  formatShippingEstimate,
  estimateToMinutes,
  buildVtexCartLink,
  buildVtexCartLinkMulti,
} from '../packages/integrations/src/pharmacy-platforms/vtex.js';
import {
  parseMedicationQuery,
  scoreProductMatch,
  rankProductMatches,
  normalize,
  extractStrengths,
  strengthsCompatible,
} from '../packages/integrations/src/pharmacy-platforms/matching.js';
import { PLATFORM_REGISTRY, activeNetworks } from '../packages/integrations/src/pharmacy-platforms/registry.js';
import { affiliateWrap } from '../packages/integrations/src/pharmacy-platforms/index.js';
import { parseRDSearch, parseRDPrice } from '../packages/integrations/src/pharmacy-platforms/rd-adapter.js';
import { extractCep } from '../packages/shared/src/pharmacy.js';

const NET = { id: 'x', label: 'Rede X', group: 'GX' };

// Shapes REAIS capturados ao vivo em 2026-07-14 (ver docs/PHARMACY_PLATFORMS.md).
const RAW_DIPIRONA_500_CP = {
  productName: 'Dipirona Monoidratada 500mg 30 Comprimidos Genérico Neo Química',
  link: 'https://www.drogariasaopaulo.com.br/dipirona-500mg-30-comprimidos/p',
  items: [{ itemId: '111', ean: '7891', sellers: [{ sellerId: '1', sellerDefault: true, commertialOffer: { Price: 7.91, ListPrice: 24.84, AvailableQuantity: 99999 } }] }],
  'Princípio Ativo': ['Dipirona'],
};
const RAW_DIPIRONA_1G = {
  productName: 'Dipirona Sódica 1g 10 Comprimidos',
  link: 'https://x/dipirona-1g/p',
  items: [{ itemId: '222', ean: '7892', sellers: [{ sellerId: '1', sellerDefault: true, commertialOffer: { Price: 12.5, ListPrice: 12.5, AvailableQuantity: 50 } }] }],
};
const RAW_KIT = {
  productName: 'Kit Novalgina 50mg/ml Sabor Framboesa 100ml +  Allegra Pediátrico 6mg/ml 60ml',
  link: 'https://x/kit/p',
  items: [{ itemId: '333', ean: 'KIT-1', sellers: [{ sellerId: '1', sellerDefault: true, commertialOffer: { Price: 80.28, ListPrice: 80.28, AvailableQuantity: 99999 } }] }],
};
const RAW_GOTAS = {
  productName: 'Dipirona 500mg/ml Solução Gotas 20ml',
  link: 'https://x/gotas/p',
  items: [{ itemId: '444', ean: '7893', sellers: [{ sellerId: '1', sellerDefault: true, commertialOffer: { Price: 9.9, ListPrice: 9.9, AvailableQuantity: 10 } }] }],
};

describe('mapVtexProduct (parsing do catálogo VTEX)', () => {
  it('extrai nome, sku, preço, listPrice, link e princípio ativo', () => {
    const p = mapVtexProduct(NET, RAW_DIPIRONA_500_CP)!;
    expect(p).toBeTruthy();
    expect(p.sku).toBe('111');
    expect(p.price).toBe(7.91);
    expect(p.listPrice).toBe(24.84);
    expect(p.ean).toBe('7891');
    expect(p.productUrl).toContain('/p');
    expect(p.activeIngredient).toEqual(['Dipirona']);
    expect(p.network).toBe('x');
  });

  it('listPrice só quando MAIOR que o preço (sem desconto → null)', () => {
    const p = mapVtexProduct(NET, RAW_DIPIRONA_1G)!;
    expect(p.listPrice).toBeNull();
  });

  it('entre vários sellers, escolhe disponível de menor preço', () => {
    const raw = {
      productName: 'Remédio Y',
      link: 'https://x/y/p',
      items: [
        { itemId: 'a', sellers: [{ commertialOffer: { Price: 30, AvailableQuantity: 0 } }] }, // indisponível
        { itemId: 'b', sellers: [{ commertialOffer: { Price: 25, AvailableQuantity: 5 } }, { commertialOffer: { Price: 20, AvailableQuantity: 5 } }] },
      ],
    };
    const p = mapVtexProduct(NET, raw)!;
    expect(p.sku).toBe('b');
    expect(p.price).toBe(20);
  });

  it('retorna null quando não há item/preço válido', () => {
    expect(mapVtexProduct(NET, { productName: 'X', items: [] })).toBeNull();
    expect(mapVtexProduct(NET, { productName: 'X', items: [{ itemId: 'z', sellers: [{ commertialOffer: { Price: 0 } }] }] })).toBeNull();
    expect(mapVtexProduct(NET, null)).toBeNull();
  });
});

describe('parseVtexSimulation (preço/estoque/entrega por CEP)', () => {
  // Amostra real: Drogaria São Paulo, dipirona @ 74230-100 (14 SLAs; recorte de 2).
  const SIM = {
    items: [{ price: 791, listPrice: 2484, availability: 'available', quantity: 1 }],
    logisticsInfo: [{ slas: [
      { name: 'NORMAL', deliveryChannel: 'delivery', shippingEstimate: '1bd', price: 689 },
      { name: 'EXPRESSA', deliveryChannel: 'delivery', shippingEstimate: '2h', price: 1490 },
      { name: 'RETIRE NA LOJA (2448)', deliveryChannel: 'pickup-in-point', shippingEstimate: '60m', price: 0 },
    ] }],
  };

  it('converte centavos→reais e lê disponibilidade', () => {
    const f = parseVtexSimulation(SIM)!;
    expect(f.price).toBe(7.91);
    expect(f.listPrice).toBe(24.84);
    expect(f.available).toBe(true);
  });

  it('separa ENTREGA de RETIRADA e escolhe a mais rápida de cada', () => {
    const f = parseVtexSimulation(SIM)!;
    // entrega mais rápida = EXPRESSA (2h) e não NORMAL (1 dia útil)
    expect(f.delivery).toEqual({ etaText: '2 horas', feeReais: 14.9 });
    expect(f.pickup).toEqual({ etaText: '60 min', feeReais: 0 });
  });

  it('sem entrega em domicílio (só retirada) → delivery null', () => {
    const f = parseVtexSimulation({
      items: [{ price: 500, availability: 'available' }],
      logisticsInfo: [{ slas: [{ deliveryChannel: 'pickup-in-point', shippingEstimate: '60m', price: 0 }] }],
    })!;
    expect(f.delivery).toBeNull();
    expect(f.pickup).not.toBeNull();
  });

  it('retorna null quando não há item com preço', () => {
    expect(parseVtexSimulation({ items: [] })).toBeNull();
    expect(parseVtexSimulation({ items: [{ price: 0, availability: 'available' }] })).toBeNull();
  });

  it('descarta SLA-sentinela (São João: 30 dias / R$1000) → sem entrega falsa', () => {
    const f = parseVtexSimulation({
      items: [{ price: 505, availability: 'available' }],
      logisticsInfo: [{ slas: [{ name: 'Entrega padrão', deliveryChannel: 'delivery', shippingEstimate: '30d', price: 100000 }] }],
    })!;
    expect(f.price).toBe(5.05);
    expect(f.delivery).toBeNull(); // frete R$1000/30d é sentinela → não vira opção real
  });
});

describe('formatShippingEstimate / estimateToMinutes', () => {
  it('formata prazos em PT-BR', () => {
    expect(formatShippingEstimate('60m')).toBe('60 min');
    expect(formatShippingEstimate('2h')).toBe('2 horas');
    expect(formatShippingEstimate('1bd')).toBe('1 dia útil');
    expect(formatShippingEstimate('5bd')).toBe('5 dias úteis');
    expect(formatShippingEstimate('3d')).toBe('3 dias');
  });
  it('ordena prazos por rapidez (min < horas < dias)', () => {
    expect(estimateToMinutes('60m')).toBeLessThan(estimateToMinutes('2h'));
    expect(estimateToMinutes('2h')).toBeLessThan(estimateToMinutes('1bd'));
  });
});

describe('normalize / extractStrengths', () => {
  it('remove acentos (prova o regex de diacríticos)', () => {
    expect(normalize('Solução Cápsula Sódica')).toBe('solucao capsula sodica');
  });
  it('extrai dosagens normalizadas', () => {
    expect(extractStrengths('dipirona 500 mg 30 comprimidos')).toEqual(['500mg']);
    expect(extractStrengths('novalgina 50mg/ml 100ml')).toEqual(expect.arrayContaining(['50mg']));
  });
});

describe('parseMedicationQuery', () => {
  it('separa nome, dosagem, forma e quantidade', () => {
    const q = parseMedicationQuery('dipirona 500mg 30 comprimidos');
    expect(q.nameTokens).toEqual(['dipirona']);
    expect(q.strengths).toEqual(['500mg']);
    expect(q.form).toBe('comprimido');
    expect(q.quantity).toBe(30);
    expect(q.wantsKit).toBe(false);
  });
  it('nome composto (losartana potássica)', () => {
    const q = parseMedicationQuery('losartana potássica 50mg');
    expect(q.nameTokens).toEqual(['losartana', 'potassica']);
    expect(q.strengths).toEqual(['50mg']);
  });
});

describe('scoreProductMatch (o ponto crítico de qualidade)', () => {
  it('casa dipirona 500mg com o produto certo (score alto)', () => {
    const q = parseMedicationQuery('dipirona 500mg comprimido');
    const p = mapVtexProduct(NET, RAW_DIPIRONA_500_CP)!;
    expect(scoreProductMatch(q, p)).toBeGreaterThan(0.7);
  });

  it('REJEITA o Kit Novalgina+Allegra quando se pediu "dipirona" (nome não bate)', () => {
    const q = parseMedicationQuery('dipirona');
    const kit = mapVtexProduct(NET, RAW_KIT)!;
    expect(scoreProductMatch(q, kit)).toBe(0);
  });

  it('penaliza KIT mesmo quando o nome bate (pediu "novalgina", veio kit)', () => {
    const q = parseMedicationQuery('novalgina');
    const kit = mapVtexProduct(NET, RAW_KIT)!;
    const score = scoreProductMatch(q, kit);
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(0.5); // penalidade multiplicativa derruba abaixo do limiar
  });

  it('dosagem certa (500mg) pontua mais que dosagem errada (1g)', () => {
    const q = parseMedicationQuery('dipirona 500mg');
    const p500 = mapVtexProduct(NET, RAW_DIPIRONA_500_CP)!;
    const p1g = mapVtexProduct(NET, RAW_DIPIRONA_1G)!;
    expect(scoreProductMatch(q, p500)).toBeGreaterThan(scoreProductMatch(q, p1g));
  });
});

describe('rankProductMatches', () => {
  it('ordena por relevância e FILTRA o kit abaixo do limiar', () => {
    const products = [RAW_KIT, RAW_DIPIRONA_1G, RAW_DIPIRONA_500_CP, RAW_GOTAS].map((r) => mapVtexProduct(NET, r)!);
    const ranked = rankProductMatches('dipirona 500mg comprimido', products);
    expect(ranked[0]!.product.sku).toBe('111'); // dipirona 500mg comprimido no topo
    expect(ranked.every((r) => !/kit/i.test(r.product.productName))).toBe(true); // kit fora
  });

  it('quando nada casa o nome, retorna vazio (chamador confirma com o usuário)', () => {
    const products = [mapVtexProduct(NET, RAW_DIPIRONA_500_CP)!];
    expect(rankProductMatches('amoxicilina 500mg', products)).toEqual([]);
  });
});

describe('buildVtexCartLink + registry', () => {
  it('monta link de carrinho pré-montado (formato validado ao vivo)', () => {
    const sp = PLATFORM_REGISTRY.find((n) => n.id === 'drogaria-sao-paulo')!;
    expect(buildVtexCartLink(sp, '883646', 1)).toBe(
      'https://www.drogariasaopaulo.com.br/checkout/cart/add?sku=883646&qty=1&seller=1&sc=1',
    );
  });

  it('activeNetworks SEM ZenRows = só Grupo A (rest, enabled) — 10 redes', () => {
    const prev = process.env['ZENROWS_API_KEY'];
    delete process.env['ZENROWS_API_KEY'];
    const act = activeNetworks();
    expect(act.length).toBe(10);
    expect(act.every((n) => n.access === 'rest' && n.enabled)).toBe(true);
    const ids = act.map((n) => n.id);
    expect(ids).toContain('pague-menos');
    expect(ids).toContain('drogal'); // regional VTEX adicionada 14/07
    expect(ids).toContain('catarinense');
    expect(ids).not.toContain('drogasil'); // RD só com ZenRows
    expect(ids).not.toContain('onofre'); // representada pela Drogasil
    expect(ids).not.toContain('nissei'); // plataforma própria desligada
    if (prev) process.env['ZENROWS_API_KEY'] = prev;
  });

  it('activeNetworks COM ZENROWS_API_KEY inclui a RD (Drogasil)', () => {
    const prev = process.env['ZENROWS_API_KEY'];
    process.env['ZENROWS_API_KEY'] = 'test-key';
    expect(activeNetworks().map((n) => n.id)).toContain('drogasil');
    if (prev) process.env['ZENROWS_API_KEY'] = prev; else delete process.env['ZENROWS_API_KEY'];
  });
});

// ─── Achados do review adversarial (H1, M1, L3) ───────────────────────────────
describe('strengthsCompatible (normalização de unidade — review H1)', () => {
  it('1g equivale a 1000mg', () => expect(strengthsCompatible(['1g'], ['1000mg'])).toBe(true));
  it('88mcg NÃO equivale a 100mcg (levotiroxina, índice estreito)', () => expect(strengthsCompatible(['88mcg'], ['100mcg'])).toBe(false));
  it('500mg==500mg; 500mg≠250mg', () => {
    expect(strengthsCompatible(['500mg'], ['500mg'])).toBe(true);
    expect(strengthsCompatible(['500mg'], ['250mg'])).toBe(false);
  });
  it('lista vazia → incompatível', () => expect(strengthsCompatible([], ['500mg'])).toBe(false));
});

describe('scoreProductMatch — dosagem/forma DIVERGENTE é rejeitada (review H1)', () => {
  it('pede 1g, só tem 500mg → rejeitado (<0.5)', () => {
    const q = parseMedicationQuery('dipirona 1g comprimido');
    expect(scoreProductMatch(q, mapVtexProduct(NET, RAW_DIPIRONA_500_CP)!)).toBeLessThan(0.5);
  });
  it('pede gotas, só tem comprimido → rejeitado', () => {
    const q = parseMedicationQuery('dipirona gotas');
    expect(scoreProductMatch(q, mapVtexProduct(NET, RAW_DIPIRONA_500_CP)!)).toBeLessThan(0.5);
  });
  it('pede gotas e TEM gotas → aceito', () => {
    const q = parseMedicationQuery('dipirona gotas');
    expect(scoreProductMatch(q, mapVtexProduct(NET, RAW_GOTAS)!)).toBeGreaterThan(0.6);
  });
  it('dosagem equivalente por unidade (pede 1g, tem 1000mg) → aceito', () => {
    const raw1000 = { productName: 'Dipirona 1000mg 10 Comprimidos', link: 'https://x/p', items: [{ itemId: '999', sellers: [{ sellerId: '1', commertialOffer: { Price: 10, AvailableQuantity: 5 } }] }] };
    const q = parseMedicationQuery('dipirona 1g');
    expect(scoreProductMatch(q, mapVtexProduct(NET, raw1000)!)).toBeGreaterThan(0.6);
  });
  it('rankProductMatches filtra a dosagem errada (1g fora quando se pede 500mg)', () => {
    const products = [RAW_DIPIRONA_1G, RAW_DIPIRONA_500_CP].map((r) => mapVtexProduct(NET, r)!);
    const ranked = rankProductMatches('dipirona 500mg', products);
    expect(ranked.every((r) => r.product.sku !== '222')).toBe(true);
  });
});

describe('sellerId propagado (review M1) + affiliateWrap', () => {
  it('mapVtexProduct captura o sellerId da oferta escolhida (marketplace ≠ 1)', () => {
    const raw = { productName: 'X', link: 'https://x/p', items: [{ itemId: 's1', sellers: [{ sellerId: '2', commertialOffer: { Price: 9, AvailableQuantity: 5 } }] }] };
    expect(mapVtexProduct(NET, raw)!.sellerId).toBe('2');
  });
  it('sellerId default "1" quando ausente', () => {
    expect(mapVtexProduct(NET, RAW_DIPIRONA_500_CP)!.sellerId).toBe('1');
  });
  it('buildVtexCartLink usa o seller informado', () => {
    const pk = PLATFORM_REGISTRY.find((n) => n.id === 'pacheco')!;
    expect(buildVtexCartLink(pk, '900680', 1, '2')).toContain('seller=2');
  });
  it('affiliateWrap: sem env → url crua; com template {url} → envelopa e encoda', () => {
    delete process.env['PLATFORM_AFFILIATE_PAGUE_MENOS'];
    expect(affiliateWrap('pague-menos', 'https://x/cart')).toBe('https://x/cart');
    process.env['PLATFORM_AFFILIATE_PAGUE_MENOS'] = 'https://awin/cread?ued={url}';
    expect(affiliateWrap('pague-menos', 'https://x/cart?a=1')).toBe('https://awin/cread?ued=' + encodeURIComponent('https://x/cart?a=1'));
    delete process.env['PLATFORM_AFFILIATE_PAGUE_MENOS'];
  });
});

describe('cesta multi-item (auditoria 1º pedido — P2)', () => {
  it('buildVtexCartLinkMulti: 1 link com os N SKUs (sku/qty/seller repetidos)', () => {
    const pm = PLATFORM_REGISTRY.find((n) => n.id === 'pague-menos')!;
    const url = buildVtexCartLinkMulti(pm, [{ sku: '52332', seller: '1', qty: 1 }, { sku: '110303', seller: '1', qty: 2 }]);
    expect(url).toBe('https://www.paguemenos.com.br/checkout/cart/add?sku=52332&qty=1&seller=1&sku=110303&qty=2&seller=1&sc=1');
  });

  it('parseVtexBasketSimulation: soma o total (price×qty) e separa por sku', () => {
    const sim = {
      items: [
        { id: '52332', price: 2699, quantity: 1, availability: 'available' },
        { id: '110303', price: 499, quantity: 2, availability: 'available' },
      ],
      logisticsInfo: [{ slas: [{ deliveryChannel: 'delivery', shippingEstimate: '60m', price: 790 }] }],
    };
    const r = parseVtexBasketSimulation(sim)!;
    expect(r.total).toBeCloseTo(26.99 + 4.99 * 2, 2); // 36.97
    expect(r.perSku['52332']).toEqual({ price: 26.99, available: true });
    expect(r.allAvailable).toBe(true);
    expect(r.delivery).toEqual({ etaText: '60 min', feeReais: 7.9 });
  });

  it('parseVtexBasketSimulation: item indisponível não entra no total e marca allAvailable=false', () => {
    const r = parseVtexBasketSimulation({
      items: [
        { id: 'a', price: 1000, quantity: 1, availability: 'available' },
        { id: 'b', price: 5000, quantity: 1, availability: 'unavailable' },
      ],
    })!;
    expect(r.total).toBe(10); // só o item 'a'
    expect(r.allAvailable).toBe(false);
    expect(r.perSku['b']!.available).toBe(false);
  });
});

describe('adaptador RD (Drogasil via ZenRows) — parsing do __NEXT_DATA__', () => {
  it('parseRDSearch extrai produtos válidos (sku+name+url) e filtra os incompletos', () => {
    const nd = { props: { pageProps: { pageProps: { results: { products: [
      { sku: '19853', name: 'Novalgina Infantil Dipirona 50mg/ml', url: '/novalgina.html?origin=search', brand: 'Novalgina', isKit: false },
      { sku: '999', name: '', url: '/x' }, // sem name → filtrado
    ] } } } } };
    const hits = parseRDSearch(nd);
    expect(hits.length).toBe(1);
    expect(hits[0]!.sku).toBe('19853');
    expect(hits[0]!.url).toContain('novalgina');
  });
  it('parseRDSearch: shape ausente → []', () => {
    expect(parseRDSearch({})).toEqual([]);
    expect(parseRDSearch(null)).toEqual([]);
  });
  it('parseRDPrice extrai value_to (preço) e value_from (de)', () => {
    const nd = { props: { pageProps: { productData: { sku: '19853', price: 0, price_aux: { value_to: 41.99, value_from: 49.03 } } } } };
    expect(parseRDPrice(nd)).toEqual({ price: 41.99, listPrice: 49.03 });
  });
  it('parseRDPrice: value_from ≤ preço → sem listPrice; sem preço → null', () => {
    expect(parseRDPrice({ props: { pageProps: { productData: { price_aux: { value_to: 10, value_from: 10 } } } } })).toEqual({ price: 10, listPrice: null });
    expect(parseRDPrice({ props: { pageProps: { productData: { price_aux: { value_to: 0 } } } } })).toBeNull();
    expect(parseRDPrice({})).toBeNull();
  });
});

describe('extractCep (review L3)', () => {
  it('prefere formato com hífen', () => {
    expect(extractCep('Rua X, 100, Setor Y, Goiânia - GO, CEP 74230-100')).toBe('74230100');
  });
  it('8 dígitos juntos', () => {
    expect(extractCep('Av T-63 876, Setor Bueno 74230100')).toBe('74230100');
  });
  it('pega o CEP no fim, não o número de rua no meio', () => {
    expect(extractCep('Rua 14, 876, St Oeste, 74110020')).toBe('74110020');
  });
  it('sem CEP → null', () => {
    expect(extractCep('Rua sem cep, Bairro X')).toBeNull();
    expect(extractCep(null)).toBeNull();
  });
});
