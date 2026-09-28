/**
 * Dose que ninguém disse não entra no pedido — e a pergunta de dose cita o CATÁLOGO, não a
 * memória do modelo. Caso real de 28/09/2026 (fundador, Cefaliv): a Xarlote ofereceu "10mg, 20mg
 * e 40mg" de um remédio que só existe em 1mg + 100mg + 350mg, escolheu "20mg, a mais comum"
 * sozinha, e o ranqueador recusou o Cefaliv verdadeiro em todas as redes.
 */
import { describe, it, expect } from 'vitest';
import {
  doseFoiDita,
  dosesNaFala,
  separarDoseDoNome,
  doseAPerguntar,
  instrucaoDePerguntaDeDose,
  normalizarNumero,
} from '../packages/shared/src/dose-pedida.js';
import { apresentacoesDoCatalogo } from '../packages/integrations/src/pharmacy-platforms/apresentacoes.js';
import { buildXarloteSystemPrompt } from '../packages/llm/src/prompts/xarlote.system.js';

// As falas do paciente naquele pedido, na ordem (texto, texto, áudio transcrito).
const FALAS_DE_28_09 = [
  'Pode pedir um remédio pra mim? Um cefaliv',
  'O de sempre',
  'Primeiro que esse endereço tá errado, eu não tô aí não, eu tô aqui na empresa, é',
];

describe('doseFoiDita — o caso Cefaliv (28/09)', () => {
  it('"20mg" que só a Xarlote disse NÃO entra no pedido', () => {
    expect(doseFoiDita(FALAS_DE_28_09, '20mg', 'Cefaliv')).toBe(false);
  });

  it('a fala da própria Xarlote não é prova (só as do paciente entram nas evidências)', () => {
    // o handler monta as evidências só com mensagens de ENTRADA; aqui, o teste da regra pura:
    // se alguém passasse a fala da Xarlote, ela provaria — por isso ela nunca é passada.
    expect(doseFoiDita(['Cefaliv 20mg é a dosagem mais comum, vou com essa'], '20mg', 'Cefaliv')).toBe(true);
  });

  it('dose dita pelo paciente fica — com unidade, colada no nome ou como resposta curta', () => {
    expect(doseFoiDita(['quero cefaliv 20'], '20mg', 'Cefaliv')).toBe(true);
    expect(doseFoiDita(['minha losartana de 50 acabou'], '50mg', 'Losartana')).toBe(true);
    expect(doseFoiDita(['losartana potássica 50'], '50mg', 'Losartana')).toBe(true);
    expect(doseFoiDita(['é a de 50mg'], '50mg', 'Losartana')).toBe(true);
    expect(doseFoiDita(['50'], '50mg', 'Losartana')).toBe(true);
    expect(doseFoiDita(['a de 20 mesmo'], '20mg', 'Cefaliv')).toBe(true);
  });

  it('número de endereço, quantidade, frequência, data, hora ou preço não prova dose', () => {
    expect(doseFoiDita(['manda pra Rua 20, Setor Sul'], '20mg', 'Cefaliv')).toBe(false);
    expect(doseFoiDita(['Rua 14, 201, Qd. B8, Lt. 20, Setor Oeste'], '20mg', 'Cefaliv')).toBe(false);
    expect(doseFoiDita(['2 caixas'], '2mg', 'Rivotril')).toBe(false);
    expect(doseFoiDita(['tomo de 8 em 8 horas'], '8mg', 'Ondansetrona')).toBe(false);
    expect(doseFoiDita(['2x ao dia'], '2mg', 'Rivotril')).toBe(false);
    expect(doseFoiDita(['preciso até o dia 20'], '20mg', 'Cefaliv')).toBe(false);
    expect(doseFoiDita(['chego às 20'], '20mg', 'Cefaliv')).toBe(false);
    expect(doseFoiDita(['tenho R$ 20'], '20mg', 'Cefaliv')).toBe(false);
  });

  it('unidade diferente, mesma dose: "1g" prova "1000mg"; "500mcg" prova "0,5mg"', () => {
    expect(doseFoiDita(['dipirona 1g'], '1000mg', 'Dipirona')).toBe(true);
    expect(doseFoiDita(['é 500mcg'], '0,5mg', 'Levotiroxina')).toBe(true);
    expect(doseFoiDita(['clonazepam 0,5'], '0.5mg', 'Clonazepam')).toBe(true);
  });

  it('o prontuário prova: remédio em uso com a dose ("Losartana 50mg")', () => {
    expect(doseFoiDita(['quero minha losartana', 'Losartana 50mg'], '50mg', 'Losartana')).toBe(true);
  });

  it('dose combinada: basta um valor dito ("cefaliv 350" prova "1mg + 100mg + 350mg")', () => {
    expect(doseFoiDita(['cefaliv 350'], '1mg + 100mg + 350mg', 'Cefaliv')).toBe(true);
  });

  it('sem número na dose (ex.: "forte") não há o que provar', () => {
    expect(doseFoiDita(FALAS_DE_28_09, 'forte', 'Buscopan')).toBe(true);
    expect(doseFoiDita(FALAS_DE_28_09, undefined, 'Cefaliv')).toBe(true);
  });

  it('palavra que só TERMINA em "n" antes do número não vira "nº" ("enalapril bian 20")', () => {
    expect(dosesNaFala('enalapril bian 20', 'enalapril').has('20')).toBe(true);
  });
});

describe('normalizarNumero', () => {
  it('vírgula decimal, zero à esquerda e milhar', () => {
    expect(normalizarNumero('0,5')).toBe('0.5');
    expect(normalizarNumero('05')).toBe('5');
    expect(normalizarNumero('1.000')).toBe('1000');
    expect(normalizarNumero('12,5')).toBe('12.5');
  });
});

describe('separarDoseDoNome — dose escrita no nome passa pela guarda', () => {
  it('tira a dose com unidade do nome', () => {
    expect(separarDoseDoNome('Cefaliv 20mg')).toEqual({ nome: 'Cefaliv', dose: '20mg' });
    expect(separarDoseDoNome('Amoxicilina + Clavulanato 875mg + 125mg')).toEqual({ nome: 'Amoxicilina + Clavulanato', dose: '875mg + 125mg' });
    expect(separarDoseDoNome('Insulina NPH 100UI/ml')).toEqual({ nome: 'Insulina NPH', dose: '100UI/ml' });
  });

  it('número sem unidade fica no nome (pode ser parte da marca)', () => {
    expect(separarDoseDoNome('Vitamina D3')).toEqual({ nome: 'Vitamina D3', dose: null });
    expect(separarDoseDoNome('Neutrofer 300')).toEqual({ nome: 'Neutrofer 300', dose: null });
    expect(separarDoseDoNome('Cefaliv')).toEqual({ nome: 'Cefaliv', dose: null });
  });
});

describe('apresentacoesDoCatalogo — as doses que EXISTEM, do catálogo real', () => {
  it('Cefaliv: uma apresentação só (as caixas de 12 e 20 são a mesma dose)', () => {
    expect(apresentacoesDoCatalogo('cefaliv', [
      'Cefaliv 1mg + 100mg + 350mg 12 Comprimidos',
      'Cefaliv 1mg + 100mg + 350mg 20 Comprimidos',
      'Kit Cefaliv 1mg + 100mg + 350mg 2 Caixas',
    ])).toEqual(['1mg + 100mg + 350mg']);
  });

  it('Losartana: várias, em ordem de dose — o combinado aparece como opção à parte', () => {
    expect(apresentacoesDoCatalogo('losartana', [
      'Losartana Potássica 50mg 30 Comprimidos Revestidos',
      'Losartana Potássica 100mg 30 Comprimidos',
      'Losartana Potássica 25mg 30 Comprimidos',
      'Losartana Potássica + Hidroclorotiazida 50mg + 12,5mg 30 Comprimidos',
      'Aradois Losartana Potássica 50mg 30 Comprimidos',
    ])).toEqual(['25mg', '50mg', '50mg + 12,5mg', '100mg']);
  });

  it('volume do frasco não é dose; "1g" e "1000mg" são a mesma; fora da posição de marca não conta', () => {
    expect(apresentacoesDoCatalogo('dipirona', [
      'Dipirona Monoidratada 500mg/ml Gotas 20ml',
      'Dipirona 1g 10 Comprimidos',
      'Dipirona Sódica 1000mg 10 Comprimidos',
      'Kit Farmácia Caseira com Termômetro, Algodão e Dipirona 500mg',
    ])).toEqual(['500mg', '1g']);
  });
});

describe('doseAPerguntar — o catálogo decide se precisa perguntar', () => {
  it('sem dose e uma apresentação só → segue sem perguntar (Cefaliv)', () => {
    expect(doseAPerguntar({ name: 'Cefaliv' }, ['1mg + 100mg + 350mg'])).toBeNull();
  });

  it('sem dose e várias apresentações → pergunta com as REAIS', () => {
    expect(doseAPerguntar({ name: 'Losartana' }, ['25mg', '50mg', '100mg'])).toEqual({ nome: 'Losartana', opcoes: ['25mg', '50mg', '100mg'] });
  });

  it('com dose dita → segue (a palavra do paciente vence o catálogo, que pode estar incompleto)', () => {
    expect(doseAPerguntar({ name: 'Losartana', dosage: '50mg' }, ['25mg', '100mg'])).toBeNull();
  });

  it('catálogo mudo (redes fora) → segue', () => {
    expect(doseAPerguntar({ name: 'Losartana' }, null)).toBeNull();
    expect(doseAPerguntar({ name: 'Losartana' }, [])).toBeNull();
  });

  it('a instrução cita só as opções reais e proíbe escolher por ele', () => {
    const t = instrucaoDePerguntaDeDose([{ nome: 'Losartana', opcoes: ['25mg', '50mg', '100mg'] }]);
    expect(t).toContain('NENHUM pedido foi criado');
    expect(t).toContain('• Losartana: 25mg, 50mg ou 100mg');
    expect(t).toContain('NUNCA escolha por ele');
  });
});

describe('o prompt não manda mais citar doses de memória', () => {
  const p = buildXarloteSystemPrompt({ preferredName: 'Hiago' });

  it('a instrução antiga ("citando as reais", o exemplo da Losartana de cabeça) saiu', () => {
    expect(p).not.toContain('citando as reais');
    expect(p).not.toContain('Losartana tem 25, 50 e 100mg, qual é a sua?');
  });

  it('as regras novas estão lá: catálogo, nunca escolher por ele', () => {
    expect(p).toContain('Opções de dose saem do CATÁLOGO, nunca da sua memória');
    expect(p).toContain('NUNCA escolha a dose pelo paciente');
  });
});
