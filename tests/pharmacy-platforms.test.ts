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
  medNameForSearch,
} from '../packages/integrations/src/pharmacy-platforms/matching.js';
import { PLATFORM_REGISTRY, activeNetworks, matchPlatformNetworkByName } from '../packages/integrations/src/pharmacy-platforms/registry.js';
import { affiliateWrap } from '../packages/integrations/src/pharmacy-platforms/index.js';
import { parseRDSearch, parseRDPrice } from '../packages/integrations/src/pharmacy-platforms/rd-adapter.js';
import { parseNisseiResults, parseNisseiPrices, parseNisseiCsrf, humanizeNisseiSlug } from '../packages/integrations/src/pharmacy-platforms/nissei-adapter.js';
import { parseUltrafarmaProducts, parseBrl } from '../packages/integrations/src/pharmacy-platforms/ultrafarma-adapter.js';
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
  it('wantsKit reconhece "+" e "leve N" (review M5) — user pedindo combo explícito', () => {
    expect(parseMedicationQuery('losartana + hidroclorotiazida').wantsKit).toBe(true);
    expect(parseMedicationQuery('leve 2 dipirona').wantsKit).toBe(true);
    expect(parseMedicationQuery('kit primeiros socorros').wantsKit).toBe(true);
    expect(parseMedicationQuery('dipirona 500mg').wantsKit).toBe(false); // sem combo → penaliza kits
  });
});

describe('matchPlatformNetworkByName — discernimento nome→canal (fundador 16/07)', () => {
  it('casa GRANDE REDE nomeada (rest/custom sempre ativas) → cota no site', () => {
    expect(matchPlatformNetworkByName('Pacheco')?.id).toBe('pacheco');
    expect(matchPlatformNetworkByName('tenta na São João')?.id).toBe('sao-joao');
    expect(matchPlatformNetworkByName('vê o preço na Ultrafarma')?.id).toBe('ultrafarma');
    expect(matchPlatformNetworkByName('Nissei')?.id).toBe('nissei');
    expect(matchPlatformNetworkByName('Pague Menos')?.id).toBe('pague-menos');
  });
  it('NÃO casa farmácia de bairro (fora do registry) → segue no WhatsApp', () => {
    expect(matchPlatformNetworkByName('Drogaria São Benedito')).toBeNull();
    expect(matchPlatformNetworkByName('Farmácia do Trabalhador')).toBeNull();
    expect(matchPlatformNetworkByName('a que respondeu')).toBeNull();
    expect(matchPlatformNetworkByName('a farmácia')).toBeNull();
  });
  it('robusto a hint vazio/curto/nulo', () => {
    expect(matchPlatformNetworkByName('')).toBeNull();
    expect(matchPlatformNetworkByName('   ')).toBeNull();
    expect(matchPlatformNetworkByName(null)).toBeNull();
    expect(matchPlatformNetworkByName('rd')).toBeNull(); // <4 chars = ruído
  });
  it('word-boundary: não casa alias/label dentro de token maior (review Leva 2 #7)', () => {
    expect(matchPlatformNetworkByName('Drogalândia da esquina')).toBeNull(); // não casa "drogal"
    expect(matchPlatformNetworkByName('Farmácia Indianópolis')).toBeNull();  // não casa "indiana"
  });
});

describe('medNameForSearch — busca pelo NOME (dosagem+forma+qtd fora); incidente Arthur 16/07', () => {
  it('remove a dosagem (a dose vai pro ranqueador, não pro ft que ela zeraria)', () => {
    // `ft=Neblock 0.5mg` devolvia 0 na VTEX; `ft=Neblock` devolve os 5 reais.
    expect(medNameForSearch('Neblock 0.5mg')).toBe('neblock');
    expect(medNameForSearch('losartana potássica 50mg')).toBe('losartana potassica');
  });
  it('remove FORMA e QUANTIDADE — também envenenam o ft literal', () => {
    // medido ao vivo: `ft=amplictil gotas` → 0 na São João; `ft=amplictil` → 3.
    expect(medNameForSearch('amplictil gotas')).toBe('amplictil');
    expect(medNameForSearch('dipirona 500mg 30 comprimidos')).toBe('dipirona');
  });
  it('dose com ESPAÇO não vaza a unidade como token-veneno (review Leva 1 #2)', () => {
    // "neblock 5 mg" NÃO pode virar "neblock mg" (mg zeraria o ft mesmo com a dose certa).
    expect(medNameForSearch('neblock 5 mg')).toBe('neblock');
    expect(medNameForSearch('dipirona 500 mg')).toBe('dipirona');
    expect(medNameForSearch('insulina 100 ui')).toBe('insulina');
  });
  it('PRESERVA sufixo curto distintivo (d3/b12) — não vira só "vitamina" (anti-regressão)', () => {
    expect(medNameForSearch('vitamina d3 2000ui')).toBe('vitamina d3');
    expect(medNameForSearch('vitamina b12')).toBe('vitamina b12');
  });
  it('preserva o nome quando não há dosagem', () => {
    expect(medNameForSearch('amoxicilina')).toBe('amoxicilina');
  });
  it('fallback pro termo normalizado quando só sobra dosagem', () => {
    // Sem nome extraível, busca com o que der (não retorna vazio, que zeraria a rede).
    expect(medNameForSearch('500mg').length).toBeGreaterThan(0);
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

  it('activeNetworks SEM ZenRows = 10 VTEX + 2 próprias (Nissei/Ultrafarma) = 12 redes', () => {
    const prev = process.env['ZENROWS_API_KEY'];
    delete process.env['ZENROWS_API_KEY'];
    const act = activeNetworks();
    expect(act.length).toBe(12);
    expect(act.every((n) => (n.access === 'rest' || n.access === 'custom') && n.enabled)).toBe(true);
    const ids = act.map((n) => n.id);
    expect(ids).toContain('pague-menos');
    expect(ids).toContain('drogal'); // regional VTEX adicionada 14/07
    expect(ids).toContain('catarinense');
    expect(ids).toContain('nissei'); // plataforma própria (Django) — ligada 15/07
    expect(ids).toContain('ultrafarma'); // plataforma própria (Angular SSR) — ligada 15/07
    expect(ids).not.toContain('drogasil'); // RD só com ZenRows
    expect(ids).not.toContain('onofre'); // representada pela Drogasil
    expect(ids).not.toContain('panvel'); // própria, atrás do Azion → registry-ready, desligada
    if (prev) process.env['ZENROWS_API_KEY'] = prev;
  });

  it('activeNetworks COM ZENROWS_API_KEY inclui a RD (Drogasil) = 13 redes', () => {
    const prev = process.env['ZENROWS_API_KEY'];
    process.env['ZENROWS_API_KEY'] = 'test-key';
    const ids = activeNetworks().map((n) => n.id);
    expect(ids).toContain('drogasil');
    expect(ids).toContain('nissei');
    expect(ids.length).toBe(13);
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

// ─── Adaptador Nissei (plataforma própria Django+ES) — shapes REAIS capturados 15/07 ──────────
describe('adaptador Nissei — parsing da busca (POST /pesquisa/pesquisar)', () => {
  const NISSEI_SEARCH = {
    produtos: [
      { _id: '355521', _score: 7.05, _source: { nm_produto: 'Losartana Potássica Ems 50mg 30 Comprimidos', url_produto: 'losartana-potassica-ems-50mg-30-comprimidos', is_disponivel: true } },
      { _id: '568523', _score: 6.9, _source: { nm_produto: 'Aradois H Losartana 50mg + Hidroclorotiazida 12,5mg 90 Comprimidos', url_produto: 'aradois-h-losartana-50mg-hidroclorotiazida-125mg-90-comprimidos', is_disponivel: true } },
      { _id: '999', _source: { nm_produto: '', url_produto: '' } }, // incompleto → filtrado
    ],
    quantidade: 423,
  };

  it('parseNisseiResults extrai id, nome, slug e disponibilidade; filtra os incompletos', () => {
    const r = parseNisseiResults(NISSEI_SEARCH);
    expect(r.length).toBe(2);
    expect(r[0]).toEqual({ id: '355521', name: 'Losartana Potássica Ems 50mg 30 Comprimidos', slug: 'losartana-potassica-ems-50mg-30-comprimidos', available: true });
  });

  it('parseNisseiResults: shape ausente → []', () => {
    expect(parseNisseiResults({})).toEqual([]);
    expect(parseNisseiResults(null)).toEqual([]);
  });

  it('o "+" do combo (Aradois H) é penalizado → losartana pura ranqueia à frente', () => {
    const net = { id: 'nissei', label: 'Farmácias Nissei', group: 'Nissei' };
    const cands = parseNisseiResults(NISSEI_SEARCH).map((r) => ({
      network: net.id, networkLabel: net.label, group: net.group, productName: r.name, sku: r.id,
      sellerId: '1', ean: null, price: 0, listPrice: null, availableQuantity: 1, productUrl: r.slug, activeIngredient: null,
    }));
    const ranked = rankProductMatches('losartana 50mg', cands);
    expect(ranked[0]!.product.sku).toBe('355521'); // Losartana pura no topo (o combo com "+" cai)
  });
});

describe('adaptador Nissei — parsing do preço (POST /pegar/preco)', () => {
  const NISSEI_PRECOS = {
    precos: {
      '355521': { publico: { produto_id: '355521', is_disponivel: true, produto_url: 'losartana-potassica-ems-50mg-30-comprimidos', valor_ini: '7.90', valor_fim: '4.90', produto_tipo: 'medicamento' } },
      '158925': { publico: { is_disponivel: true, produto_url: 'x', valor_ini: '170.83', valor_fim: '170.83' } }, // sem desconto → listPrice null
      '888': { publico: { is_disponivel: true, produto_url: 'w', valor_ini: '1.500,00', valor_fim: '1.234,56' } }, // formato BR (review M2)
      '777': { clube: { is_disponivel: true, produto_url: 'z', valor_fim: '9.90' } }, // SÓ clube, sem publico (review M1)
      '999': { publico: { is_disponivel: false, produto_url: 'y', valor_fim: '0' } }, // preço 0 → filtrado
    },
  };

  it('extrai valor_fim (preço), valor_ini (de) e disponibilidade; filtra preço 0', () => {
    const p = parseNisseiPrices(NISSEI_PRECOS);
    expect(p['355521']).toEqual({ url: 'losartana-potassica-ems-50mg-30-comprimidos', price: 4.9, listPrice: 7.9, available: true, tipo: 'medicamento' });
    expect(p['158925']!.listPrice).toBeNull(); // valor_ini == valor_fim → sem "de"
    expect(p['999']).toBeUndefined(); // preço 0 não entra
  });

  it('preço em formato BR "1.234,56" → 1234.56, NÃO 1.234 (review M2)', () => {
    const p = parseNisseiPrices(NISSEI_PRECOS);
    expect(p['888']!.price).toBe(1234.56);
    expect(p['888']!.listPrice).toBe(1500);
  });

  it('produto SÓ com preço de clube (sem publico) é PULADO — nunca expõe preço de sócio (review M1)', () => {
    expect(parseNisseiPrices(NISSEI_PRECOS)['777']).toBeUndefined();
  });

  it('shape ausente → {}', () => {
    expect(parseNisseiPrices({})).toEqual({});
    expect(parseNisseiPrices(null)).toEqual({});
  });
});

describe('adaptador Nissei — csrf + slug', () => {
  it('parseNisseiCsrf lê o token inline e o cookie csrftoken do Set-Cookie', () => {
    const html = '<form><input type="hidden" name="csrfmiddlewaretoken" value="TOKENinline1234567890abcd"></form>';
    const r = parseNisseiCsrf(html, ['csrftoken=COOKIEval9876543210; Path=/; SameSite=Lax']);
    expect(r.csrf).toBe('TOKENinline1234567890abcd');
    expect(r.cookie).toBe('COOKIEval9876543210');
  });
  it('sem token inline → usa o valor do cookie como csrf (Django aceita X-CSRFToken == cookie)', () => {
    const r = parseNisseiCsrf('<html>sem form</html>', ['csrftoken=SOcookie123456; Path=/']);
    expect(r.csrf).toBe('SOcookie123456');
    expect(r.cookie).toBe('SOcookie123456');
  });
  it('humanizeNisseiSlug: converte "1gr"→"1g" e Title Case', () => {
    expect(humanizeNisseiSlug('dipirona-1gr-10-comprimidos-medley')).toBe('Dipirona 1g 10 Comprimidos Medley');
  });
});

// ─── Adaptador Ultrafarma (Angular SSR) — HTML de card REAL (estrutura capturada 15/07) ───────
describe('adaptador Ultrafarma — parsing dos cards SSR', () => {
  const ULTRA = PLATFORM_REGISTRY.find((n) => n.id === 'ultrafarma')!;
  // Estrutura REAL (capturada ao vivo): o "De" (riscado) vem ANTES do "Por"; o preço de venda é o
  // "R$ x,yy" APÓS o rótulo "Por". Card 1 = com desconto (De R$12,90 / Por R$9,73); card 2 = sem
  // desconto num <section> (tag não-div); card 3 = sem preço (descartado).
  const ULTRA_HTML = `
    <div class="product-item col-3">
      <div class="product-image"><img src="https://cdn.ultrafarma.com.br/static/produtos/809350/small-x-809350.png" title="Dipirona 500mg 30 Comprimidos - Germed Gen&#233;rico" alt="Dipirona"></div>
      <div class="product-item-info">
        <a class="product-item-link" href="/dipirona-500-mg-com-30-comprimidos-germed-generico">ver</a>
        <span class="product-item-name">Dipirona 500mg 30 Comprimidos - Germed Gen&#233;rico</span>
        <div class="product-item-old-price-info"><p class="subtitle">De</p><span class="product-item-old-price" data-preco="12,900">R$ 12,90</span></div>
        <div class="product-item-new-price-info"><p class="subtitle">Por</p><span class="product-item-new-price" data-preco="9,730">R$ 9,73</span></div>
      </div>
    </div>
    <section class="product-item col-3">
      <div class="product-image"><img src="https://cdn.ultrafarma.com.br/static/produtos/190/small-190.jpg" title="Magnopyrol Gotas 10ml"></div>
      <div class="product-item-info">
        <a class="product-item-link" href="/magnopyrol-gotas-com-10-ml">ver</a>
        <span class="product-item-name">Magnopyrol Gotas 10ml</span>
        <span class="product-item-new-price" data-preco="21,340">R$ 21,34</span>
      </div>
    </section>
    <div class="product-item col-3">
      <div class="product-item-info"><span class="product-item-name">Sem preço não entra</span><a class="product-item-link" href="/sem-preco">x</a></div>
    </div>`;

  it('preço de VENDA vem do "Por" (pula o "De" que vem antes — review M3); "de" vira listPrice', () => {
    const ps = parseUltrafarmaProducts(ULTRA, ULTRA_HTML);
    expect(ps.length).toBe(2); // dipirona + magnopyrol; "sem preço" descartado
    expect(ps[0]!.productName).toBe('Dipirona 500mg 30 Comprimidos - Germed Genérico');
    expect(ps[0]!.sku).toBe('809350');
    expect(ps[0]!.price).toBe(9.73); // "Por R$ 9,73", NÃO o "De R$ 12,90" que vem antes
    expect(ps[0]!.listPrice).toBe(12.9);
    expect(ps[0]!.productUrl).toBe('https://www.ultrafarma.com.br/dipirona-500-mg-com-30-comprimidos-germed-generico');
  });

  it('card em <section> sem desconto (sem "Por") → 1º R$ = venda; listPrice null (review M4)', () => {
    const ps = parseUltrafarmaProducts(ULTRA, ULTRA_HTML);
    expect(ps[1]!.productName).toBe('Magnopyrol Gotas 10ml'); // parseado apesar da tag <section>
    expect(ps[1]!.price).toBe(21.34);
    expect(ps[1]!.listPrice).toBeNull();
    expect(ps[1]!.sku).toBe('190');
  });

  it('o matching escolhe o produto certo entre os cards parseados', () => {
    const ranked = rankProductMatches('dipirona 500mg comprimido', parseUltrafarmaProducts(ULTRA, ULTRA_HTML));
    expect(ranked[0]!.product.productName).toContain('Dipirona 500mg');
  });

  it('parseBrl: milhar/decimal BR e casos inválidos', () => {
    expect(parseBrl('1.234,56')).toBe(1234.56);
    expect(parseBrl('4,27')).toBe(4.27);
    expect(parseBrl('R$ 9,73')).toBe(9.73);
    expect(parseBrl('0,00')).toBeNull();
    expect(parseBrl('grátis')).toBeNull();
  });
});
