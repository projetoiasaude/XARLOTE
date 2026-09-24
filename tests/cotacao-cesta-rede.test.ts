/**
 * A cotação por rede, ponta a ponta, com as respostas da VTEX simuladas.
 *
 * Existe porque dois defeitos do modo "entrega na hora" passaram por 129 testes de função
 * pura e pela prova ao vivo, e só a revisão independente pegou (24/09):
 *   B1 — a troca de marca NUNCA rodava (`retries: 0` = zero tentativas; erro engolido);
 *   B2 — um item sem estoque apagava a entrega da cesta inteira ("sem entrega pro seu CEP"
 *        pra uma rede que entrega em 3h).
 * Aqui o caminho real (`quotePlatformBasket` → busca → simulação → escolha → mensagem) roda
 * de verdade, e as chamadas HTTP são contadas — o custo (e o risco de 429) é contrato.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { __definirClienteHttpParaTeste } from '../packages/integrations/src/pharmacy-platforms/vtex.js';

// Estado das respostas falsas da VTEX. SEM rede: a costura `__definirClienteHttpParaTeste`
// troca o cliente HTTP (um `vi.mock('axios')` não intercepta nada com pnpm — a primeira
// versão deste arquivo bateu nas APIs REAIS da Pague Menos, o que o teste agora impede).
const estado = {
  chamadas: [] as Array<{ metodo: 'get' | 'post'; url: string; body?: { items: Array<{ id: string; quantity: number }> } }>,
  catalogo: {} as Record<string, unknown[]>,
  estoque: {} as Record<string, { price: number; availability: string; slas: unknown[] }>,
  falharSimulacao: false,
};

const clienteFalso = {
  async get<T = unknown>(url: string): Promise<{ data: T }> {
    estado.chamadas.push({ metodo: 'get', url });
    const u = new URL(url);
    return { data: (estado.catalogo[`${u.host}|${u.searchParams.get('ft') ?? ''}`] ?? []) as T };
  },
  async post<T = unknown>(url: string, body: unknown): Promise<{ data: T }> {
    const b = body as { items: Array<{ id: string; quantity: number }> };
    estado.chamadas.push({ metodo: 'post', url, body: b });
    if (estado.falharSimulacao) throw new Error('Request failed with status code 429');
    return {
      data: {
        items: b.items.map((it) => ({
          id: it.id,
          price: Math.round((estado.estoque[it.id]?.price ?? 0) * 100),
          quantity: it.quantity,
          availability: estado.estoque[it.id]?.availability ?? 'unavailable',
        })),
        logisticsInfo: b.items.map((it, itemIndex) => ({ itemIndex, slas: estado.estoque[it.id]?.slas ?? [] })),
      } as T,
    };
  },
};

import { quotePlatformBasket, medNameForSearch, _clearPlatformCache } from '../packages/integrations/src/pharmacy-platforms/index.js';
import { montarMensagemDeCotacao } from '../apps/api/src/handlers/platform-quotes.js';

const CEP = '74003-010';
const PM = 'www.paguemenos.com.br';
const DSP = 'www.drogariasaopaulo.com.br';
const PACHECO = 'www.drogariaspacheco.com.br';
const EXTRAFARMA = 'www.extrafarma.com.br';

function produto(sku: string, nome: string, preco: number) {
  return {
    productName: nome,
    link: `https://x/${sku}/p`,
    items: [{ itemId: sku, sellers: [{ sellerId: '1', sellerDefault: true, commertialOffer: { Price: preco, ListPrice: preco, AvailableQuantity: 50 } }] }],
  };
}
const catalogar = (host: string, query: string, ...prods: unknown[]) => {
  estado.catalogo[`${host}|${medNameForSearch(query)}`] = prods;
};

const SUPER_60 = { id: 'super', name: 'Super Expressa', deliveryChannel: 'delivery', shippingEstimate: '60m', price: 790 };
const SUPER_3H = { id: 'super', name: 'SUPER EXPRESSA', deliveryChannel: 'delivery', shippingEstimate: '3h', price: 790 };
const NORMAL_4BD = { id: 'normal', name: 'NORMAL', deliveryChannel: 'delivery', shippingEstimate: '4bd', price: 689 };
const LOJA_304 = {
  id: 'loja-304', name: 'Retire em Loja (304)', deliveryChannel: 'pickup-in-point', shippingEstimate: '60m', price: 0,
  pickupDistance: 0.3524,
  pickupStoreInfo: { friendlyName: 'Pague Menos - Av. Goiás, 415 (Loja 304). ', address: { street: 'Avenida Goiás', number: '415', neighborhood: 'Setor Central' } },
};

const posts = () => estado.chamadas.filter((c) => c.metodo === 'post');

afterAll(() => __definirClienteHttpParaTeste(null));

it('guarda-costas: nenhuma chamada deste arquivo sai pra rede de verdade', async () => {
  __definirClienteHttpParaTeste(clienteFalso);
  await quotePlatformBasket([{ query: 'xyz 1mg', label: 'XYZ', qty: 1 }], CEP, { networkIds: ['pague-menos'] });
  expect(estado.chamadas.every((c) => c.url.startsWith('https://'))).toBe(true);
  expect(estado.chamadas.length).toBeGreaterThan(0); // passou pelo cliente falso
});

beforeEach(() => {
  __definirClienteHttpParaTeste(clienteFalso);
  _clearPlatformCache();
  estado.chamadas.length = 0;
  estado.catalogo = {};
  estado.estoque = {};
  estado.falharSimulacao = false;
});

describe('troca de marca (B1): a 1ª do ranking não chega no CEP, a 2ª chega', () => {
  it('a cotação sai com a marca que o CEP atende — e diz o prazo dela', async () => {
    catalogar(PM, 'losartana 50mg',
      produto('eurofarma', 'Losartana Potássica 50mg 30 Comprimidos Eurofarma', 11.99),
      produto('ems', 'Losartana Potássica 50mg 30 Comprimidos EMS', 12.49));
    estado.estoque = {
      eurofarma: { price: 11.99, availability: 'available', slas: [] }, // consta no catálogo, não chega aqui
      ems: { price: 12.49, availability: 'available', slas: [SUPER_60, LOJA_304] },
    };
    const [q] = await quotePlatformBasket([{ query: 'losartana 50mg', label: 'Losartana 50mg', qty: 1 }], CEP, { networkIds: ['pague-menos'] });
    expect(q).toBeDefined();
    expect(q!.lines.map((l) => l.sku)).toEqual(['ems']);
    expect(q!.missing).toEqual([]);
    expect(q!.delivery).toMatchObject({ etaText: '60 min', slaName: 'Super Expressa' });
    expect(q!.pricedByCep).toBe(true);
    // 1ª marca → alternativa. A simulação da alternativa JÁ É a cesta final (um remédio só),
    // e o cache evita perguntar de novo: 2 chamadas, não 3.
    expect(posts()).toHaveLength(2);
  });

  it('receita com 2 remédios, só um precisa de outra marca: 3 simulações — a última é a cesta REAL', async () => {
    catalogar(PM, 'dipirona 500mg', produto('dip', 'Dipirona 500mg 30 Comprimidos', 9.9));
    catalogar(PM, 'losartana 50mg',
      produto('eurofarma', 'Losartana Potássica 50mg 30 Comprimidos Eurofarma', 11.99),
      produto('ems', 'Losartana Potássica 50mg 30 Comprimidos EMS', 12.49));
    estado.estoque = {
      dip: { price: 9.9, availability: 'available', slas: [SUPER_60] },
      eurofarma: { price: 11.99, availability: 'available', slas: [] },
      ems: { price: 12.49, availability: 'available', slas: [SUPER_60] },
    };
    const [q] = await quotePlatformBasket(
      [{ query: 'dipirona 500mg', label: 'Dipirona 500mg', qty: 1 }, { query: 'losartana 50mg', label: 'Losartana 50mg', qty: 1 }],
      CEP, { networkIds: ['pague-menos'] },
    );
    expect(q!.lines.map((l) => l.sku).sort()).toEqual(['dip', 'ems']);
    const ultima = posts().at(-1)!.body!.items.map((i) => i.id).sort();
    expect(ultima).toEqual(['dip', 'ems']); // o prazo prometido vem da cesta que a pessoa vai comprar
    expect(posts()).toHaveLength(3);
  });

  it('no caso comum (a 1ª marca serve) é UMA simulação só — o custo de 429 não sobe à toa', async () => {
    catalogar(PM, 'losartana 50mg',
      produto('ems', 'Losartana Potássica 50mg 30 Comprimidos EMS', 12.49),
      produto('eurofarma', 'Losartana Potássica 50mg 30 Comprimidos Eurofarma', 11.99));
    estado.estoque = { ems: { price: 12.49, availability: 'available', slas: [SUPER_60] } };
    await quotePlatformBasket([{ query: 'losartana 50mg', label: 'Losartana 50mg', qty: 1 }], CEP, { networkIds: ['pague-menos'] });
    expect(posts()).toHaveLength(1);
  });

  it('a mesma cotação de novo em 5 min não bate na rede (cache de busca e de simulação)', async () => {
    catalogar(PM, 'losartana 50mg', produto('ems', 'Losartana Potássica 50mg 30 Comprimidos EMS', 12.49));
    estado.estoque = { ems: { price: 12.49, availability: 'available', slas: [SUPER_60] } };
    const pedido = [{ query: 'losartana 50mg', label: 'Losartana 50mg', qty: 1 }];
    await quotePlatformBasket(pedido, CEP, { networkIds: ['pague-menos'] });
    const antes = estado.chamadas.length;
    await quotePlatformBasket(pedido, CEP, { networkIds: ['pague-menos'] });
    expect(estado.chamadas.length).toBe(antes);
  });
});

describe('item sem estoque (B2) NÃO apaga a entrega dos outros', () => {
  it('losartana sai em 3h mesmo com o omeprazol da receita sem estoque — e o omeprazol vira "não achei aqui"', async () => {
    catalogar(DSP, 'losartana 50mg', produto('los', 'Losartana Potássica 50mg 30 Comprimidos', 11.99));
    catalogar(DSP, 'omeprazol 20mg', produto('ome', 'Omeprazol 20mg 28 Cápsulas', 19.9));
    estado.estoque = {
      los: { price: 11.99, availability: 'available', slas: [SUPER_3H] },
      ome: { price: 19.9, availability: 'cannotBeDelivered', slas: [] },
    };
    const [q] = await quotePlatformBasket(
      [{ query: 'losartana 50mg', label: 'Losartana 50mg', qty: 1 }, { query: 'omeprazol 20mg', label: 'Omeprazol 20mg', qty: 1 }],
      CEP, { networkIds: ['drogaria-sao-paulo'] },
    );
    expect(q!.lines.map((l) => l.sku)).toEqual(['los']);
    expect(q!.missing).toEqual(['Omeprazol 20mg']);
    expect(q!.delivery).toMatchObject({ etaText: '3 horas' });
    const { texto } = montarMensagemDeCotacao([q!], { soleChannel: true, totalDeItens: 2 });
    expect(texto).not.toMatch(/sem entrega/i);
    expect(texto).toContain('⚡ chega em 3 horas');
    expect(texto).toContain('não achei aqui: Omeprazol 20mg');
  });
});

describe('rede que não respondeu (429) — nunca "sem entrega pro seu CEP"', () => {
  it('a simulação falhou: preço de catálogo e "confira o prazo no site"', async () => {
    catalogar(PM, 'dipirona 500mg', produto('dip', 'Dipirona 500mg 30 Comprimidos', 9.9));
    estado.falharSimulacao = true;
    const [q] = await quotePlatformBasket([{ query: 'dipirona 500mg', label: 'Dipirona 500mg', qty: 1 }], CEP, { networkIds: ['pague-menos'] });
    expect(q!.pricedByCep).toBe(false);
    const { texto } = montarMensagemDeCotacao([q!], { soleChannel: true, totalDeItens: 1 });
    expect(texto).toContain('confira o prazo no site');
    expect(texto).not.toMatch(/sem entrega pro seu CEP/i);
    expect(texto).not.toMatch(/hoje mesmo/i);
  });
});

describe('mesmo grupo (DSP + Pacheco): fica a que entrega mais rápido, não a mais barata (C6)', () => {
  it('Pacheco R$ 11 em 4 dias úteis perde pra DSP R$ 15 em 3h', async () => {
    catalogar(DSP, 'dipirona 500mg', produto('dsp-dip', 'Dipirona 500mg 30 Comprimidos', 15));
    catalogar(PACHECO, 'dipirona 500mg', produto('pch-dip', 'Dipirona 500mg 30 Comprimidos', 11));
    estado.estoque = {
      'dsp-dip': { price: 15, availability: 'available', slas: [SUPER_3H] },
      'pch-dip': { price: 11, availability: 'available', slas: [NORMAL_4BD] },
    };
    const qs = await quotePlatformBasket([{ query: 'dipirona 500mg', label: 'Dipirona 500mg', qty: 1 }], CEP, { networkIds: ['drogaria-sao-paulo', 'pacheco'] });
    expect(qs).toHaveLength(1);
    expect(qs[0]!.network).toBe('drogaria-sao-paulo');
  });
});

describe('a mensagem (montarMensagemDeCotacao) — só promete o que a rede confirmou', () => {
  it('receita inteira na hora → "hoje mesmo", o nome da opção pra escolher no site, e a loja', async () => {
    catalogar(PM, 'amoxicilina 500mg', produto('amox', 'Amoxicilina 500mg 21 Cápsulas EMS', 10.49));
    estado.estoque = { amox: { price: 10.49, availability: 'available', slas: [{ ...NORMAL_4BD, shippingEstimate: '1bd', price: 490 }, LOJA_304] } };
    const [q] = await quotePlatformBasket([{ query: 'amoxicilina 500mg', label: 'Amoxicilina 500mg', qty: 1 }], CEP, { networkIds: ['pague-menos'] });
    const { texto } = montarMensagemDeCotacao([q!], { soleChannel: true, totalDeItens: 1 });
    expect(texto).toContain('hoje mesmo');
    expect(texto).toContain('R$ 10,49 · ⚡ retire em 60 min');                 // preço de RETIRAR, sem o frete
    expect(texto).toContain('na *Pague Menos - Av. Goiás, 415 (Loja 304)* (350 m)');
    expect(texto).toContain('escolha *retirar na loja*');
    expect(texto).toContain('leve ela');                                        // a receita
    expect(texto).not.toContain('mesmo grupo');                                 // a loja É da rede
  });

  it('retirada numa fachada de rede IRMÃ (Extrafarma → Pague Menos) é explicada, não parece erro', async () => {
    catalogar(EXTRAFARMA, 'losartana 50mg', produto('los', 'Losartana Potássica 50mg 30 Comprimidos', 11.89));
    estado.estoque = { los: { price: 11.89, availability: 'available', slas: [SUPER_3H, LOJA_304] } };
    const [q] = await quotePlatformBasket([{ query: 'losartana 50mg', label: 'Losartana 50mg', qty: 1 }], CEP, { networkIds: ['extrafarma'] });
    expect(q!.pickup?.store?.marcaDoGrupo).toBe('Pague Menos');
    const { texto } = montarMensagemDeCotacao([q!], { soleChannel: true, totalDeItens: 1 });
    expect(texto).toContain('na *Pague Menos - Av. Goiás, 415 (Loja 304)* (350 m) — loja do mesmo grupo');
  });

  it('só uma PARTE resolve hoje → não promete a receita toda pra hoje (C3)', () => {
    const rapidaParcial = {
      network: 'pague-menos', networkLabel: 'Pague Menos', group: 'PM', lines: [{ requested: 'A', productName: 'A', sku: 'a', sellerId: '1', price: 10, qty: 1, matchScore: 1 }],
      missing: ['B'], total: 10, available: true, delivery: { etaText: '60 min', feeReais: 7.9, etaMinutes: 60, slaName: 'Super Expressa' }, pickup: null,
      checkoutUrl: 'https://x', pricedByCep: true,
    };
    const lentaCompleta = {
      ...rapidaParcial, network: 'drogal', networkLabel: 'Drogal', group: 'Drogal',
      lines: [...rapidaParcial.lines, { requested: 'B', productName: 'B', sku: 'b', sellerId: '1', price: 10, qty: 1, matchScore: 1 }],
      missing: [], total: 20, delivery: { etaText: '4 dias úteis', feeReais: 10, etaMinutes: 4 * 24 * 60, slaName: 'NORMAL' },
    };
    const { texto, top } = montarMensagemDeCotacao([lentaCompleta, rapidaParcial], { soleChannel: true, totalDeItens: 2 });
    expect(top).toHaveLength(2);                       // a rápida NÃO some
    expect(texto).toContain('Uma parte você consegue *hoje mesmo*');
    expect(texto).not.toMatch(/Achei.*você consegue \*hoje mesmo\*/);
  });
});
