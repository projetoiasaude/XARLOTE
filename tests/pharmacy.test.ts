import { describe, expect, it } from 'vitest';
import {
  isPharmacyChain,
  extractPriceBRL,
  parseUnitCount,
  isOrderAcceptance,
  resolveQuotePick,
  sameMedication,
  shortSupplierAddress,
  mentionsFreeShipping,
  itemDisplayName,
  type QuoteOption,
} from '../packages/shared/src/pharmacy.js';

describe('isPharmacyChain (Fix #6 — deprioriza redes)', () => {
  it('reconhece redes INEQUÍVOCAS (com/sem acento)', () => {
    expect(isPharmacyChain('Drogasil Centro')).toBe(true);
    expect(isPharmacyChain('DROGASIL')).toBe(true);
    expect(isPharmacyChain('Droga Raia')).toBe(true);
    expect(isPharmacyChain('Pague Menos 24h')).toBe(true);
    expect(isPharmacyChain('Farmácias Nissei')).toBe(true);
    expect(isPharmacyChain('Drogarias Pacheco')).toBe(true);
    expect(isPharmacyChain('Ultrafarma')).toBe(true);
  });
  it('NÃO reconhece independentes (nem nomes ambíguos removidos da lista — review)', () => {
    expect(isPharmacyChain('Farmácia do Zé')).toBe(false);
    expect(isPharmacyChain('Droga Fácil - Jd. Colorado')).toBe(false);
    expect(isPharmacyChain('Farmacia SeteFarma')).toBe(false);
    expect(isPharmacyChain('Drogaria Canaã')).toBe(false);
    // Nomes/sobrenomes comuns removidos da lista (colidiam com independentes):
    expect(isPharmacyChain('Drogaria São João')).toBe(false);
    expect(isPharmacyChain('Farmácia Araújo')).toBe(false);
    expect(isPharmacyChain('Drogaria Pacheco do Bairro')).toBe(false); // só "drogarias pacheco" (rede) casa
    expect(isPharmacyChain('')).toBe(false);
    expect(isPharmacyChain(null)).toBe(false);
  });
});

describe('extractPriceBRL (Fix #3 — captura oferta perdida)', () => {
  it('captura preço com R$', () => {
    expect(extractPriceBRL('R$ 65,00')).toBe(65);
    expect(extractPriceBRL('fica r$65')).toBe(65);
    expect(extractPriceBRL('R$ 1.250,00')).toBe(1250);
  });
  it('captura decimal solto', () => {
    expect(extractPriceBRL('65,00')).toBe(65);
    expect(extractPriceBRL('12.50')).toBe(12.5);
  });
  it('CASO REAL SeteFarma: ignora "20 comp" e "40 a 50 minutos", captura 65,00', () => {
    expect(extractPriceBRL('so tenho caixa 20 comp \n65,00 \nentrega pode demorar de 40 a 50 minutos a entrega')).toBe(65);
  });
  it('captura inteiro com palavra monetária', () => {
    expect(extractPriceBRL('fica 12 reais')).toBe(12);
    expect(extractPriceBRL('custa 18')).toBe(18);
    expect(extractPriceBRL('sai por 30')).toBe(30);
    expect(extractPriceBRL('é 8 reais')).toBe(8);
  });
  it('NÃO captura prazo/quantidade/dosagem/CEP como preço', () => {
    expect(extractPriceBRL('entrega em 40 a 50 minutos')).toBe(null);
    expect(extractPriceBRL('demora uns 30 min')).toBe(null);
    expect(extractPriceBRL('CEP 74000-000')).toBe(null);
    expect(extractPriceBRL('paracetamol 500mg')).toBe(null);
    expect(extractPriceBRL('tenho 20 comprimidos')).toBe(null);
  });
  it('NÃO captura TELEFONE/CÓDIGO após "é/são/por" (review HIGH — gatilhos fracos removidos)', () => {
    expect(extractPriceBRL('meu whatsapp é 62 99999 1234')).toBe(null);
    expect(extractPriceBRL('o codigo do pedido é 1234')).toBe(null);
    expect(extractPriceBRL('liga pra gente, é 3212 3456')).toBe(null);
    expect(extractPriceBRL('nosso pedido minimo é 50 pra entrega gratis')).toBe(null);
    expect(extractPriceBRL('o horario de entrega é 14 as 18h')).toBe(null);
  });
  it('ambíguo (múltiplos preços divergentes) → null', () => {
    expect(extractPriceBRL('pode ser 12,00 ou 15,90 com o genérico')).toBe(null);
  });
  it('texto sem número → null', () => {
    expect(extractPriceBRL('bom dia, tudo bem?')).toBe(null);
    expect(extractPriceBRL('')).toBe(null);
    expect(extractPriceBRL(null)).toBe(null);
  });
});

describe('parseUnitCount (substituição de apresentação)', () => {
  it('extrai contagem de comprimidos', () => {
    expect(parseUnitCount('só tenho de 20 comp')).toBe(20);
    expect(parseUnitCount('30 comprimidos')).toBe(30);
    expect(parseUnitCount('caixa com 60 cápsulas')).toBe(60);
  });
  it('null quando não há unidade de contagem', () => {
    expect(parseUnitCount('1 caixa')).toBe(null);
    expect(parseUnitCount('500mg')).toBe(null);
    expect(parseUnitCount(null)).toBe(null);
  });
});

describe('isOrderAcceptance (Fix #1 — aceite VERBAL vs resposta a dado/negação)', () => {
  it('reconhece aceites verbais claros', () => {
    for (const t of ['aceito', 'Aceito!', 'pode ser', 'quero a 1', 'prefiro a Droga Raia', 'a mais barata', 'fechou', 'pode fechar', 'sim', 'ok', 'isso mesmo', 'perfeito']) {
      expect(isOrderAcceptance(t), t).toBe(true);
    }
  });
  it('NÃO é aceite: número/opção solto (fica pra resolveQuotePick + guarda de pendingClarif)', () => {
    for (const t of ['a 2', '2', 'a 1']) {
      expect(isOrderAcceptance(t), t).toBe(false);
    }
  });
  it('NÃO confunde resposta a dado factual com aceite', () => {
    for (const t of ['particular', 'unimed', 'tenho receita sim', 'meu cpf é 123', 'pode ser generico', 'pode ser o similar']) {
      expect(isOrderAcceptance(t), t).toBe(false);
    }
  });
  it('NEGAÇÃO nunca é aceite (review HIGH)', () => {
    for (const t of ['não quero', 'nao quero mais', 'não, deixa pra lá', 'cancela', 'agora não']) {
      expect(isOrderAcceptance(t), t).toBe(false);
    }
  });
  it('ADIAMENTO/PERGUNTA nunca é aceite (review-2 HIGH)', () => {
    for (const t of ['quero pensar', 'prefiro esperar', 'quero ver outras opções', 'aceita cartão?', 'confirma o endereço', 'pode fechar amanhã', 'quero saber o frete', 'deixa eu pensar']) {
      expect(isOrderAcceptance(t), t).toBe(false);
    }
  });
  it('aceites legítimos continuam funcionando após o endurecimento', () => {
    for (const t of ['aceito', 'pode fechar', 'pode entregar', 'quero a 1', 'prefiro a Droga Raia', 'pode ser', 'fechou', 'confirmo', 'a mais barata']) {
      expect(isOrderAcceptance(t), t).toBe(true);
    }
  });
});

const OPTS: QuoteOption[] = [
  { option: 1, quote_id: 'q-facil', supplier_name: 'Droga Fácil - Jd. Colorado', total: 67.5, eta_minutes: null },
  { option: 2, quote_id: 'q-raia', supplier_name: 'Droga Raia Setor Oeste', total: 72.0, eta_minutes: 30 },
  { option: 3, quote_id: 'q-sete', supplier_name: 'SeteFarma', total: 65.0, eta_minutes: 50 },
];

describe('resolveQuotePick (Fix #1 — resolve escolha → quote_id)', () => {
  it('por número da opção', () => {
    expect(resolveQuotePick(OPTS, 'quero a 1')).toBe('q-facil');
    expect(resolveQuotePick(OPTS, 'a 2')).toBe('q-raia');
    expect(resolveQuotePick(OPTS, 'opção 3')).toBe('q-sete');
    expect(resolveQuotePick(OPTS, 'a primeira')).toBe('q-facil');
    expect(resolveQuotePick(OPTS, '3')).toBe('q-sete');
  });
  it('por "farmácia N" (incidente Hiago 06/07 — "pode entregar então, farmácia 1")', () => {
    expect(resolveQuotePick(OPTS, 'farmácia 1')).toBe('q-facil');
    expect(resolveQuotePick(OPTS, 'Pode entregar então, farmácia 1')).toBe('q-facil');
    expect(resolveQuotePick(OPTS, 'pode ser a drogaria 2')).toBe('q-raia');
  });
  it('número fora do range → null (não fecha errado)', () => {
    expect(resolveQuotePick(OPTS, 'quero a 9')).toBe(null);
  });
  it('por nome da farmácia (acento/case-insensitive, parcial)', () => {
    expect(resolveQuotePick(OPTS, 'prefiro a SeteFarma')).toBe('q-sete');
    expect(resolveQuotePick(OPTS, 'pode ser a raia')).toBe('q-raia');
    expect(resolveQuotePick(OPTS, 'quero a facil')).toBe('q-facil');
  });
  it('por superlativo (mais barata → menor total)', () => {
    expect(resolveQuotePick(OPTS, 'a mais barata')).toBe('q-sete'); // 65
  });
  it('por superlativo (mais rápida → menor eta)', () => {
    expect(resolveQuotePick(OPTS, 'a que entrega antes')).toBe('q-raia'); // 30min
  });
  it('aceite GENÉRICO com >1 opção → null (não fecha arbitrário)', () => {
    expect(resolveQuotePick(OPTS, 'aceito')).toBe(null);
    expect(resolveQuotePick(OPTS, 'pode ser')).toBe(null);
  });
  it('aceite genérico com 1 opção só → fecha ela', () => {
    const one: QuoteOption[] = [{ option: 1, quote_id: 'q-only', supplier_name: 'Droga Fácil', total: 67.5 }];
    expect(resolveQuotePick(one, 'aceito')).toBe('q-only');
    expect(resolveQuotePick(one, 'pode ser essa')).toBe('q-only');
  });
  it('resposta a dado (não-aceite) → null', () => {
    expect(resolveQuotePick(OPTS, 'particular')).toBe(null);
    expect(resolveQuotePick(OPTS, 'unimed')).toBe(null);
  });
  it('opções vazias / texto vazio → null', () => {
    expect(resolveQuotePick([], 'a 1')).toBe(null);
    expect(resolveQuotePick(OPTS, '')).toBe(null);
  });

  // ── Guardas de segurança do review (não fechar compra errada/recusada) ──
  it('QUANTIDADE colada a número NÃO é escolha (review HIGH)', () => {
    expect(resolveQuotePick(OPTS, 'a 2 caixas')).toBe(null);
    expect(resolveQuotePick(OPTS, 'manda a 2 caixas de dipirona')).toBe(null);
    expect(resolveQuotePick(OPTS, 'na 2 via da receita')).toBe(null);
    expect(resolveQuotePick(OPTS, 'compro a 1 unidade so')).toBe(null);
    expect(resolveQuotePick(OPTS, 'pode mandar a insulina 1 caixa')).toBe(null);
  });
  it('NEGAÇÃO nunca fecha (review HIGH) — inclusive negação + número', () => {
    const one: QuoteOption[] = [{ option: 1, quote_id: 'q-only', supplier_name: 'Droga Fácil', total: 67.5 }];
    expect(resolveQuotePick(one, 'não quero')).toBe(null);
    expect(resolveQuotePick(one, 'agora não quero mais')).toBe(null);
    expect(resolveQuotePick(OPTS, 'nao quero a 2')).toBe(null);
    expect(resolveQuotePick(OPTS, 'não a 1, quero a 3')).toBe(null);
    expect(resolveQuotePick(OPTS, 'cancela')).toBe(null);
  });
  it('MÚLTIPLOS números de opção divergentes → null (ambíguo)', () => {
    expect(resolveQuotePick(OPTS, 'entre a 1 e a 2, qual?')).toBe(null);
    expect(resolveQuotePick(OPTS, 'quero a 1 ou a 2')).toBe(null);
  });
  it('resposta-a-dado com 1 opção NÃO fecha (review — "pode ser generico")', () => {
    const one: QuoteOption[] = [{ option: 1, quote_id: 'q-only', supplier_name: 'Droga Fácil', total: 67.5 }];
    expect(resolveQuotePick(one, 'pode ser generico')).toBe(null);
    expect(resolveQuotePick(one, 'particular')).toBe(null);
  });
  it('ADIAMENTO/PERGUNTA com 1 opção NÃO fecha (review-2 HIGH — o caso mais perigoso)', () => {
    const one: QuoteOption[] = [{ option: 1, quote_id: 'q-only', supplier_name: 'Droga Fácil', total: 67.5 }];
    for (const t of ['quero pensar', 'prefiro esperar', 'quero ver outras opções', 'aceita cartão?', 'confirma o endereço por favor', 'pode fechar amanhã']) {
      expect(resolveQuotePick(one, t), t).toBe(null);
    }
    // mas um aceite real com 1 opção AINDA fecha:
    expect(resolveQuotePick(one, 'aceito')).toBe('q-only');
    expect(resolveQuotePick(one, 'pode fechar')).toBe('q-only');
    expect(resolveQuotePick(one, 'pode entregar')).toBe('q-only');
  });
  it('"pode entregar 2 caixas" com 1 opção NÃO fecha (guarda de quantidade no caminho de 1 opção)', () => {
    const one: QuoteOption[] = [{ option: 1, quote_id: 'q-only', supplier_name: 'Droga Fácil', total: 67.5 }];
    expect(resolveQuotePick(one, 'pode entregar 2 caixas')).toBe(null);
    expect(resolveQuotePick(one, 'manda 3 caixas')).toBe(null);
  });
});

describe('shortSupplierAddress — endereço humano pra farmácia (07/07)', () => {
  it('tira "Região X" e "Brasil", mantém rua/bairro/cidade/UF/CEP', () => {
    expect(shortSupplierAddress('Rua EMA 5, Residencial Recanto das Emas, Goiânia, Goiás, Região Centro-Oeste, 74393-376, Brasil'))
      .toBe('Rua EMA 5, Residencial Recanto das Emas, Goiânia, Goiás, 74393-376');
    expect(shortSupplierAddress('Rua 14, Setor Oeste, Goiânia, Goiás, Região Centro-Oeste, 74115-060, Brasil'))
      .toBe('Rua 14, Setor Oeste, Goiânia, Goiás, 74115-060');
  });
  it('endereço já limpo passa intacto; vazio → ""', () => {
    expect(shortSupplierAddress('Rua 14, Setor Oeste, Goiânia')).toBe('Rua 14, Setor Oeste, Goiânia');
    expect(shortSupplierAddress('')).toBe('');
    expect(shortSupplierAddress(null)).toBe('');
  });
});

describe('mentionsFreeShipping — não re-perguntar frete quando já é grátis', () => {
  it('detecta grátis/cortesia/não cobramos/sem taxa/de graça/por nossa conta/incluso', () => {
    expect(mentionsFreeShipping('nossa entrega é Grátis 😄')).toBe(true);
    expect(mentionsFreeShipping('Não cobramos frete')).toBe(true);
    expect(mentionsFreeShipping('entrega é cortesia')).toBe(true);
    expect(mentionsFreeShipping('sem taxa de entrega')).toBe(true);
    expect(mentionsFreeShipping('a entrega sai de graça')).toBe(true);
    expect(mentionsFreeShipping('a entrega fica por nossa conta')).toBe(true);
    expect(mentionsFreeShipping('o frete tá incluso')).toBe(true);
    expect(mentionsFreeShipping('não paga nada de entrega')).toBe(true);
  });
  it('taxa COM valor NÃO é grátis', () => {
    expect(mentionsFreeShipping('cobramos taxa de 7,90')).toBe(false);
    expect(mentionsFreeShipping('o frete fica 12,00')).toBe(false);
    expect(mentionsFreeShipping('23,00')).toBe(false);
  });
  it('NEGAÇÃO de grátis (antes ou depois) NÃO conta como grátis', () => {
    expect(mentionsFreeShipping('não temos frete grátis')).toBe(false);
    expect(mentionsFreeShipping('não é grátis não')).toBe(false);
    expect(mentionsFreeShipping('infelizmente não é gratuito')).toBe(false);
    expect(mentionsFreeShipping('Frete grátis? Não temos, viu')).toBe(false);
    expect(mentionsFreeShipping('sem frete grátis')).toBe(false);
    expect(mentionsFreeShipping('frete não incluso')).toBe(false);
  });
  it('frete grátis CONDICIONAL (acima de X / só pra CEP) → NÃO é grátis pro pedido', () => {
    expect(mentionsFreeShipping('Custa 45. Frete grátis acima de 100 reais')).toBe(false);
    expect(mentionsFreeShipping('frete grátis nas compras a partir de R$ 150')).toBe(false);
    expect(mentionsFreeShipping('grátis só pra CEP do centro')).toBe(false);
  });
  it('"por conta do cliente" NÃO é grátis (o cliente paga)', () => {
    expect(mentionsFreeShipping('a entrega fica por conta do cliente')).toBe(false);
  });
});

describe('itemDisplayName — sem dosagem duplicada ("2mg 2mg")', () => {
  it('não repete a dosagem quando já está no nome', () => {
    expect(itemDisplayName('Pietra ED 2mg', '2mg')).toBe('Pietra ED 2mg');
    expect(itemDisplayName('Pietra ED', '2mg')).toBe('Pietra ED 2mg');
    expect(itemDisplayName('Dorflex', null)).toBe('Dorflex');
    expect(itemDisplayName('Cefaliv', '')).toBe('Cefaliv');
  });
});

describe('extractPriceBRL — frete pós-cotação (incidente Hiago 06/07)', () => {
  it('captura o valor do frete/taxa', () => {
    expect(extractPriceBRL('aceitamos sim cobramos taxa de 7,90')).toBe(7.9);
    expect(extractPriceBRL('o frete fica 12,00')).toBe(12);
  });
  it('aviso sem valor → null (só relaya o texto, não mexe no frete)', () => {
    expect(extractPriceBRL('mas pode demorar para entregar')).toBe(null);
  });
});

describe('sameMedication — troca de produto (incidente Cefaliv/delírio 06/07)', () => {
  const mk = (name: string) => [{ name }];
  it('medicamentos DIFERENTES → false (é troca; cancela o antigo e abre o novo)', () => {
    expect(sameMedication(mk('Pietra 2mg'), mk('Cefaliv'))).toBe(false);
    expect(sameMedication(mk('Cefaliv 1 caixa'), mk('Pietra ED 2mg'))).toBe(false);
    expect(sameMedication(mk('Dorflex'), mk('Dipirona 500mg'))).toBe(false);
    expect(sameMedication(mk('Losartana 50mg'), mk('Rivotril 2mg'))).toBe(false);
  });
  it('MESMO medicamento (variações de dose/apresentação/marca) → true (não reinicia)', () => {
    expect(sameMedication(mk('Pietra 2mg'), mk('Pietra ED'))).toBe(true);
    expect(sameMedication(mk('Pietra ED 2mg 30 comprimidos'), mk('pietra'))).toBe(true);
    expect(sameMedication(mk('Dorflex'), mk('Dorflex 300mg 1 caixa'))).toBe(true);
    expect(sameMedication(mk('Cefaliv'), mk('CEFALIV genérico'))).toBe(true);
    expect(sameMedication(mk('Dipirona 500mg'), mk('dipirona sódica 1g'))).toBe(true);
  });
  it('multi-item: interseção em qualquer token → mesmo (não troca por engano)', () => {
    expect(sameMedication(
      [{ name: 'Pietra 2mg' }, { name: 'Ácido fólico' }],
      [{ name: 'Pietra ED' }],
    )).toBe(true);
  });
  it('incerto (nome vazio/só ruído) → true (NUNCA cancela pedido ativo por engano)', () => {
    expect(sameMedication(mk(''), mk('Cefaliv'))).toBe(true);
    expect(sameMedication(mk('1 caixa'), mk('Pietra'))).toBe(true);
    expect(sameMedication([], mk('Cefaliv'))).toBe(true);
    expect(sameMedication(null, mk('Cefaliv'))).toBe(true);
  });

  // ─── Review Cefaliv Finding 2: palavra de CLASSE compartilhada NÃO pode dar falso "mesmo" ───
  it('vitaminas diferentes → false (troca — "vitamina" é classe, o designador discrimina)', () => {
    expect(sameMedication(mk('Vitamina D'), mk('Vitamina C'))).toBe(false);
    expect(sameMedication(mk('Vitamina D3 2000UI'), mk('Vitamina B12'))).toBe(false);
    expect(sameMedication(mk('Vitamina C'), mk('Vitamina K2'))).toBe(false);
    expect(sameMedication(mk('vit D'), mk('vit C efervescente'))).toBe(false);
  });
  it('MESMA vitamina (dose/forma diferentes) → true (não reinicia)', () => {
    expect(sameMedication(mk('Vitamina D'), mk('Vitamina D 5000UI'))).toBe(true);
    expect(sameMedication(mk('Vitamina C 1g'), mk('vit C efervescente'))).toBe(true);
  });
  it('sais/ácidos/cloridratos diferentes → false (o sal é classe, a molécula discrimina)', () => {
    expect(sameMedication(mk('Cloridrato de metformina'), mk('Cloridrato de sertralina'))).toBe(false);
    expect(sameMedication(mk('Sulfato ferroso'), mk('Sulfato de magnésio'))).toBe(false);
    expect(sameMedication(mk('Ácido fólico'), mk('Ácido acetilsalicílico'))).toBe(false);
  });
  it('mesmo fabricante no nome NÃO cola produtos diferentes → false', () => {
    expect(sameMedication(mk('Paracetamol Neo Química'), mk('Ibuprofeno Neo Química'))).toBe(false);
  });
  it('LIMITAÇÃO CONHECIDA — marca vs molécula da MESMA droga → false (trata como troca; re-cota, recuperável)', () => {
    // Sem dicionário de sinônimos não dá pra saber que Tylenol≡Paracetamol. Documentado.
    expect(sameMedication(mk('Tylenol'), mk('Paracetamol'))).toBe(false);
  });
});
