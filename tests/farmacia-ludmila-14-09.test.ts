/**
 * O primeiro caso real depois do redesenho da farmácia (Ludmila, 14/09/2026, 14:54–16:29):
 * duas receitas, nenhuma cotada. Cada teste aqui é um fato daquela conversa — os nomes de
 * produto são os que a Pague Menos / DPSP / Drogal devolveram na busca ao vivo de 15/09.
 */
import { describe, it, expect } from 'vitest';
import {
  enderecoFoiMencionado, parseEnderecoDigitado, montarEnderecoHumano, extractDeliverySector,
} from '../packages/shared/src/endereco-entrega';
import {
  nomeExisteEm, posicaoDoTokenNoProduto, nomeJaConfirmadoPeloPaciente, perguntaDeConfirmacaoDeNome,
} from '../packages/shared/src/nome-remedio';
import { quantidadeFoiMencionada, numeroDaQuantidade } from '../packages/shared/src/quantidade-pedida';
import { rankProductMatches, brandInBrandPosition } from '../packages/integrations/src/pharmacy-platforms/matching';
import { verificarAnuncios, semAnuncios, falaHonestaPara, FAMILIAS_DE_PROMESSA_SEM_FERRAMENTA } from '../packages/shared/src/claim-guard';

const RECEITA_2 = '[foto enviada pelo paciente: Receita médica da endocrinologista Dra. Roberta Caroline Prado Takenobu, com CRM GO 23287 e RQE 17264, para paciente Ludmila dos Santos. Prescrição de uso oral contínuo de Espironolactona 50 mg, tomar 1 vez ao dia; Ômega 3 (citrato de legdlu) contínuo, tomar 1 vez antes do café e jantar; Neutrogen 300 mg, 3 vezes ao dia, tomar 1 hora antes do almoço por 3 meses; e Alto D 15.000 UI contínuo, tomar 1 vez ao dia 1 ml sublingual.]';

describe('endereço — o consentimento pela fala, como a conversa foi', () => {
  const trabalho = { label: 'trabalho', street: 'Rua 14' };
  it('"Pode ser pro trabalho" duas falas antes de "Isso" conta (a janela era 1 fala)', () => {
    const falas = ['Isso', 'É esse mesmo, Xarlote', 'Pode ser pro trabalho', 'Você pode cotar, por favor'];
    expect(enderecoFoiMencionado(falas, trabalho)).toBe(true);
  });
  it('"Confirmo o pedido pro trabalho, no cartão?" → "Isso" é consentimento pela proposta', () => {
    expect(enderecoFoiMencionado(['Isso'], trabalho, { propostaDaXarlote: 'Anotado, Oxandrolona 5mg. Confirmo o pedido pro trabalho, no cartão?', respostaAtual: 'Isso' })).toBe(true);
    expect(enderecoFoiMencionado(['Isso'], { label: 'casa', street: 'Rua 14' }, { propostaDaXarlote: 'Confirmo o pedido pro trabalho, no cartão?', respostaAtual: 'Isso' })).toBe(false);
    // proposta com DOIS rótulos: "isso" não escolhe nada
    expect(enderecoFoiMencionado(['Isso'], trabalho, { propostaDaXarlote: 'Quer entrega pra sua casa ou trabalho?', respostaAtual: 'Isso' })).toBe(false);
    // resposta longa não é "isso"
    expect(enderecoFoiMencionado(['vou te enviar outra receita'], trabalho, { propostaDaXarlote: 'Confirmo pro trabalho?', respostaAtual: 'vou te enviar outra receita' })).toBe(false);
  });
  it('"isso. entrega na rua 14" casa a rua mesmo quando o street gravado tem número/quadra/lote', () => {
    expect(enderecoFoiMencionado(['isso. entrega na rua 14'], { label: 'casa', street: 'Rua 14, 201, Qd. B8, Lt. 20' })).toBe(true);
    expect(enderecoFoiMencionado(['rua 14, 201, setor oeste'], { label: 'casa', street: 'Rua 14' })).toBe(true);
  });
  it('a foto com "Você pode cotar" continua NÃO sendo consentimento', () => {
    expect(enderecoFoiMencionado(['Você pode cotar, por favor', RECEITA_2], trabalho)).toBe(false);
  });
});

describe('endereço — o que ela digitou é o dado', () => {
  it('"Rua 14, 201, Qd. B8, Lt. 20, Setor Oeste, Goiânia" preserva número, quadra/lote e setor', () => {
    const e = parseEnderecoDigitado('Rua 14, 201, Qd. B8, Lt. 20, Setor Oeste, Goiânia');
    expect(e).toEqual({ street: 'Rua 14', number: '201', complement: 'Qd. B8, Lt. 20', neighborhood: 'Setor Oeste', city: 'Goiânia', state: null, cep: null });
    expect(montarEnderecoHumano(e)).toBe('Rua 14, 201, Qd. B8, Lt. 20, Setor Oeste, Goiânia');
  });
  it('outras grafias: número colado, UF, CEP, "St."', () => {
    expect(parseEnderecoDigitado('Av. T-63 1296, Setor Bueno, Goiânia - GO, 74230-100')).toEqual({ street: 'Av. T-63', number: '1296', complement: null, neighborhood: 'Setor Bueno', city: 'Goiânia', state: 'GO', cep: '74230-100' });
    expect(parseEnderecoDigitado('R. 14, 201, St. Oeste, Goiânia, Goiás')).toMatchObject({ street: 'R. 14', number: '201', neighborhood: 'St. Oeste', city: 'Goiânia', state: 'Goiás' });
    expect(parseEnderecoDigitado('Rua 111, 335, Setor Sul - Prédio Fadex')).toMatchObject({ street: 'Rua 111', number: '335', neighborhood: 'Setor Sul' });
    expect(parseEnderecoDigitado('')).toMatchObject({ street: null });
  });
  it('o setor pra farmácia vem do endereço humano (a cópia local que dizia "Rua 14, Lt. 20" morreu)', () => {
    expect(extractDeliverySector('Rua 14, 201, Qd. B8, Lt. 20, Setor Oeste, Goiânia')).toBe('Setor Oeste');
  });
});

describe('nome do remédio — posição de marca e memória da conversa', () => {
  const pagueMenos = [
    'Colete Putti Elástico Alto | GG', 'Artrinutri Dimalato + Colágeno Tipo 2 + Magnésio + Vitamina D3 - 60 cápsulas',
    'Neutrofer 300mg 30 Comprimidos', 'Suplemento Alimentar Neutrofer Folato D 30 Comprimidos',
    'Espironolactona 50mg 30 Comprimidos Genérico EMS', 'Cloridrato de Metformina 500mg 30 Comprimidos', 'Antialérgico Allegra D 60mg + 120mg',
    'Omega 3 Plus Vita Mais 120 Capsulas', 'Turkesterone 500mg 30 Cápsulas',
  ];
  it('"alto" em "Colete … Alto" NÃO prova que "Alto D" existe; marca na posição de marca prova', () => {
    expect(nomeExisteEm('alto', pagueMenos)).toBe(false);
    expect(posicaoDoTokenNoProduto('alto', 'Colete Putti Elástico Alto | GG')).toBe(4);
    expect(nomeExisteEm('neutrofer', pagueMenos)).toBe(true);
    expect(nomeExisteEm('espironolactona', pagueMenos)).toBe(true);
    expect(nomeExisteEm('metformina', pagueMenos)).toBe(true); // depois do sal
    expect(nomeExisteEm('allegra', pagueMenos)).toBe(true);    // depois da categoria
    expect(nomeExisteEm('omega', pagueMenos)).toBe(true);
    expect(nomeExisteEm('oxandrolona', pagueMenos)).toBe(false); // manipulado: não está nas redes (e é real)
    expect(nomeExisteEm('neutrogen', pagueMenos)).toBe(false);
  });
  it('a pergunta já feita + qualquer resposta dela = confirmado (não pergunta 4 vezes)', () => {
    const conversa: Array<{ direction: 'in' | 'out'; content: string }> = [
      { direction: 'in', content: 'Pode ser pro trabalho' },
      { direction: 'out', content: perguntaDeConfirmacaoDeNome('Oxandrolona 5 mg', 'foto') },
      { direction: 'in', content: 'É esse mesmo, Xarlote' },
    ];
    expect(nomeJaConfirmadoPeloPaciente(conversa, 'Oxandrolona')).toBe(true);
    expect(nomeJaConfirmadoPeloPaciente(conversa.slice(0, 2), 'Oxandrolona')).toBe(false); // perguntou, ela ainda não respondeu
    expect(nomeJaConfirmadoPeloPaciente(conversa, 'Neutrogen')).toBe(false);                 // outro nome
  });
  it('ela mesma escreveu o nome ("é neutrofer 300mg") → é palavra dela', () => {
    expect(nomeJaConfirmadoPeloPaciente([{ direction: 'in', content: 'é neutrofer 300mg' }], 'Neutrofer')).toBe(true);
  });
});

describe('quantidade — o que ninguém disse não entra', () => {
  it('"30 cápsulas"/"90 cápsulas" inventados da posologia caem; "1 caixa" fica', () => {
    const falas = ['isso. entrega na rua 14', 'xarlote, é omega 3, não é omeprazol', RECEITA_2];
    expect(quantidadeFoiMencionada(falas, '30 cápsulas')).toBe(false);
    expect(quantidadeFoiMencionada(falas, '90 cápsulas')).toBe(false);
    expect(quantidadeFoiMencionada(falas, '30 ml')).toBe(false);
    expect(quantidadeFoiMencionada(falas, '1 caixa')).toBe(true);
    expect(quantidadeFoiMencionada(falas, 'uma caixa')).toBe(true);
    expect(quantidadeFoiMencionada(falas, null)).toBe(true);
  });
  it('quantidade DITA pelo paciente ou lida da receita fica', () => {
    expect(quantidadeFoiMencionada(['quero 2 caixas de dipirona'], '2 caixas')).toBe(true);
    expect(quantidadeFoiMencionada(['Pietra 2mg 30 comprimidos'], '30 comprimidos')).toBe(true);
    expect(quantidadeFoiMencionada(['[foto: Oxandrolona 5mg, 30 cápsulas, tomar 1 ao dia]'], '30 cápsulas')).toBe(true);
    expect(numeroDaQuantidade('duas caixas')).toBe(2);
  });
});

describe('ranqueador — a cotação de plataforma de 14/09, com os produtos reais', () => {
  const p = (productName: string) => ({ productName, availableQuantity: 5 }) as any;
  const pagueMenos = [
    p('Neutrofer 150mg 30 Comprimidos'), p('Neutrofer 500mg 30 Comprimidos'), p('Neutrofer 300mg 30 Comprimidos'),
    p('Neutrofer Colina DHA 60 Cápsulas'), p('Suplemento Alimentar Neutrofer Folato D 30 Comprimidos'),
    p('Espironolactona 100mg 30 Comprimidos Genérico Germed'), p('Espironolactona 50mg 30 Comprimidos Genérico EMS'), p('Espironolactona 25mg 30 Comprimidos Genérico Eurofarma'),
    p('Colete Putti Elástico Alto | GG'), p('Flex-HA 30 Cápsulas'),
  ];
  it('"Espironolactona 50mg 30 cápsulas" (forma inventada) acha a Espironolactona 50mg Comprimidos', () => {
    const r = rankProductMatches('Espironolactona 50mg 30 cápsulas', pagueMenos).map((x) => x.product.productName);
    expect(r[0]).toBe('Espironolactona 50mg 30 Comprimidos Genérico EMS');
    expect(r).not.toContain('Espironolactona 100mg 30 Comprimidos Genérico Germed');
  });
  it('"Neutrofer 300mg 90 cápsulas" acha o Neutrofer 300mg, não o Colina DHA', () => {
    const r = rankProductMatches('Neutrofer 300mg 90 cápsulas', pagueMenos).map((x) => x.product.productName);
    expect(r[0]).toBe('Neutrofer 300mg 30 Comprimidos');
    expect(r).not.toContain('Neutrofer Colina DHA 60 Cápsulas');
  });
  it('"Neutrofer 300mg" sem quantidade: idem', () => {
    const r = rankProductMatches('Neutrofer 300mg', pagueMenos).map((x) => x.product.productName);
    expect(r).toEqual(['Neutrofer 300mg 30 Comprimidos']);
  });
  it('"Alto D 15000 UI" NÃO casa o colete (marca fora da posição de marca)', () => {
    expect(rankProductMatches('Alto D 15000 UI', pagueMenos)).toEqual([]);
    expect(brandInBrandPosition('alto', p('Colete Putti Elástico Alto | GG'))).toBe(false);
    expect(brandInBrandPosition('metformina', p('Cloridrato de Metformina 500mg'))).toBe(true);
    expect(brandInBrandPosition('metformina', { ...p('Glifage XR 500mg'), activeIngredient: ['Cloridrato de Metformina'] })).toBe(true);
  });
  it('gotas × comprimido continua grave (a família é só oral sólido)', () => {
    const r = rankProductMatches('Neutrofer 250mg/ml gotas', [p('Neutrofer 250mg/ml Gotas 30ml'), p('Neutrofer 300mg 30 Comprimidos')]).map((x) => x.product.productName);
    expect(r).toEqual(['Neutrofer 250mg/ml Gotas 30ml']);
  });
});

describe('promessa sem ferramenta — "vou ajustar a cotação"', () => {
  it('a oração cai e entra a fala honesta', () => {
    const texto = 'Entendi, Ludmila, esse colete não faz parte do seu tratamento da receita que você me enviou. Vou ajustar a cotação só com os remédios, tá? Já te aviso.';
    const v = verificarAnuncios(texto, [], []);
    expect(v.suspect.map((s) => s.kind)).toContain('ajuste_de_cotacao');
    const limpo = semAnuncios(texto, FAMILIAS_DE_PROMESSA_SEM_FERRAMENTA);
    expect(limpo.removidas.length).toBe(1);
    expect(limpo.texto).not.toContain('ajustar a cotação');
    expect(falaHonestaPara('ajuste_de_cotacao')).toContain('por engano');
  });
  it('com busca nova no turno a promessa vira verdade (não é suspeita)', () => {
    const v = verificarAnuncios('Refiz a cotação só com os remédios da receita 💙', [], ['start_pharmacy_order']);
    expect(v.suspect.filter((s) => s.kind === 'ajuste_de_cotacao')).toEqual([]);
  });
  it('"tirei o Alto D da lista" também é a família', () => {
    expect(verificarAnuncios('Tirei o Alto D da lista e mantive o resto.', [], []).suspect.map((s) => s.kind)).toContain('ajuste_de_cotacao');
  });
});
