/**
 * Farmácia Modelo (Goiânia, St. Oeste) — a fonte com entrega em ~1h DENTRO do Setor Oeste
 * (pesquisa de 28/09/2026). Fixtures = respostas REAIS do site (busca "dipirona", prazo pro CEP
 * 74115-060 e o "sem estoque" pra um CEP de Brasília), compactadas.
 */
import { describe, it, expect } from 'vitest';
import {
  parseModeloBusca, parseModeloModalidades, prazoEmMinutos, horarioDaLoja, prontoNaLoja,
  combinarSimulacaoModelo, LOJA_MODELO,
} from '../packages/integrations/src/pharmacy-platforms/modelo-adapter.js';
import { linkDeBuscaNoIfood } from '../packages/integrations/src/pharmacy-platforms/ifood-links.js';
import { cobertaPeloSite } from '../packages/shared/src/pharmacy.js';

const NET = { id: 'farmacia-modelo', label: 'Farmácia Modelo', group: 'Modelo', host: 'https://farmaciamodelo.com.br' };
const BUSCA = "<div class=\"item-box columns small-6 medium-6 large-4 xlarge-3\" style=\"z-index:32\"> <div class=\"item-prod\" data-equalizer-watch=\"prod\"> <ul class=\"no-bullet\"> <li class=\"imagem text-center\" data-equalizer-watch=\"imagemprod\"> <div class=\"etiqueta\"> <ul class=\"no-bullet\"> <li></li> </ul> </div> <a href=\"/dipirona-sodica-500mg-gotas-20ml/3417-01\" class=\"link-prod\"> <img src=\"/BACKOFFICE/Uploads/Produto/Normal/7896422506236.jpg\" alt=\"Dipirona Sodica 500mg Gotas 20ml\"> </a> </li> <li class=\"nome\" data-equalizer-watch=\"nomeprod\"> <a href=\"/dipirona-sodica-500mg-gotas-20ml/3417-01\" class=\"link-prod\"> <h2>Dipirona Sodica 500mg Gotas 20ml</h2> </a> <a href=\"/busca-marca/medleygen/12815\"><small class=\"marca\" data-equalizer-watch=\"nomeprod\">MEDLEYGEN</small></a> </li> <li class=\"preco\" data-equalizer-watch=\"precoprod\"> <p class=\"preco-por\"> Por: <strong> R$ 9,99 </strong> </p> </li> <li class=\"botao\"> <ul class=\"no-bullet\"> <li class=\"qtd-carrinho\"> <div class=\"row collapse\"> <div class=\"large-12\"> </div> <div class=\"columns small-12 large-12\"> <h6>QUANTIDADE</h6> <div class=\"centered\"> <a class=\"button radius menos tiny\" data-compra=\"\"><i class=\"fa fa-minus\"></i></a> <input type=\"number\" text=\"\" value=\"1\" pattern=\"number\" disabled=\"disabled\"> <a class=\"button radius mais tiny\" data-compra=\"\"><i class=\"fa fa-plus\"></i></a> </div> </div> </div> </li> <li> <div class=\"row collapse\"> <div class=\"columns small-12\"> <a role=\"button\" aria-label=\"Comprar Nome do Produto\" class=\"button comprar-vitrine radius success tiny\" id=\"comprar-vitrine\" data-compra=\"3417\"> <i class=\"fa fa-shopping-basket\"></i> <strong>ADICIONAR <span class=\"hideMobile\"> A CESTA</span></strong> </a> </div> </div> </li> </ul> </li> </ul> </div> </div> <div class=\"item-box columns small-6 medium-6 large-4 xlarge-3\" style=\"z-index:31\"> <div class=\"item-prod\" data-equalizer-watch=\"prod\"> <ul class=\"no-bullet\"> <li class=\"imagem text-center\" data-equalizer-watch=\"imagemprod\"> <div class=\"etiqueta\"> <ul class=\"no-bullet\"> <li></li> </ul> </div> <a href=\"/dipirona-monoidratada-500mg-prati-donaduzzi-com-30-comprimidos/7240-01\" class=\"link-prod\"> <img src=\"/BACKOFFICE/Uploads/Produto/Normal/7899547531213.jpg\" alt=\"Dipirona Monoidratada 500mg Prati Donaduzzi com 30 comprimidos\"> </a> </li> <li class=\"nome\" data-equalizer-watch=\"nomeprod\"> <a href=\"/dipirona-monoidratada-500mg-prati-donaduzzi-com-30-comprimidos/7240-01\" class=\"link-prod\"> <h2>Dipirona Monoidratada 500mg Prati Donaduzzi com 30 comp...</h2> </a> <a href=\"/busca-marca/prati-dona/12205\"><small class=\"marca\" data-equalizer-watch=\"nomeprod\">PRATI DONA</small></a> </li> <li class=\"preco\" data-equalizer-watch=\"precoprod\"> <p class=\"preco-por\"> Por: <strong> R$ 14,49 </strong> </p> </li> <li class=\"botao\"> <ul class=\"no-bullet\"> <li class=\"qtd-carrinho\"> <div class=\"row collapse\"> <div class=\"large-12\"> </div> <div class=\"columns small-12 large-12\"> <h6>QUANTIDADE</h6> <div class=\"centered\"> <a class=\"button radius menos tiny\" data-compra=\"\"><i class=\"fa fa-minus\"></i></a> <input type=\"number\" text=\"\" value=\"1\" pattern=\"number\" disabled=\"disabled\"> <a class=\"button radius mais tiny\" data-compra=\"\"><i class=\"fa fa-plus\"></i></a> </div> </div> </div> </li> <li> <div class=\"row collapse\"> <div class=\"columns small-12\"> <a role=\"button\" aria-label=\"Comprar Nome do Produto\" class=\"button comprar-vitrine radius success tiny\" id=\"comprar-vitrine\" data-compra=\"7240\"> <i class=\"fa fa-shopping-basket\"></i> <strong>ADICIONAR <span class=\"hideMobile\"> A CESTA</span></strong> </a> </div> </div> </li> </ul> </li> </ul> </div> </div> ";
const VIEW = " <script src=\"/Assets/lib/js/jquery.mask.min.js\"></script> <script src=\"/Assets/js/detalheProdutoModalidade.js\"></script> <div class=\"simulacao-de-frete-ajax\"> <h3><i class=\"fa fa-truck left\"></i>PRAZO DE<strong> ENTREGA</strong></h3> <table> <thead> <tr> <th colspan=\"4\"> <div class=\"row collapse\"> <div class=\"columns large-5\"> <input type=\"text\" id=\"txt-cep\" data-mask=\"00000-000\" placeholder=\"INSIRA SEU CEP\" /> </div> <div class=\"columns large-1\"> <a class=\"button postfix\" id=\"btn-frete\">OK</a> </div> <div class=\"columns large-6\"> <a href=\"http://www.buscacep.correios.com.br/sistemas/buscacep/\" class=\"descobre-cep\" target=\"_blank\">Não sei meu cep?</a> </div> </div> </th> </tr> </thead> <tbody id=\"info-modalidade\"> <tr> <td style=\"width:90px\"><strong>Click&#160;&amp;&#160;Retire</strong></td> <td style=\"width:90px\"><strong>Frete Gr&#225;tis</strong></td> <td style=\"width:90px\"><strong>Dia da Postagem + 1 hora(s) </strong></td> <td>2&#170; feira a S&#225;bado:7h &#224;s 22h -------- Domingos e Feriados: 8h &#224;s 22h</td> </tr> <tr> <td style=\"width:90px\"><strong>Entrega (Goi&#226;nia)</strong></td> <td style=\"width:90px\"><strong>R$ 5,00</strong></td> <td style=\"width:90px\"><strong>Dia da Postagem + 1 hora(s) </strong></td> <td>O prazo de entrega ser&#225; contabilizado ap&#243;s a confirma&#231;&#227;o de pagamento.</td> </tr> </tbody> </table> <a class=\"close-reveal-modal\" aria-label=\"Close\">&#215;</a> </div>";
const BSB = "{\"sucesso\":false,\"mensagem\":\"Este produto não possui estoque suficiente para atendimento na sua região.\"}";

/** Um instante no relógio de Goiânia (UTC-3). */
const brt = (iso: string) => new Date(`${iso}-03:00`);

describe('busca — os cartões reais', () => {
  const produtos = parseModeloBusca(BUSCA, NET);

  it('lê nome completo, id, preço, EAN e o link do produto', () => {
    expect(produtos.length).toBeGreaterThanOrEqual(1);
    expect(produtos[0]).toMatchObject({
      network: 'farmacia-modelo', productName: 'Dipirona Sodica 500mg Gotas 20ml', sku: '3417', price: 9.99,
      ean: '7896422506236', availableQuantity: 1, productUrl: 'https://farmaciamodelo.com.br/dipirona-sodica-500mg-gotas-20ml/3417-01',
    });
  });

  it('HTML sem cartão → nada (e não quebra)', () => {
    expect(parseModeloBusca('<html>sem resultados</html>', NET)).toEqual([]);
  });
});

describe('prazo por CEP — a resposta real', () => {
  it('Goiânia: Click & Retire grátis e Entrega (Goiânia) R$ 5,00, ambos +1 hora', () => {
    const r = parseModeloModalidades({ sucesso: true, view: VIEW });
    if (!r || r.semEstoque) throw new Error('esperava opções');
    expect(r.opcoes.map((o) => [o.nome, o.taxa, o.prazoMin, o.retirada])).toEqual([
      ['Click & Retire', 0, 60, true],
      ['Entrega (Goiânia)', 5, 60, false],
    ]);
  });

  it('"sem estoque na sua região" é estoque, não erro', () => {
    expect(parseModeloModalidades(JSON.parse(BSB))).toMatchObject({ semEstoque: true });
  });

  it('resposta estranha → null (o pedido segue sem essa rede)', () => {
    expect(parseModeloModalidades(null)).toBeNull();
    expect(parseModeloModalidades({ sucesso: false, mensagem: 'erro interno' })).toBeNull();
  });

  it('o horário da loja sai do próprio texto do Click & Retire', () => {
    const r = parseModeloModalidades({ sucesso: true, view: VIEW });
    if (!r || r.semEstoque) throw new Error('esperava opções');
    expect(horarioDaLoja(r.opcoes[0]!.descricao)).toEqual({ semana: [7, 22], domingo: [8, 22] });
    expect(prazoEmMinutos('Dia da Postagem + 1 hora(s)')).toBe(60);
    expect(prazoEmMinutos('Dia da Postagem + 2 dia(s)')).toBe(2 * 24 * 60);
  });
});

describe('o "+1 hora" respeita o horário da loja', () => {
  const H = { semana: [7, 22] as [number, number], domingo: [8, 22] as [number, number] };

  it('segunda 15h → 60 min', () => {
    expect(prontoNaLoja(60, H, true, brt('2026-09-28T15:00:00'))).toEqual({ etaMinutes: 60, etaText: '60 min' });
  });

  it('segunda 21h30 (fecha 22h) → amanhã a partir das 8h', () => {
    expect(prontoNaLoja(60, H, true, brt('2026-09-28T21:30:00')).etaText).toBe('amanhã a partir das 8h');
    expect(prontoNaLoja(60, H, false, brt('2026-09-28T21:30:00')).etaText).toBe('amanhã até as 8h');
  });

  it('sábado 21h30 → domingo abre às 8h, pronto às 9h', () => {
    expect(prontoNaLoja(60, H, true, brt('2026-09-26T21:30:00')).etaText).toBe('amanhã a partir das 9h');
  });

  it('madrugada (5h) → abre às 7h, pronto às 8h do mesmo dia (3 horas)', () => {
    const r = prontoNaLoja(60, H, true, brt('2026-09-29T05:00:00'));
    expect(r?.etaMinutes).toBe(180);
  });

  it('horas arredondam pra CIMA (4h35 → pronto às 8h = 3h25 → "4 horas", nunca "3")', () => {
    expect(prontoNaLoja(60, H, true, brt('2026-09-29T04:35:00'))?.etaText).toBe('4 horas');
  });

  it('prazo em DIAS não vira promessa (nada de "chega em confira no site")', () => {
    expect(prontoNaLoja(2 * 24 * 60, H, false, brt('2026-09-28T15:00:00'))).toBeNull();
  });
});

describe('a cesta na Modelo', () => {
  const opcoes = parseModeloModalidades({ sucesso: true, view: VIEW })!;
  const sem = parseModeloModalidades(JSON.parse(BSB))!;

  it('dois itens com estoque: frete UM (R$ 5), prazo do mais lento, retirada na loja do Setor Oeste', () => {
    const s = combinarSimulacaoModelo([{ sku: '1', r: opcoes }, { sku: '2', r: opcoes }], brt('2026-09-28T15:00:00'))!;
    expect(s.delivery).toMatchObject({ feeReais: 5, etaMinutes: 60, etaText: '60 min', slaName: 'Entrega (Goiânia)' });
    expect(s.pickup).toMatchObject({ feeReais: 0, etaMinutes: 60, store: LOJA_MODELO });
    expect(s.indisponiveis).toEqual([]);
  });

  it('item sem estoque na região sai; o outro segue', () => {
    const s = combinarSimulacaoModelo([{ sku: '1', r: opcoes }, { sku: '2', r: sem }], brt('2026-09-28T15:00:00'))!;
    expect(s.indisponiveis).toEqual(['2']);
    expect(s.delivery?.etaMinutes).toBe(60);
  });

  it('nenhuma resposta → null (a Modelo fica de fora sem travar as outras)', () => {
    expect(combinarSimulacaoModelo([{ sku: '1', r: null }])).toBeNull();
  });

  it('UM item sem resposta tira a promessa da cesta inteira (estoque dele não foi conferido)', () => {
    expect(combinarSimulacaoModelo([{ sku: '1', r: opcoes }, { sku: '2', r: null }], brt('2026-09-28T15:00:00'))).toBeNull();
  });

  it('frete ilegível não vira "grátis": a modalidade sai', () => {
    const v = VIEW.replace('R$ 5,00', 'A calcular');
    const r = parseModeloModalidades({ sucesso: true, view: v });
    if (!r || r.semEstoque) throw new Error('esperava opções');
    expect(r.opcoes.map((o) => o.nome)).toEqual(['Click & Retire']);
  });
});

describe('iFood — link de busca, não cotação', () => {
  it('busca pelo nome do remédio (a dose fica pro app)', () => {
    expect(linkDeBuscaNoIfood('Cefaliv')).toBe('https://www.ifood.com.br/busca?q=cefaliv');
    expect(linkDeBuscaNoIfood('Losartana Potássica 50mg')).toBe('https://www.ifood.com.br/busca?q=losartana%20potassica');
    expect(linkDeBuscaNoIfood('')).toBeNull();
  });
});

describe('WhatsApp do bairro: a Modelo de Goiânia fica pro site', () => {
  it('por nome E cidade — "Farmácia Modelo" de outra cidade continua recebendo WhatsApp', () => {
    expect(cobertaPeloSite('Farmácia Modelo - Drogaria (Ao lado da Pão & Companhia)', 'Goiânia')).toBe(true);
    expect(cobertaPeloSite('Farmácia Modelo', 'Anápolis')).toBe(false);
    expect(cobertaPeloSite('Farmácia Modelo', 'Aparecida de Goiânia')).toBe(false);   // outra cidade
    expect(cobertaPeloSite('Farmácia Longevitá', 'Goiânia')).toBe(false);
    expect(cobertaPeloSite('Farmácia Modelo', null)).toBe(false);
  });
});

