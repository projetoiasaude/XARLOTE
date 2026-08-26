/**
 * O laudo longo perdia justamente a metade que importa.
 *
 * O corte era `texto.slice(0, 24000)` — por POSIÇÃO. E a ordem de um laudo de laboratório é
 * quase sempre a mesma: cabeçalho e endereço do laboratório, dados do paciente, hemograma,
 * bioquímica, hormônios, observação do responsável técnico, rodapé legal.
 *
 * Ou seja: o corte preservava o CNPJ do laboratório e jogava fora a bioquímica.
 */
import { describe, it, expect } from 'vitest';
import { recortarLaudo, linhaTemValor, LINHAS_DE_CABECALHO } from '../packages/shared/src/laudo-recorte.js';

/** Um laudo sintético com a forma real: ruído na frente, valor no fim. */
function laudoLongo(): string {
  const cabecalho = [
    'LABORATÓRIO SINTÉTICO DE ANÁLISES CLÍNICAS',
    'Rua das Flores, nº 1200 - Setor Central',
    'CNPJ 00.000.000/0001-00',
    'Telefone (62) 3000-0000 · www.laboratorio.exemplo',
    'Paciente: Fulano de Tal    Idade: 54 anos',
    'Data da coleta: 20/08/2026    Material: sangue total',
  ];
  // Muito texto corrido sem valor nenhum, pra estourar o limite.
  // Prosa longa sem resultado — é o que ocupa o meio de um laudo e empurrava a bioquímica
  // pra fora do corte por posição.
  const enchimento = Array.from({ length: 400 }, () =>
    'Observacao metodologica: o ensaio segue procedimento operacional padrao interno revisado periodicamente pela equipe tecnica responsavel.');
  const bioquimica = [
    'Glicemia de jejum: 96 mg/dL   valor de referência: menor que 100',
    'Colesterol total: 212 mg/dL   valor de referência: até 190',
    'TSH: 4,8 UI/L   valor de referência: 0,4 a 4,0',
    'Creatinina: 1,1 mg/dL   valor de referência 0,7 a 1,3',
  ];
  const rodape = ['Página 3 de 3', 'Assinado digitalmente por Dr. Sintético · CRM 00000'];
  return [...cabecalho, ...enchimento, ...bioquimica, ...rodape].join('\n');
}

describe('o que sobrevive ao corte', () => {
  const texto = laudoLongo();
  const limite = 2_000; // bem menor que o documento, pra forçar a escolha
  const r = recortarLaudo(texto, limite);

  it('o documento realmente não cabia', () => {
    expect(texto.length).toBeGreaterThan(limite);
    expect(r.cortado).toBe(true);
  });

  it('🔴 a bioquímica do FIM sobrevive — era exatamente o que se perdia', () => {
    for (const marcador of ['Glicemia', 'Colesterol', 'TSH', 'Creatinina']) {
      expect(r.texto, `"${marcador}" ficou de fora`).toContain(marcador);
    }
  });

  it('e os valores vêm junto, não só os nomes', () => {
    expect(r.texto).toContain('96 mg/dL');
    expect(r.texto).toContain('212 mg/dL');
  });

  it('o cabeçalho de identificação continua (de quem é e de quando)', () => {
    expect(r.texto).toContain('Paciente');
    expect(r.texto).toContain('Material');
  });

  it('o ruído do laboratório é descartado', () => {
    expect(r.texto).not.toContain('CNPJ');
    expect(r.texto).not.toContain('www.laboratorio');
    expect(r.texto).not.toContain('Página 3 de 3');
  });

  it('o corte por POSIÇÃO teria perdido tudo isso', () => {
    // A prova de que a mudança importa: o comportamento antigo, no mesmo limite.
    const antigo = texto.slice(0, limite);
    expect(antigo).not.toContain('Glicemia');
    expect(antigo).toContain('CNPJ');
  });

  it('respeita o teto', () => {
    expect(r.texto.length).toBeLessThanOrEqual(limite);
  });

  it('mantém a ORDEM original', () => {
    // Laudo fora de ordem confunde mais que laudo incompleto.
    expect(r.texto.indexOf('Glicemia')).toBeLessThan(r.texto.indexOf('Creatinina'));
  });
});

describe('documento que cabe não é tocado', () => {
  it('volta idêntico, byte a byte', () => {
    const curto = 'Hemoglobina 13,2 g/dL\nLeucócitos 6.200 /mm3';
    const r = recortarLaudo(curto, 24_000);
    expect(r.texto).toBe(curto);
    expect(r.cortado).toBe(false);
  });

  it('texto vazio não quebra', () => {
    expect(recortarLaudo('', 100).texto).toBe('');
  });
});

describe('o que conta como linha de valor', () => {
  it.each([
    'Hemoglobina: 13,2 g/dL',
    'Glicose 96 mg/dL',
    'Plaquetas 245 mil/mm3',
    'TSH 4,8 UI/L valor de referência 0,4 a 4,0',
    'Pressão 120 mmHg',
  ])('"%s" tem valor', (l) => expect(linhaTemValor(l)).toBe(true));

  it('prosa longa com número NÃO é linha de resultado', () => {
    expect(linhaTemValor(
      'Observacao metodologica 3: o ensaio segue procedimento operacional padrao interno revisado periodicamente pela equipe tecnica responsavel pelo setor.',
    )).toBe(false);
  });

  it.each([
    'CNPJ 00.000.000/0001-00',
    'Rua das Flores, nº 1200',
    'Página 3 de 3',
    'Assinado digitalmente por Dr. Sintético',
    '   ',
  ])('"%s" é ruído', (l) => expect(linhaTemValor(l)).toBe(false));

  it('o cabeçalho tem folga suficiente pra identificar o exame', () => {
    expect(LINHAS_DE_CABECALHO).toBeGreaterThanOrEqual(6);
  });
});
