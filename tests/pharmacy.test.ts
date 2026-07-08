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
  resolveSupplierByHint,
  sanitizeSupplierNote,
  noteSignalsConditionalOffer,
  extractAcceptConditions,
  isServiceNumber,
  humanizePaymentLabel,
  humanizeSupplierText,
  type QuoteOption,
  type SupplierCandidate,
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

// ─── Re-engajamento dirigido (feature São Benedito 07/07) ────────────────────

describe('resolveSupplierByHint — casa a farmácia-alvo por nome/dica', () => {
  const cands: SupplierCandidate[] = [
    { quote_id: 'q1', supplier_name: 'Drogaria São Benedito', status: 'unavailable', responded: true },
    { quote_id: 'q2', supplier_name: 'DROGALOBO - NOSSA REDE', status: 'timeout', responded: false },
    { quote_id: 'q3', supplier_name: 'Drogaria Santa Lúcia', status: 'timeout', responded: false },
  ];

  it('nome distintivo casa exatamente 1 → devolve o quote_id', () => {
    expect(resolveSupplierByHint(cands, 'volta na São Benedito e diz que topo o Uber')).toBe('q1');
    expect(resolveSupplierByHint(cands, 'pergunta pra Drogalobo se tem o genérico')).toBe('q2');
    expect(resolveSupplierByHint(cands, 'fala com a Santa Lúcia')).toBe('q3');
  });

  it('acento não atrapalha (São ≡ sao, Lúcia ≡ lucia)', () => {
    expect(resolveSupplierByHint(cands, 'a sao benedito')).toBe('q1');
    expect(resolveSupplierByHint(cands, 'santa lucia')).toBe('q3');
  });

  it('dica semântica "a que respondeu/tem" + 1 respondente → esse respondente', () => {
    expect(resolveSupplierByHint(cands, 'fala com a que respondeu')).toBe('q1');
    expect(resolveSupplierByHint(cands, 'a farmácia que tem o remédio')).toBe('q1');
    expect(resolveSupplierByHint(cands, 'a do uber')).toBe('q1');
  });

  it('frase REAL do incidente 07/07 (backstop de re-contato) → resolve o único respondente', () => {
    // O glm-5.2 narrou "já falei" sem chamar a tool; o backstop usa a frase crua do user.
    expect(resolveSupplierByHint(cands,
      'Xarlote pode entrar em contato com uma das farmácias que você já havia conversado, que disse que teria entregador somente após as 15h, a que tem o número')).toBe('q1');
  });

  it('dica semântica com >1 respondente → null (ambíguo, não adivinha)', () => {
    const two = cands.map((c) => ({ ...c, responded: true }));
    expect(resolveSupplierByHint(two, 'a que respondeu')).toBeNull();
  });

  it('nome que casa >1 → null (ambíguo)', () => {
    // "drogaria" é genérica (descartada); mas se a dica casar 2 nomes distintos → null
    const amb: SupplierCandidate[] = [
      { quote_id: 'a', supplier_name: 'Farmácia Central', responded: true },
      { quote_id: 'b', supplier_name: 'Central Popular', responded: true },
    ];
    expect(resolveSupplierByHint(amb, 'a central')).toBeNull();
  });

  it('dica genérica sem match → null (pede desambiguação no caller)', () => {
    expect(resolveSupplierByHint(cands, 'aquela farmácia lá')).toBeNull();
    expect(resolveSupplierByHint(cands, 'sei lá')).toBeNull();
    expect(resolveSupplierByHint([], 'São Benedito')).toBeNull();
  });

  it('MATCH POR PALAVRA INTEIRA — token curto NÃO casa dentro de outra palavra (review MEDIUM)', () => {
    const c: SupplierCandidate[] = [
      { quote_id: 'sol', supplier_name: 'Drogaria Sol', responded: false },
      { quote_id: 'est', supplier_name: 'Farmácia Estrela', responded: false },
    ];
    // "sol" está dentro de "re[sol]ve"/"con[sol]ida" — NÃO pode mirar a Drogaria Sol.
    expect(resolveSupplierByHint(c, 'resolve isso pra mim')).toBeNull();
    expect(resolveSupplierByHint(c, 'pode consolidar o pedido')).toBeNull();
    // mas o nome REAL casa:
    expect(resolveSupplierByHint(c, 'fala com a Drogaria Sol')).toBe('sol');
  });

  it('NEGAÇÃO → null (não mira a farmácia que o user pediu pra EVITAR — review LOW)', () => {
    expect(resolveSupplierByHint(cands, 'não fala com a São Benedito')).toBeNull();
    expect(resolveSupplierByHint(cands, 'qualquer uma menos a São Benedito')).toBeNull();
  });

  it('nome 100% GENÉRICO casa por frase inteira (review MEDIUM — antes era intargetável)', () => {
    const c: SupplierCandidate[] = [
      { quote_id: 'pop', supplier_name: 'Farmácia Popular', responded: true },
      { quote_id: 'sb', supplier_name: 'Drogaria São Benedito', responded: true },
    ];
    expect(resolveSupplierByHint(c, 'fala com a Farmácia Popular')).toBe('pop');
    expect(resolveSupplierByHint(c, 'a São Benedito')).toBe('sb');
  });
});

describe('sanitizeSupplierNote — não vaza marcador interno ao usuário', () => {
  it('remove marcador subst: e auto-capturado', () => {
    expect(sanitizeSupplierNote('auto-capturado| subst:só tem 20 comp')).toBe('só tem 20 comp');
  });
  it('remove prefixo "indicação de ..."', () => {
    expect(sanitizeSupplierNote('indicação de Droga Raia — tem o item')).toBe('tem o item');
  });
  it('remove nota interna de ops "fornecedor sem telefone real"', () => {
    expect(sanitizeSupplierNote('fornecedor sem telefone real')).toBe('');
  });
  it('tira URL (não vaza link/pix)', () => {
    expect(sanitizeSupplierNote('paga aqui https://pix.example/abc please')).toBe('paga aqui please');
  });
  it('mascara telefone/CPF que o LLM copiou da fala da farmácia (review LOW — defense-in-depth)', () => {
    expect(sanitizeSupplierNote('Tem o item; se quiser ligue (62) 99999-8888 pra combinar')).toBe('Tem o item; se quiser ligue [contato] pra combinar');
    expect(sanitizeSupplierNote('meu pix é 111.222.333-44')).toBe('meu pix é [contato]');
    // preço NÃO é mascarado (não é telefone de 10-11 dígitos)
    expect(sanitizeSupplierNote('fica R$ 65,00 no total')).toBe('fica R$ 65,00 no total');
  });
  it('preserva nota útil de verdade (caso São Benedito)', () => {
    const n = 'Tem o Cefaliv, mas o entregador só cobre o Setor Universitário; ofereceu despachar por Uber.';
    expect(sanitizeSupplierNote(n)).toBe(n);
  });
  it('corta em ~180 chars', () => {
    expect(sanitizeSupplierNote('x'.repeat(300)).length).toBeLessThanOrEqual(181);
  });
  it('vazio/null → string vazia', () => {
    expect(sanitizeSupplierNote('')).toBe('');
    expect(sanitizeSupplierNote(null)).toBe('');
    expect(sanitizeSupplierNote(undefined)).toBe('');
  });
});

describe('noteSignalsConditionalOffer — detecta "tem mas com ressalva/oferta"', () => {
  it('caso São Benedito (tem + só entrega + Uber) → true', () => {
    expect(noteSignalsConditionalOffer('Tem o Cefaliv, mas o entregador só cobre o Setor Universitário; ofereceu Uber.')).toBe(true);
  });
  it('retirada no balcão / horário / motoboy → true', () => {
    expect(noteSignalsConditionalOffer('só retirada no balcão')).toBe(true);
    expect(noteSignalsConditionalOffer('só entrego depois das 15h')).toBe(true);
    expect(noteSignalsConditionalOffer('não levo aí, mas você consegue um motoboy')).toBe(true);
  });
  it('indicação de outro lugar → true', () => {
    expect(noteSignalsConditionalOffer('não tenho, mas indico a Farmácia X')).toBe(true);
  });
  it('sem estoque puro (sem oferta) → false', () => {
    expect(noteSignalsConditionalOffer('não tem em estoque')).toBe(false);
    expect(noteSignalsConditionalOffer('só tem genérico, cliente quer a marca')).toBe(false);
    expect(noteSignalsConditionalOffer('')).toBe(false);
    expect(noteSignalsConditionalOffer(null)).toBe(false);
  });
  it('NEGAÇÃO de disponibilidade (Caso C puro) → false (review 07/07: "não temos" era falso-positivo)', () => {
    expect(noteSignalsConditionalOffer('Não temos esse remédio')).toBe(false);
    expect(noteSignalsConditionalOffer('não tenho o Cefaliv')).toBe(false);
    expect(noteSignalsConditionalOffer('infelizmente não tenho')).toBe(false);
    expect(noteSignalsConditionalOffer('não temos previsão')).toBe(false);
    expect(noteSignalsConditionalOffer('sem disponível no momento')).toBe(false);
  });
  it('negação MAS com alternativa oferecida → true (referral / ressalva vence)', () => {
    expect(noteSignalsConditionalOffer('não tenho, mas indico a Farmácia X')).toBe(true);
    expect(noteSignalsConditionalOffer('não entrego aí, mas você consegue um motoboy')).toBe(true);
    expect(noteSignalsConditionalOffer('tenho sim, só que entrego a partir das 15h')).toBe(true);
  });
});

// ─── Fechamento vivo (incidente Santa Lúcia 07/07) ───────────────────────────

describe('extractAcceptConditions — condições do aceite viajam com o fechamento', () => {
  it('frase REAL do incidente: prazo "antes das 19:00" extraído', () => {
    const c = extractAcceptConditions('Pode pedir da Santa Lúcia mesmo, só que tem que entregar antes das 19:00 porfavor, vai ser cartão');
    expect(c.deadlineHour).toBe(19);
    expect(c.deadlineMinute).toBe(0);
    expect(c.clause).toMatch(/entregar antes das 19/i);
    expect(c.clause).not.toMatch(/porfavor|por favor/i);
  });
  it('"até as 18:30" → 18:30', () => {
    const c = extractAcceptConditions('fecha com a 1, mas até as 18:30 tá?');
    expect(c.deadlineHour).toBe(18);
    expect(c.deadlineMinute).toBe(30);
  });
  it('condição sem hora ("desde que seja o genérico") → clause sem deadline', () => {
    const c = extractAcceptConditions('pode ser, desde que seja o genérico da EMS');
    expect(c.deadlineHour).toBeNull();
    expect(c.clause).toMatch(/gen[ée]rico/i);
  });
  it('aceite puro sem condição → nada', () => {
    const c = extractAcceptConditions('pode fechar com a 2');
    expect(c.clause).toBeNull();
    expect(c.deadlineHour).toBeNull();
  });
  it('hora inválida (25h) não vira deadline', () => {
    const c = extractAcceptConditions('entrega antes das 25 tá');
    expect(c.deadlineHour).toBeNull();
  });
});

describe('resolveSupplierByHint — casa por TELEFONE (caso real 07/07)', () => {
  const cands: SupplierCandidate[] = [
    { quote_id: 'sl', supplier_name: 'Drogaria Santa Lúcia', responded: true, phoneE164: '+5562998766733' },
    { quote_id: 'sb', supplier_name: 'Drogaria São Benedito', responded: true, phoneE164: '+556232610628' },
  ];
  it('número digitado SEM o 9º dígito casa mesmo assim (frase real do Hiago)', () => {
    expect(resolveSupplierByHint(cands, 'a que tem o número 556298766733')).toBe('sl');
  });
  it('número COM o 9º dígito também casa', () => {
    expect(resolveSupplierByHint(cands, 'entra em contato com esse telefone 5562998766733')).toBe('sl');
  });
  it('número formatado "(62) 99876-6733" casa', () => {
    expect(resolveSupplierByHint(cands, 'fala com a do (62) 99876-6733')).toBe('sl');
  });
  it('número que não é de nenhuma → cai pros outros caminhos (nome/semântica)', () => {
    expect(resolveSupplierByHint(cands, 'fala com a 62911112222')).toBeNull();
  });
});

describe('isServiceNumber — call-center não é WhatsApp de loja (caso Pague Menos)', () => {
  it('4002-8282 (com DDD/DDI) → true', () => {
    expect(isServiceNumber('+555540028282')).toBe(true);
    expect(isServiceNumber('556240028282')).toBe(true);
  });
  it('0800 → true', () => {
    expect(isServiceNumber('08007779999')).toBe(true);
  });
  it('celular normal de loja → false', () => {
    expect(isServiceNumber('+5562998766733')).toBe(false);
    expect(isServiceNumber('+556232610628')).toBe(false);
  });
});

describe('humanizePaymentLabel', () => {
  it('normaliza tokens do banco', () => {
    expect(humanizePaymentLabel('cartao')).toBe('cartão');
    expect(humanizePaymentLabel('cartão de crédito')).toBe('cartão de crédito');
    expect(humanizePaymentLabel('pix')).toBe('Pix');
    expect(humanizePaymentLabel('dinheiro')).toBe('dinheiro');
  });
});

describe('humanizeSupplierText — sem emoji, sem travessão (farmácia não pode achar que é robô)', () => {
  it('troca travessão por vírgula e tira emoji (fechamento real)', () => {
    const out = humanizeSupplierText('o endereço é Rua Ema 5, Qd 19 Lt 28 — pagamento no cartão, tá? me avisa quando sair 🙏');
    expect(out).toBe('o endereço é Rua Ema 5, Qd 19 Lt 28, pagamento no cartão, tá? me avisa quando sair');
    expect(out).not.toMatch(/[—–]/);
    expect(out).not.toMatch(/\p{Extended_Pictographic}/u);
  });
  it('tira TODO emoji (vários tipos)', () => {
    expect(humanizeSupplierText('Sou a Xarlote! 😃 fechou 🙌 pode preparar 💙')).toBe('Sou a Xarlote! fechou pode preparar');
    expect(humanizeSupplierText('perfeito 🙂✅')).toBe('perfeito');
  });
  it('meia-risca (–) também vira vírgula', () => {
    expect(humanizeSupplierText('fechou – pode separar')).toBe('fechou, pode separar');
  });
  it('não estraga texto normal (sem emoji/travessão)', () => {
    expect(humanizeSupplierText('oi, vocês têm cefaliv 500mg? é pra entregar no setor oeste')).toBe('oi, vocês têm cefaliv 500mg? é pra entregar no setor oeste');
  });
  it('limpa vírgula/espaço sobrando quando o emoji estava no fim', () => {
    expect(humanizeSupplierText('anotado, valeu 🙏')).toBe('anotado, valeu');
    expect(humanizeSupplierText('  ')).toBe('');
  });
});
