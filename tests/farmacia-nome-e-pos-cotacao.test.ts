import { describe, it, expect } from 'vitest';
import {
  nomeExisteEm, decidirVerificacaoDeNome, perguntaDeConfirmacaoDeNome,
  sugestaoDeNomeDaFarmacia, perguntaSobreSugestaoDeNome,
} from '../packages/shared/src/nome-remedio';
import {
  interpretarMensagemPosCotacao, perguntaJaRespondida, ofertaMudou, mensagemDeAtualizacaoDaOferta,
} from '../packages/shared/src/pos-cotacao';
import { montarProdutoCotado } from '../packages/shared/src/produto-cotado';
import { extractDeliverySector, enderecoFoiMencionado, pareceEnderecoDeClinica } from '../packages/shared/src/endereco-entrega';
import { rankProductMatches, medNameForSearch } from '../packages/integrations/src/pharmacy-platforms/matching';

describe('nome do remédio — existência no catálogo', () => {
  const catalogo = ['Probiótico Renovaflora 10 Cápsulas', 'Daflon Flex 900mg + 100mg 30 Envelopes', 'Venaflon 900mg+100mg 30 Comprimidos', 'Losartana Potássica 50mg 30 Comprimidos'];
  it('"aflor" não existe (Renovaflora não conta — palavra inteira); "daflon" existe', () => {
    expect(nomeExisteEm('aflor', catalogo)).toBe(false);
    expect(nomeExisteEm('daflon', catalogo)).toBe(true);
    expect(nomeExisteEm('venaflon', catalogo)).toBe(true);
    expect(nomeExisteEm('LOSARTANA', catalogo)).toBe(true);
    expect(nomeExisteEm('xy', catalogo)).toBe(false);
  });
  it('decisão por origem: foto inexistente confirma; texto inexistente segue; inconclusivo segue', () => {
    expect(decidirVerificacaoDeNome({ origem: 'foto', existe: false })).toBe('confirmar');
    expect(decidirVerificacaoDeNome({ origem: 'audio', existe: false })).toBe('confirmar');
    expect(decidirVerificacaoDeNome({ origem: 'texto', existe: false })).toBe('segue_sem_verificar');
    expect(decidirVerificacaoDeNome({ origem: 'foto', existe: true })).toBe('segue');
    expect(decidirVerificacaoDeNome({ origem: 'foto', existe: null })).toBe('segue_sem_verificar');
  });
  it('a pergunta ao paciente cita o que foi lido', () => {
    expect(perguntaDeConfirmacaoDeNome('Aflor 1000 Flex', 'foto')).toContain('*Aflor 1000 Flex*');
    expect(perguntaDeConfirmacaoDeNome('Aflor 1000 Flex', 'foto')).toContain('na receita');
  });
});

describe('a farmácia sugere outro nome', () => {
  it('"Seria Daflon?" → Daflon; "não seria o Daflon?" → Daflon', () => {
    expect(sugestaoDeNomeDaFarmacia('Seria Daflon?', 'Aflor 1000 Flex')).toBe('Daflon');
    expect(sugestaoDeNomeDaFarmacia('não seria o Daflon?', 'Aflor 1000 Flex')).toBe('Daflon');
    expect(sugestaoDeNomeDaFarmacia('Dáflon?', 'Aflor 1000 Flex')).toBe('Dáflon');
  });
  it('mesmo nome, palavras comuns e perguntas de outro tipo não viram sugestão', () => {
    expect(sugestaoDeNomeDaFarmacia('Seria Daflon?', 'Daflon Flex 1000')).toBeNull();
    expect(sugestaoDeNomeDaFarmacia('seria hoje?', 'Daflon Flex 1000')).toBeNull();
    expect(sugestaoDeNomeDaFarmacia('é genérico?', 'Daflon')).toBeNull();
    expect(sugestaoDeNomeDaFarmacia('qual o endereço?', 'Daflon')).toBeNull();
    expect(sugestaoDeNomeDaFarmacia('Não estamos tendo', 'Aflor')).toBeNull();
  });
  it('a pergunta ao paciente cita os dois nomes', () => {
    const p = perguntaSobreSugestaoDeNome('Drogaria Coimbra', 'Daflon', 'Aflor 1000 Flex');
    expect(p).toContain('*Daflon*');
    expect(p).toContain('*Aflor 1000 Flex*');
  });
});

describe('pós-cotação — o que a Coimbra disse depois do preço', () => {
  const cot = { total: 64.9, deliveryFee: null };
  it('"69.90" solto = total novo, frete 5', () => {
    const r = interpretarMensagemPosCotacao('69.90', cot);
    expect(r.novoTotal).toBe(69.9);
    expect(r.frete).toBe(5);
  });
  it('"5 reais de frete" = frete 5; "frete grátis" = 0', () => {
    expect(interpretarMensagemPosCotacao('5 reais de frete', cot).frete).toBe(5);
    expect(interpretarMensagemPosCotacao('a entrega é grátis', cot).frete).toBe(0);
  });
  it('"Qual nome da pessoa que vai receber?" é pergunta de nome, sem preço', () => {
    const r = interpretarMensagemPosCotacao('Qual nome da pessoa que vai receber?', cot);
    expect(r.perguntaNome).toBe(true);
    expect(r.frete).toBeNull();
  });
  it('número solto muito maior que o total NÃO vira frete (outro item/erro)', () => {
    expect(interpretarMensagemPosCotacao('180', cot).frete).toBeNull();
    expect(interpretarMensagemPosCotacao('180', cot).novoTotal).toBeNull();
  });
  it('"Consigo te entregar as 14:40" traz o prazo', () => {
    expect(interpretarMensagemPosCotacao('Consigo te entregar as 14:40', cot).textoPrazo).toBe('14:40');
  });
  it('pergunta de CPF/pagamento é classificada', () => {
    expect(interpretarMensagemPosCotacao('me passa o cpf?', cot).perguntaDado).toBe('cpf');
    expect(interpretarMensagemPosCotacao('vai pagar no pix ou cartão?', cot).perguntaDado).toBe('pagamento');
  });
});

describe('perguntaJaRespondida — a Xarlote não pergunta o que já sabe', () => {
  const coimbra = { supplierName: 'Drogaria Coimbra', total: 64.9, deliveryFee: 5, etaMinutes: null };
  it('frete já conhecido → devolve o fato, não manda', () => {
    const r = perguntaJaRespondida('Pode me informar o valor do frete para entrega no endereço Rua 14, Setor Sul? Obrigada!', coimbra);
    expect(r).toContain('JÁ respondeu o frete');
    expect(r).toContain('R$ 5,00');
    expect(r).toContain('R$ 69,90');
  });
  it('frete desconhecido → pode mandar; mensagem que não é pergunta → pode mandar', () => {
    expect(perguntaJaRespondida('quanto fica o frete?', { ...coimbra, deliveryFee: null })).toBeNull();
    expect(perguntaJaRespondida('pode preparar, fechou!', coimbra)).toBeNull();
  });
});

describe('ofertaMudou + mensagem de update', () => {
  it('frete passou a ser conhecido → mudou; nada mudou → não', () => {
    expect(ofertaMudou({ total: 64.9, deliveryFee: null, substituto: null }, { total: 64.9, deliveryFee: 5, substituto: null })).toBe(true);
    expect(ofertaMudou({ total: 64.9, deliveryFee: 5, substituto: true }, { total: 64.9, deliveryFee: 5, substituto: true })).toBe(false);
    expect(ofertaMudou({ total: 64.9, deliveryFee: 5, substituto: null }, { total: 64.9, deliveryFee: 5, substituto: true })).toBe(true);
  });
  it('o update fala o produto, o total com entrega e pergunta o certo pro substituto', () => {
    const m = mensagemDeAtualizacaoDaOferta({ supplierName: 'Drogaria Coimbra', produto: montarProdutoCotado({ pedido: 'Daflon Flex 1000', cotado: 'Venaflon', apresentacao: '30 comprimidos', fonte: 'agente' }), total: 64.9, deliveryFee: 5, textoPrazo: '14:40' });
    expect(m).toContain('Venaflon (30 comprimidos) — similar, não é o Daflon Flex 1000');
    expect(m).toContain('R$ 64,90 + R$ 5,00 de entrega = *R$ 69,90*');
    expect(m).toContain('entrega: 14:40');
    expect(m).toContain('Quer fechar com o similar');
  });
});

describe('endereço de entrega', () => {
  it('setor ignora quadra/lote e a UF colada na cidade', () => {
    expect(extractDeliverySector('Rua 14, Qd. B8, Lt. 20, Setor Sul, Goiânia - Goiás, 74120-070')).toBe('Setor Sul');
    expect(extractDeliverySector('Rua Ema 5, Qd 19 Lt 28, Recanto das Emas, Goiânia')).toBe('Recanto das Emas');
    expect(extractDeliverySector('Rua 14, 201, Goiânia - GO')).toBe('Goiânia'); // sem setor cai na cidade
    expect(extractDeliverySector('Localização compartilhada via WhatsApp (lat -16, lng -49)')).toBeNull();
  });
  it('consentimento do endereço salvo pela fala', () => {
    const salvo = { label: 'trabalho', street: 'Rua 14' };
    expect(enderecoFoiMencionado(['Consegue cotar esse medicamento por favor'], salvo)).toBe(false);
    expect(enderecoFoiMencionado(['manda pro trabalho'], salvo)).toBe(true);
    expect(enderecoFoiMencionado(['pode ser no mesmo endereço'], salvo)).toBe(true);
    expect(enderecoFoiMencionado(['é na rua 14 mesmo'], salvo)).toBe(true);
    expect(enderecoFoiMencionado(['quero dipirona', 'pra casa'], { label: 'casa' })).toBe(true);
  });
  it('endereço de clínica na receita é reconhecido', () => {
    expect(pareceEnderecoDeClinica('Av. Castelo Branco, 974 - Setor Coimbra (clínica Medpaz)')).toBe(true);
    expect(pareceEnderecoDeClinica('Rua 14, 201, Setor Oeste')).toBe(false);
  });
});

describe('ranqueador das redes — Fixare Flex nunca mais', () => {
  const prods: any[] = [
    { productName: 'Suplemento Alimentar Fixare Flex 120 Comprimidos', availableQuantity: 5 },
    { productName: 'Daflon Flex 900mg + 100mg 30 Envelopes', availableQuantity: 5 },
    { productName: 'Daflon 1000mg 30 comprimidos', availableQuantity: 5 },
    { productName: 'Venaflon 900mg + 100mg 30 Comprimidos', availableQuantity: 5 },
    { productName: 'Flexive 30 Comprimidos', availableQuantity: 5 },
    { productName: 'Dipirona Sódica 500mg 10 Comprimidos', availableQuantity: 5 },
    { productName: 'Dipironax 500mg', availableQuantity: 5 },
  ];
  it('"Aflor 1000 Flex" não casa NADA', () => {
    expect(rankProductMatches('Aflor 1000 Flex', prods)).toEqual([]);
  });
  it('"Daflon Flex 1000" casa só o Daflon Flex (não o Daflon comprimidos, não o Venaflon)', () => {
    const r = rankProductMatches('Daflon Flex 1000', prods).map((x) => x.product.productName);
    expect(r).toEqual(['Daflon Flex 900mg + 100mg 30 Envelopes']);
  });
  it('"Daflon 1000" casa os dois Daflon (marca obrigatória, um token só)', () => {
    const r = rankProductMatches('Daflon 1000', prods).map((x) => x.product.productName);
    expect(r).toContain('Daflon 1000mg 30 comprimidos');
    expect(r).toContain('Daflon Flex 900mg + 100mg 30 Envelopes');
    expect(r).not.toContain('Venaflon 900mg + 100mg 30 Comprimidos');
  });
  it('palavra inteira: "dipirona" não casa "Dipironax"', () => {
    const r = rankProductMatches('Dipirona 500mg', prods).map((x) => x.product.productName);
    expect(r).toEqual(['Dipirona Sódica 500mg 10 Comprimidos']);
  });
  it('3+ tokens toleram um qualificador ausente', () => {
    const r = rankProductMatches('Losartana potássica Medley 50mg', [{ productName: 'Losartana Potássica 50mg 30 Comprimidos', availableQuantity: 1 } as any]);
    expect(r.length).toBe(1);
    expect(medNameForSearch('Daflon Flex 1000')).toBe('daflon flex');
  });
});

describe('normalizarPrecoDaCotacao — total com frete embutido', () => {
  it('"total 69,90, frete 5, subtotal 64,90" → remédios 64,90', async () => {
    const { normalizarPrecoDaCotacao } = await import('../packages/shared/src/pos-cotacao');
    expect(normalizarPrecoDaCotacao({ total: 69.9, subtotal: 64.9, deliveryFee: 5 })).toEqual({ remedios: 64.9, frete: 5 });
    expect(normalizarPrecoDaCotacao({ total: 69.9, deliveryFee: 5, totalJaRegistrado: 64.9 })).toEqual({ remedios: 64.9, frete: 5 });
    expect(normalizarPrecoDaCotacao({ total: 64.9, deliveryFee: 5 })).toEqual({ remedios: 64.9, frete: 5 });
    expect(normalizarPrecoDaCotacao({ total: 64.9 })).toEqual({ remedios: 64.9, frete: null });
    expect(normalizarPrecoDaCotacao({ total: 30, deliveryFee: 0 })).toEqual({ remedios: 30, frete: 0 });
  });
});
