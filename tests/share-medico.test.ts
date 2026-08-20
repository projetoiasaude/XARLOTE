/**
 * A página do médico — as funções que decidem o que ele lê.
 *
 * Esta é a única superfície do produto que uma pessoa de FORA abre, e ela mostra número de
 * laudo. Cada teste aqui existe porque a falha correspondente significa um médico lendo um
 * valor errado, ou lendo "nenhuma alergia" sobre um paciente que tem uma.
 *
 * Fixtures são sintéticas de propósito: nunca nome, telefone ou valor de paciente real.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { lerReferencia, numeroBr, numeroTexto, situacao } from '../apps/web/lib/medico/numeros.js';
import {
  adesaoPercentual,
  frescor,
  gravidadeDe,
  lerResumo,
  normalizarGravidade,
  ordenarAlergias,
  triagem,
  type Alergia,
  type ResumoMedico,
} from '../apps/web/lib/medico/resumo.js';
import {
  CAIXA_PADRAO,
  FONTE_EIXO,
  descricaoSerie,
  geometria,
  seriesDosExames,
  tendencia,
} from '../apps/web/lib/medico/serie.js';
import { resumoTexto } from '../apps/web/lib/medico/texto.js';

const AGORA = Date.parse('2026-08-18T15:00:00.000Z');

// ─── numeroBr ──────────────────────────────────────────────────────────────────

describe('numeroBr — o decimal brasileiro lido de uma foto de laudo', () => {
  it('vírgula é o decimal e ponto é milhar', () => {
    expect(numeroBr('13,5')).toBe(13.5);
    expect(numeroBr('1.234,56')).toBe(1234.56);
    expect(numeroBr('0,05')).toBe(0.05);
  });

  it('sem vírgula, agrupamento de 3 é milhar — leucócitos 7.200 são sete mil e duzentos', () => {
    expect(numeroBr('7.200')).toBe(7200);
    expect(numeroBr('1.234.567')).toBe(1234567);
    expect(numeroBr('10.000')).toBe(10000);
  });

  it('sem vírgula, ponto com 1 ou 2 casas é decimal', () => {
    expect(numeroBr('13.5')).toBe(13.5);
    expect(numeroBr('13.55')).toBe(13.55);
  });

  it('zero na frente nunca é agrupamento de milhar (0.850 é 0,85, não 850)', () => {
    // Ninguém escreve 850 como "0.850". Se a regra do milhar valesse aqui, um TSH de 0,85
    // apareceria no gráfico como 850 — três ordens de grandeza de erro.
    expect(numeroBr('0.850')).toBe(0.85);
    expect(numeroBr('0.500')).toBe(0.5);
  });

  it('unidade colada no valor não impede a leitura', () => {
    expect(numeroBr('13,5 g/dL')).toBe(13.5);
    expect(numeroBr('98 mg/dL')).toBe(98);
    expect(numeroBr('45%')).toBe(45);
  });

  it('valor CENSURADO não é medida — não vira ponto no gráfico', () => {
    // "<0,01" é limite de detecção. Plotar 0,01 finge uma precisão que o laudo recusou dar.
    expect(numeroBr('<0,01')).toBeNull();
    expect(numeroBr('< 0,01')).toBeNull();
    expect(numeroBr('> 200')).toBeNull();
    expect(numeroBr('≤ 5,7')).toBeNull();
  });

  it('valor COMPOSTO não é um número — pressão arterial não pode virar 120', () => {
    expect(numeroBr('120/80')).toBeNull();
    expect(numeroBr('120 / 80')).toBeNull();
  });

  it('texto e lixo viram null, nunca um número inventado', () => {
    expect(numeroBr('Não reagente')).toBeNull();
    expect(numeroBr('Negativo')).toBeNull();
    expect(numeroBr('')).toBeNull();
    expect(numeroBr(null)).toBeNull();
    expect(numeroBr(undefined)).toBeNull();
    expect(numeroBr('12.5.3')).toBeNull();
    expect(numeroBr('1,234,567')).toBeNull(); // notação americana: ambígua demais
  });

  it('negativo sobrevive', () => {
    expect(numeroBr('-1,5')).toBe(-1.5);
  });
});

// ─── lerReferencia / situacao ──────────────────────────────────────────────────

describe('lerReferencia — a faixa que o laudo imprimiu', () => {
  it('lê faixa em todas as formas que aparecem em laudo', () => {
    expect(lerReferencia('12-16')).toEqual({ tipo: 'faixa', min: 12, max: 16 });
    expect(lerReferencia('12 - 16')).toEqual({ tipo: 'faixa', min: 12, max: 16 });
    expect(lerReferencia('12,0 a 16,0')).toEqual({ tipo: 'faixa', min: 12, max: 16 });
    expect(lerReferencia('12 até 16')).toEqual({ tipo: 'faixa', min: 12, max: 16 });
    expect(lerReferencia('12–16')).toEqual({ tipo: 'faixa', min: 12, max: 16 }); // en dash
    expect(lerReferencia('VR: 70-99')).toEqual({ tipo: 'faixa', min: 70, max: 99 });
    expect(lerReferencia('Valores de referência: 70-99')).toEqual({ tipo: 'faixa', min: 70, max: 99 });
  });

  it('lê teto e piso', () => {
    expect(lerReferencia('< 200')).toEqual({ tipo: 'max', max: 200 });
    expect(lerReferencia('até 100')).toEqual({ tipo: 'max', max: 100 });
    expect(lerReferencia('menor que 150')).toEqual({ tipo: 'max', max: 150 });
    expect(lerReferencia('inferior a 5,7')).toEqual({ tipo: 'max', max: 5.7 });
    expect(lerReferencia('> 40')).toEqual({ tipo: 'min', min: 40 });
    expect(lerReferencia('maior que 40')).toEqual({ tipo: 'min', min: 40 });
    expect(lerReferencia('acima de 60')).toEqual({ tipo: 'min', min: 60 });
  });

  it('unidade depois da faixa não estraga a leitura', () => {
    expect(lerReferencia('12,0 - 16,0 g/dL')).toEqual({ tipo: 'faixa', min: 12, max: 16 });
    expect(lerReferencia('0-100 mL/min/1.73m²')).toEqual({ tipo: 'faixa', min: 0, max: 100 });
  });

  it('faixa que depende do sexo do paciente NÃO é adivinhada', () => {
    // Escolher um dos dois pares seria decidir o sexo do paciente a partir de um dado que
    // este link não carrega. A tela mostra o texto original.
    expect(lerReferencia('Homens: 13-17 Mulheres: 12-16')).toBeNull();
  });

  it('número solto não é faixa — não se sabe se é teto, piso ou alvo', () => {
    expect(lerReferencia('16')).toBeNull();
    expect(lerReferencia('Não reagente')).toBeNull();
    expect(lerReferencia('')).toBeNull();
    expect(lerReferencia(null)).toBeNull();
  });

  it('faixa invertida é recusada em vez de normalizada', () => {
    expect(lerReferencia('16-12')).toBeNull();
  });
});

describe('situacao — aritmética contra a faixa, nunca diagnóstico', () => {
  it('compara dentro, acima e abaixo', () => {
    const faixa = lerReferencia('12-16');
    expect(situacao(13.5, faixa)).toBe('dentro');
    expect(situacao(17, faixa)).toBe('acima');
    expect(situacao(11, faixa)).toBe('abaixo');
    expect(situacao(12, faixa)).toBe('dentro'); // borda inclusiva
    expect(situacao(16, faixa)).toBe('dentro');
  });

  it('teto e piso', () => {
    expect(situacao(220, lerReferencia('< 200'))).toBe('acima');
    expect(situacao(180, lerReferencia('< 200'))).toBe('dentro');
    expect(situacao(30, lerReferencia('> 40'))).toBe('abaixo');
  });

  it('sem número ou sem faixa, não há veredicto — e nada é desenhado', () => {
    expect(situacao(null, lerReferencia('12-16'))).toBe('indefinido');
    expect(situacao(13, null)).toBe('indefinido');
  });
});

describe('numeroTexto — o eixo do gráfico em pt-BR, sem Intl', () => {
  it('agrupa milhar com ponto e usa vírgula no decimal', () => {
    expect(numeroTexto(7200)).toBe('7.200');
    expect(numeroTexto(13.5)).toBe('13,5');
    expect(numeroTexto(1234567)).toBe('1.234.567');
    expect(numeroTexto(-1.5)).toBe('-1,5');
  });

  it('não arredonda uma medida pequena até virar zero', () => {
    // 0,001 exibido como "0,00" diria ao médico que não havia medida.
    expect(numeroTexto(0.001)).toBe('0,001');
  });

  it('respeita as casas pedidas (o eixo do gráfico pede)', () => {
    expect(numeroTexto(13.456, 1)).toBe('13,5');
    expect(numeroTexto(99.6, 0)).toBe('100');
  });
});

// ─── Gravidade e triagem ───────────────────────────────────────────────────────

function alergia(substancia: string, gravidadeBruta: string | null, reacao: string | null = null): Alergia {
  return { substancia, reacao, gravidadeBruta, gravidade: normalizarGravidade(gravidadeBruta) };
}

describe('normalizarGravidade — texto livre do paciente vira grau', () => {
  it('anafilaxia é grave mesmo sem a palavra "grave"', () => {
    expect(normalizarGravidade('anafilaxia')).toBe('grave');
    expect(normalizarGravidade('choque anafilático')).toBe('grave');
    expect(normalizarGravidade('risco de vida')).toBe('grave');
  });

  it('reconhece as formas em português e em inglês', () => {
    expect(normalizarGravidade('GRAVE')).toBe('grave');
    expect(normalizarGravidade('severa')).toBe('grave');
    expect(normalizarGravidade('moderada')).toBe('moderada');
    expect(normalizarGravidade('média')).toBe('moderada');
    expect(normalizarGravidade('leve')).toBe('leve');
    expect(normalizarGravidade('mild')).toBe('leve');
  });

  it('vazio e desconhecido não viram "leve" por otimismo', () => {
    expect(normalizarGravidade(null)).toBe('desconhecida');
    expect(normalizarGravidade('')).toBe('desconhecida');
    expect(normalizarGravidade('coceira na pele')).toBe('desconhecida');
  });
});

describe('gravidadeDe — a REAÇÃO também classifica, porque `severity` chega nulo com folga', () => {
  it('anafilaxia escrita na reação é grave mesmo com o campo `gravidade` vazio', () => {
    // As duas vias de escrita deixam `severity` nulo o tempo todo: o `tool-executor` extrai
    // `pick(['severity','reaction'])` — o modelo pode mandar só a reação — e o
    // `profile-enricher` grava `severity: a.severity ?? null` sem escrever reação nenhuma.
    expect(gravidadeDe(null, 'choque anafilático')).toBe('grave');
    expect(gravidadeDe(null, 'anafilaxia')).toBe('grave');
    expect(gravidadeDe('', 'risco de vida')).toBe('grave');
  });

  it('a reação só SOBE a gravidade — "coceira leve" não rebaixa "não confirmada"', () => {
    // Rebaixar desmontaria `PESO_GRAVIDADE`, em que `desconhecida` pesa MAIS que `leve`:
    // gravidade que ninguém confirmou não é boa notícia só porque a reação soa branda.
    expect(gravidadeDe(null, 'coceira leve')).toBe('desconhecida');
    expect(gravidadeDe('grave', 'coceira leve')).toBe('grave');
    expect(gravidadeDe('moderada', 'urticária')).toBe('moderada');
  });
});

describe('ordenarAlergias — o que pode matar vem primeiro', () => {
  it('grave, moderada, DESCONHECIDA, leve', () => {
    const ordem = ordenarAlergias([
      alergia('Camarão', 'leve'),
      alergia('Amendoim', null),
      alergia('Penicilina', 'moderada'),
      alergia('Dipirona', 'anafilaxia'),
    ]).map((a) => a.substancia);
    // Desconhecida ANTES de leve: gravidade não confirmada pode ser anafilática, e
    // empurrá-la para o fim seria tratar ausência de informação como boa notícia.
    expect(ordem).toEqual(['Dipirona', 'Penicilina', 'Amendoim', 'Camarão']);
  });
});

describe('triagem — a faixa que o médico lê antes de rolar', () => {
  const base: ResumoMedico = {
    versao: 2,
    geradoEm: new Date(AGORA).toISOString(),
    paciente: { nome: 'Fulana', idade: 58 },
    alergias: [],
    medicamentos: [],
    condicoes: [],
    exames: [],
    adesao30d: null,
  };

  it('alergia grave é crítica e o nome sobe para a faixa', () => {
    const t = triagem({ ...base, alergias: [alergia('Dipirona', 'anafilaxia', 'edema de glote')] });
    expect(t.nivel).toBe('critico');
    expect(t.criticas.map((a) => a.substancia)).toEqual(['Dipirona']);
  });

  it('alergia sem gravidade confirmada é ATENÇÃO, não neutro', () => {
    const t = triagem({ ...base, alergias: [alergia('Camarão', null)] });
    expect(t.nivel).toBe('atencao');
    expect(t.detalhe).toContain('não confirmada');
  });

  it('anafilaxia escrita na REAÇÃO acende a faixa vermelha, não a âmbar', () => {
    // O paciente disse "sou alérgico a dipirona, tive choque anafilático". O que chega ao
    // banco é `{substance:'Dipirona', reaction:'choque anafilático', severity:null}`. Lendo
    // só o campo `gravidade`, a página classificava como `desconhecida` e mostrava faixa
    // ÂMBAR com "1 alergia registrada · Gravidade não confirmada" — com a palavra que muda
    // a conduta em cinza, dentro do chip.
    const r = lerResumo({
      gerado_em: new Date(AGORA).toISOString(),
      alergias: [{ substancia: 'Dipirona', reacao: 'choque anafilático', gravidade: null }],
    })!;
    expect(r.alergias[0]!.gravidade).toBe('grave');
    const t = triagem(r);
    expect(t.nivel).toBe('critico');
    expect(t.criticas.map((a) => a.substancia)).toEqual(['Dipirona']);
  });

  it('sem alergia registrada, a faixa diz que isso NÃO é negativa de alergia', () => {
    // O mal-entendido capaz de causar dano nesta página: "nenhuma alergia registrada" lido
    // como "o paciente nega alergias". A primeira é ausência de dado; a segunda é anamnese.
    const t = triagem(base);
    expect(t.nivel).toBe('neutro');
    expect(t.detalhe).toContain('não é negativa de alergia');
    expect(t.criticas).toHaveLength(0);
  });
});

describe('frescor — o retrato é congelado, e o médico precisa saber quando', () => {
  it('conta os dias e avisa a partir do terceiro', () => {
    const d = (n: number) => new Date(AGORA - n * 86_400_000).toISOString();
    expect(frescor(d(0), AGORA)).toMatchObject({ dias: 0, avisar: false });
    expect(frescor(d(1), AGORA)).toMatchObject({ dias: 1, texto: 'montado ontem', avisar: false });
    expect(frescor(d(2), AGORA)).toMatchObject({ dias: 2, avisar: false });
    expect(frescor(d(6), AGORA)).toMatchObject({ dias: 6, avisar: true });
  });

  it('data ilegível avisa em vez de fingir que é de hoje', () => {
    // A flag sozinha não bastava: `dias: 0` fazia a tela imprimir "Este retrato tem 0 dias"
    // logo abaixo de um cabeçalho dizendo "data de geração não registrada" — as duas frases
    // se contradizendo, e a de baixo sendo exatamente o "fingir que é de hoje" que este
    // aviso existe para impedir. Desconhecido precisa ser um valor que o consumidor NÃO
    // consegue imprimir como se fosse medida.
    for (const ruim of ['', 'nao é data', '2026-13-45']) {
      const f = frescor(ruim, AGORA);
      expect(f.avisar).toBe(true);
      expect(f.dias).toBeNull();
      expect(f.texto).toBe('data de geração não registrada');
    }
    // Data legível continua devolvendo número — `null` é só para "não sei".
    expect(frescor(new Date(AGORA).toISOString(), AGORA).dias).toBe(0);
  });
});

describe('adesaoPercentual — arredondamento nunca a favor do tratamento', () => {
  it('trunca para baixo: 99,5% não pode virar 100%', () => {
    // "100%" diria que nenhuma dose falhou num mês em que alguma falhou.
    expect(adesaoPercentual(0.995)).toBe(99);
    expect(adesaoPercentual(0.78)).toBe(78);
    expect(adesaoPercentual(1)).toBe(100);
    expect(adesaoPercentual(0)).toBe(0);
    expect(adesaoPercentual(null)).toBeNull();
  });
});

// ─── lerResumo: o leitor tolerante ────────────────────────────────────────────

describe('lerResumo — link antigo continua abrindo', () => {
  it('resumo v1 (sem versao e sem valores) é lido sem lançar', () => {
    // Este é o formato que está gravado em `summary_cache` de links criados antes do v2 —
    // e eles continuam vivos por até 7 dias depois de qualquer deploy.
    const v1 = {
      gerado_em: '2026-08-16T12:00:00.000Z',
      paciente: { nome: 'Fulana', idade: 58 },
      alergias: [{ substancia: 'Dipirona', reacao: null, gravidade: 'grave' }],
      medicamentos: [{ nome: 'Losartana', dosagem: '50mg', frequencia: '1x ao dia' }],
      condicoes: [{ nome: 'Hipertensão', desde: '2019-04-01' }],
      exames: [{ tipo: 'Hemograma', data: '2026-08-01', resumo: 'sem observações' }],
      adesao_30d: 0.78,
    };
    const r = lerResumo(v1)!;
    expect(r.versao).toBe(1);
    expect(r.exames[0]!.valores).toEqual([]);
    expect(r.exames[0]!.valoresOmitidos).toBe(0);
    expect(r.alergias[0]!.gravidade).toBe('grave');
  });

  it('campo que falta vira lista vazia, não exceção', () => {
    const r = lerResumo({ gerado_em: '2026-08-18T12:00:00Z' })!;
    expect(r).not.toBeNull();
    expect(r.alergias).toEqual([]);
    expect(r.medicamentos).toEqual([]);
    expect(r.exames).toEqual([]);
    expect(r.adesao30d).toBeNull();
    expect(r.paciente.nome).toBeNull();
  });

  it('o que não é um resumo devolve null — e a tela avisa em vez de mostrar vazio', () => {
    expect(lerResumo(null)).toBeNull();
    expect(lerResumo('texto')).toBeNull();
    expect(lerResumo([])).toBeNull();
    expect(lerResumo(42)).toBeNull();
  });

  it('linha sem substância / sem nome é descartada, não vira linha em branco', () => {
    const r = lerResumo({
      alergias: [{ substancia: '  ', gravidade: 'grave' }, { substancia: 'Dipirona' }],
      medicamentos: [{ dosagem: '50mg' }, { nome: 'Losartana' }],
      exames: [{ data: '2026-08-01' }, { tipo: 'Hemograma' }],
    })!;
    expect(r.alergias.map((a) => a.substancia)).toEqual(['Dipirona']);
    expect(r.medicamentos.map((m) => m.nome)).toEqual(['Losartana']);
    expect(r.exames.map((e) => e.tipo)).toEqual(['Hemograma']);
  });

  it('marcador sem valor não vira linha de tabela', () => {
    const r = lerResumo({
      exames: [{ tipo: 'Hemograma', valores: [{ marcador: 'Hemoglobina' }, { valor: '13,5' }, { marcador: 'Glicose', valor: '98' }] }],
    })!;
    expect(r.exames[0]!.valores).toEqual([{ marcador: 'Glicose', valor: '98', unidade: null, referencia: null }]);
  });

  it('adesão fora de 0..1 é recusada em vez de virar 4.500%', () => {
    expect(lerResumo({ adesao_30d: 78 })!.adesao30d).toBeNull();
    expect(lerResumo({ adesao_30d: -1 })!.adesao30d).toBeNull();
    expect(lerResumo({ adesao_30d: 0.78 })!.adesao30d).toBe(0.78);
  });

  it('campo que o formato não tem mais é ignorado, não vira tela quebrada', () => {
    // Links v2 congelados antes desta versão trazem `documentos` no `summary_cache` e
    // vivem até 7 dias. O leitor ignora o que não conhece — e a página deixa de ter uma
    // seção que afirmava "nenhum documento anexado" sem nunca ter recebido nenhum.
    const r = lerResumo({
      gerado_em: '2026-08-18T12:00:00Z',
      exames: [{ tipo: 'Hemograma' }],
      documentos: [{ titulo: 'laudo.pdf', tipo: 'pdf', url: 'javascript:alert(1)' }],
    })!;
    expect(r.exames.map((e) => e.tipo)).toEqual(['Hemograma']);
    expect(Object.keys(r)).not.toContain('documentos');
    // O href era a superfície de XSS desta página pública: nenhuma URL vinda do congelado
    // chega a virar atributo agora que não há cartão de documento para renderizar.
    expect(JSON.stringify(r)).not.toContain('javascript:');
  });
});

// ─── Séries e geometria ────────────────────────────────────────────────────────

const EXAMES = [
  {
    tipo: 'Hemograma',
    data: '2026-03-01',
    resumo: null,
    valoresOmitidos: 0,
    valores: [
      { marcador: 'Hemoglobina', valor: '12,1', unidade: 'g/dL', referencia: '12-16' },
      { marcador: 'Glicose', valor: '105', unidade: 'mg/dL', referencia: '70-99' },
    ],
  },
  {
    tipo: 'Hemograma',
    data: '2026-08-01',
    resumo: null,
    valoresOmitidos: 0,
    valores: [
      { marcador: 'hemoglobina', valor: '13,5', unidade: 'g/dL', referencia: '12-16' },
      { marcador: 'Glicose', valor: '118', unidade: 'mg/dL', referencia: '70-99' },
      { marcador: 'Ferritina', valor: '40', unidade: 'ng/mL', referencia: '20-250' },
    ],
  },
];

describe('seriesDosExames — o que vira traço', () => {
  it('agrupa a mesma grafia diferente do mesmo marcador', () => {
    const { series } = seriesDosExames(EXAMES);
    const hb = series.find((s) => s.chave === 'hemoglobina')!;
    expect(hb.pontos.map((p) => p.valor)).toEqual([12.1, 13.5]);
    // A grafia mostrada é a do exame mais RECENTE.
    expect(hb.marcador).toBe('hemoglobina');
    expect(hb.unidade).toBe('g/dL');
  });

  it('marcador com um único ponto não é série — a tabela já o mostra melhor', () => {
    const { series } = seriesDosExames(EXAMES);
    expect(series.map((s) => s.chave)).not.toContain('ferritina');
  });

  it('o que está fora da faixa vem primeiro', () => {
    // Glicose 105 e 118 estouram 70-99; hemoglobina fica dentro de 12-16.
    const { series } = seriesDosExames(EXAMES);
    expect(series[0]!.chave).toBe('glicose');
    expect(series[0]!.foraDaFaixa).toBe(2);
    expect(series[1]!.foraDaFaixa).toBe(0);
  });

  it('exame SEM data não entra na série — chutar a ordem inverteria a tendência', () => {
    const semData = [{ ...EXAMES[0]!, data: null }, EXAMES[1]!];
    const { series } = seriesDosExames(semData);
    expect(series).toHaveLength(0);
  });

  it('valor censurado ou composto fica fora do traço', () => {
    const comCensurado = [
      { ...EXAMES[0]!, valores: [{ marcador: 'PCR', valor: '<0,01', unidade: 'mg/L', referencia: '< 5' }] },
      { ...EXAMES[1]!, valores: [{ marcador: 'PCR', valor: '2,3', unidade: 'mg/L', referencia: '< 5' }] },
    ];
    const { series } = seriesDosExames(comCensurado);
    expect(series).toHaveLength(0); // sobrou 1 ponto plotável, e 1 não é série
  });

  it('banda só quando TODOS os laudos trouxeram a MESMA faixa', () => {
    const faixasDiferentes = [
      { ...EXAMES[0]!, valores: [{ marcador: 'TGO', valor: '30', unidade: 'U/L', referencia: '10-40' }] },
      { ...EXAMES[1]!, valores: [{ marcador: 'TGO', valor: '35', unidade: 'U/L', referencia: '5-34' }] },
    ];
    const { series } = seriesDosExames(faixasDiferentes);
    // Laboratórios discordam: uma banda só valeria para metade dos pontos.
    expect(series[0]!.referencia).toBeNull();
    // Mas o texto original continua na tela, e cada ponto foi comparado com a SUA faixa.
    expect(series[0]!.referenciaTexto).toBe('5-34');
    expect(series[0]!.foraDaFaixa).toBe(1);
  });

  it('UNIDADES diferentes não viram traço — 7.200/mm³ e 7,2 mil/mm³ não são uma queda', () => {
    // Caso brasileiro corriqueiro: o laboratório A reporta leucócitos por mm³ e o B em
    // milhares. Os dois valores parseiam, e o gráfico desenhava um despencar de 7200 para
    // 7,2 com "↓ 7.192,8" no cabeçalho — inclinação da unidade, não do paciente. A banda de
    // referência já tinha essa guarda; a unidade não tinha.
    const unidadesBrigando = [
      { ...EXAMES[0]!, valores: [{ marcador: 'Leucócitos', valor: '7.200', unidade: '/mm³', referencia: null }] },
      { ...EXAMES[1]!, valores: [{ marcador: 'Leucócitos', valor: '7,2', unidade: 'mil/mm³', referencia: null }] },
    ];
    const { series, total } = seriesDosExames(unidadesBrigando);
    expect(series).toHaveLength(0);
    // E não conta como "1 de N marcadores cortados": não foi corte de espaço, foi recusa a
    // comparar. Os dois valores continuam na tabela do exame, cada um com a SUA unidade.
    expect(total).toBe(0);
  });

  it('a mesma unidade escrita diferente (mm³ vs mm3, µL vs uL) continua sendo uma série', () => {
    // A guarda é sobre GRANDEZA, não sobre tipografia — senão ela apagaria gráficos bons.
    const mesmaGrandeza = [
      { ...EXAMES[0]!, valores: [{ marcador: 'Plaquetas', valor: '210', unidade: 'mil/mm³', referencia: null }] },
      { ...EXAMES[1]!, valores: [{ marcador: 'Plaquetas', valor: '235', unidade: 'mil/mm3', referencia: null }] },
    ];
    expect(seriesDosExames(mesmaGrandeza).series).toHaveLength(1);

    const micro = [
      { ...EXAMES[0]!, valores: [{ marcador: 'Hemácias', valor: '4,5', unidade: 'milhões/µL', referencia: null }] },
      { ...EXAMES[1]!, valores: [{ marcador: 'Hemácias', valor: '4,7', unidade: 'milhões/uL', referencia: null }] },
    ];
    expect(seriesDosExames(micro).series).toHaveLength(1);
  });

  it('laudo sem unidade não conta como unidade DIFERENTE', () => {
    // Ausência de unidade é ausência de dado, não uma segunda grandeza. Tratá-la como
    // conflito apagaria a série de todo laudo em que o parser não achou a unidade.
    const umSemUnidade = [
      { ...EXAMES[0]!, valores: [{ marcador: 'TSH', valor: '2,1', unidade: null, referencia: null }] },
      { ...EXAMES[1]!, valores: [{ marcador: 'TSH', valor: '3,4', unidade: 'µUI/mL', referencia: null }] },
    ];
    const { series } = seriesDosExames(umSemUnidade);
    expect(series).toHaveLength(1);
    expect(series[0]!.unidade).toBe('µUI/mL');
  });

  it('o corte conta quantas séries existem, para a tela dizer o número', () => {
    const muitos = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((m) => ({ marcador: m, valor: '10', unidade: null, referencia: null }));
    const exames = [
      { tipo: 'X', data: '2026-01-01', resumo: null, valoresOmitidos: 0, valores: muitos },
      { tipo: 'X', data: '2026-02-01', resumo: null, valoresOmitidos: 0, valores: muitos },
    ];
    const { series, total } = seriesDosExames(exames, 3);
    expect(series).toHaveLength(3);
    expect(total).toBe(8);
  });

  it('ordena os pontos no tempo mesmo com os exames fora de ordem', () => {
    const { series } = seriesDosExames([EXAMES[1]!, EXAMES[0]!]);
    const hb = series.find((s) => s.chave === 'hemoglobina')!;
    expect(hb.pontos.map((p) => p.data)).toEqual(['2026-03-01', '2026-08-01']);
  });
});

describe('a caixa do gráfico é dimensionada pelo TEXTO', () => {
  /**
   * O `viewBox` de 320 é escalado pela largura do cartão. No pior aparelho realista — um
   * Android de 360px — sobram 296px (360 − 32 do `px-4` da página − 32 do `p-4` da figure).
   */
  const ESCALA_PIOR_TELEFONE = 296 / CAIXA_PADRAO.largura;

  it('o rótulo do eixo não afunda abaixo do piso legível no telefone mais estreito', () => {
    // Rótulo do eixo y é valor de laudo; o do eixo x é DATA DE EXAME. Os dois são dado
    // clínico, e nenhum texto de interface pode ficar abaixo de 12px reais. Com `10` — o
    // valor com que este gráfico nasceu — dava 9,25px na mão de um médico de 45–60 anos.
    expect(FONTE_EIXO * ESCALA_PIOR_TELEFONE).toBeGreaterThanOrEqual(12);
  });

  it('a folga da caixa acompanha o tamanho do texto, senão a data sobe no traço', () => {
    // `base` guarda a linha das datas embaixo do gráfico, e `esq` guarda o rótulo do eixo
    // y (com 6 de respiro até a grade). Aumentar a fonte sem abrir a caixa junto foi o
    // que fez a régua e o desenho brigarem.
    expect(CAIXA_PADRAO.pad.base).toBeGreaterThanOrEqual(FONTE_EIXO * 2);
    // Espaço para ~7 caracteres de eixo (`1.234,5`) na largura média de dígito.
    expect(CAIXA_PADRAO.pad.esq - 6).toBeGreaterThanOrEqual(FONTE_EIXO * 3.6);
  });
});

describe('geometria — coordenadas dentro da caixa, sem biblioteca', () => {
  const serie = seriesDosExames(EXAMES).series.find((s) => s.chave === 'hemoglobina')!;

  it('todo ponto cai dentro da área útil', () => {
    const g = geometria(serie, CAIXA_PADRAO);
    const { largura, altura, pad } = CAIXA_PADRAO;
    for (const p of g.pontos) {
      expect(p.x).toBeGreaterThanOrEqual(pad.esq);
      expect(p.x).toBeLessThanOrEqual(largura - pad.dir);
      expect(p.y).toBeGreaterThanOrEqual(pad.topo);
      expect(p.y).toBeLessThanOrEqual(altura - pad.base);
    }
  });

  it('o eixo x é o TEMPO, não a posição na lista', () => {
    // Dois pontos separados por 5 meses e um terceiro no dia seguinte ao segundo: o
    // espaçamento tem que mostrar o buraco, senão a inclinação mente.
    const tres = [
      ...EXAMES,
      { tipo: 'Hemograma', data: '2026-08-02', resumo: null, valoresOmitidos: 0, valores: [{ marcador: 'Hemoglobina', valor: '13,6', unidade: 'g/dL', referencia: '12-16' }] },
    ];
    const s = seriesDosExames(tres).series.find((x) => x.chave === 'hemoglobina')!;
    const g = geometria(s, CAIXA_PADRAO);
    const d1 = g.pontos[1]!.x - g.pontos[0]!.x;
    const d2 = g.pontos[2]!.x - g.pontos[1]!.x;
    expect(d1).toBeGreaterThan(d2 * 10);
  });

  it('valor maior desenha mais ALTO (y menor)', () => {
    const g = geometria(serie, CAIXA_PADRAO);
    expect(g.pontos[1]!.p.valor).toBeGreaterThan(g.pontos[0]!.p.valor);
    expect(g.pontos[1]!.y).toBeLessThan(g.pontos[0]!.y);
  });

  it('a banda de referência cabe na tela', () => {
    const g = geometria(serie, CAIXA_PADRAO);
    expect(g.faixa).not.toBeNull();
    expect(g.faixa!.y).toBeGreaterThanOrEqual(CAIXA_PADRAO.pad.topo - 0.01);
    expect(g.faixa!.y + g.faixa!.altura).toBeLessThanOrEqual(CAIXA_PADRAO.altura - CAIXA_PADRAO.pad.base + 0.01);
  });

  it('valores todos iguais não colapsam a linha na borda', () => {
    const iguais = [
      { tipo: 'X', data: '2026-01-01', resumo: null, valoresOmitidos: 0, valores: [{ marcador: 'K', valor: '4', unidade: null, referencia: null }] },
      { tipo: 'X', data: '2026-02-01', resumo: null, valoresOmitidos: 0, valores: [{ marcador: 'K', valor: '4', unidade: null, referencia: null }] },
    ];
    const g = geometria(seriesDosExames(iguais).series[0]!, CAIXA_PADRAO);
    expect(g.dominio.min).toBeLessThan(4);
    expect(g.dominio.max).toBeGreaterThan(4);
    for (const p of g.pontos) expect(Number.isFinite(p.y)).toBe(true);
  });

  it('a polilinha não sai NaN (o bug que apaga o gráfico sem erro no console)', () => {
    const g = geometria(serie, CAIXA_PADRAO);
    expect(g.linha).not.toContain('NaN');
    expect(g.area).not.toContain('NaN');
  });
});

describe('tendencia e descricaoSerie', () => {
  const serie = seriesDosExames(EXAMES).series.find((s) => s.chave === 'hemoglobina')!;

  it('do primeiro ao último ponto', () => {
    const t = tendencia(serie)!;
    expect(t.direcao).toBe('subiu');
    expect(t.delta).toBeCloseTo(1.4, 5);
  });

  it('variação minúscula é ruído de leitura, não movimento', () => {
    const quase = [
      { tipo: 'X', data: '2026-01-01', resumo: null, valoresOmitidos: 0, valores: [{ marcador: 'K', valor: '100', unidade: null, referencia: null }] },
      { tipo: 'X', data: '2026-02-01', resumo: null, valoresOmitidos: 0, valores: [{ marcador: 'K', valor: '100,2', unidade: null, referencia: null }] },
    ];
    expect(tendencia(seriesDosExames(quase).series[0]!)!.direcao).toBe('estavel');
  });

  it('a série existe em PALAVRAS — sem isso o gráfico é um retângulo vazio no leitor de tela', () => {
    const d = descricaoSerie(serie);
    expect(d).toContain('12,1 em 01/03/2026');
    expect(d).toContain('13,5 em 01/08/2026');
    expect(d).toContain('g/dL');
    expect(d).toContain('12-16');
  });
});

// ─── O texto para colar no prontuário ─────────────────────────────────────────

describe('resumoTexto — o que o médico cola no sistema dele', () => {
  const r: ResumoMedico = {
    versao: 2,
    geradoEm: new Date(AGORA - 2 * 86_400_000).toISOString(),
    paciente: { nome: 'Fulana', idade: 58 },
    alergias: [alergia('Dipirona', 'anafilaxia', 'edema de glote'), alergia('Camarão', null, 'coceira')],
    medicamentos: [{ nome: 'Losartana', dosagem: '50mg', frequencia: '1x ao dia' }],
    condicoes: [{ nome: 'Hipertensão', desde: '2019-04-01' }],
    exames: [
      {
        tipo: 'Hemograma',
        data: '2026-08-01',
        resumo: 'sem observações',
        valoresOmitidos: 2,
        valores: [{ marcador: 'Hemoglobina', valor: '13,5', unidade: 'g/dL', referencia: '12-16' }],
      },
    ],
    adesao30d: 0.78,
  };

  it('traz o quadro inteiro, na ordem da tela', () => {
    const t = resumoTexto(r, AGORA);
    expect(t.indexOf('ALERGIAS')).toBeLessThan(t.indexOf('MEDICAMENTOS EM USO'));
    expect(t).toContain('Dipirona — edema de glote · anafilaxia');
    expect(t).toContain('Losartana — 50mg · 1x ao dia');
    expect(t).toContain('Hipertensão (desde 01/04/2019)'); // a data não volta um dia
    expect(t).toContain('Hemoglobina: 13,5 g/dL (ref. 12-16)');
    expect(t).toContain('+2 marcadores não incluídos');
    expect(t).toContain('78%');
    expect(t).toContain('NÃO é laudo nem diagnóstico');
  });

  it('NÃO leva telefone, CPF nem data de nascimento — só idade', () => {
    const t = resumoTexto(r, AGORA);
    expect(t).toContain('58 anos');
    // O texto copiado circula por e-mail e por sistema de terceiro: carrega tão pouco
    // quanto a página.
    expect(t).not.toMatch(/\d{3}\.\d{3}\.\d{3}-\d{2}/); // CPF
    expect(t).not.toMatch(/\+?55\s?\d{2}\s?9?\d{4}/); // telefone
  });

  it('seção vazia continua no texto, com a ressalva', () => {
    const vazio = resumoTexto({ ...r, alergias: [], condicoes: [] }, AGORA);
    expect(vazio).toContain('Nenhuma alergia registrada');
    expect(vazio).toContain('não é negativa de alergia');
    expect(vazio).toContain('Nenhuma condição registrada');
  });

  it('o contador de EXAMES conta exames, não as linhas que eles ocupam', () => {
    // Toda outra seção conta entidades — `ALERGIAS (2)` são duas alergias. Em EXAMES um
    // único exame rende a linha do exame, uma por marcador, uma pelos omitidos e uma pela
    // observação: contar linhas imprimiria `EXAMES (6)` para UM exame. E este é o único
    // texto do produto que o médico cola no prontuário eletrônico dele, onde o número
    // vira registro permanente em sistema de terceiro.
    const t = resumoTexto(
      {
        ...r,
        exames: [
          {
            tipo: 'Hemograma',
            data: '2026-08-01',
            resumo: 'sem observações',
            valoresOmitidos: 2,
            valores: [
              { marcador: 'Hemoglobina', valor: '13,5', unidade: 'g/dL', referencia: '12-16' },
              { marcador: 'Glicose', valor: '98', unidade: 'mg/dL', referencia: null },
              { marcador: 'Ureia', valor: '32', unidade: 'mg/dL', referencia: null },
            ],
          },
        ],
      },
      AGORA,
    );
    expect(t).toContain('EXAMES (1)');
    expect(t).toContain('ALERGIAS (2)');
    expect(t).toContain('MEDICAMENTOS EM USO (1)');
    // As 6 linhas continuam lá — o que mudou é só o número do cabeçalho.
    expect(t).toContain('Hemoglobina: 13,5 g/dL (ref. 12-16)');
    expect(t).toContain('Ureia: 32 mg/dL');
    expect(t).toContain('+2 marcadores não incluídos');
  });

  it('dois exames contam dois, e nenhum exame não ganha contador', () => {
    const dois = resumoTexto({ ...r, exames: [r.exames[0]!, { ...r.exames[0]!, tipo: 'Glicemia' }] }, AGORA);
    expect(dois).toContain('EXAMES (2)');

    const nenhum = resumoTexto({ ...r, exames: [] }, AGORA);
    expect(nenhum).toContain('EXAMES\n  Nenhum exame registrado.');
  });
});

// ─── A régua do tamanho, com vigilante ─────────────────────────────────────────

/**
 * `FONTE_EIXO` já é travado por teste porque é um piso medido. As classes de tamanho da
 * página não eram — e foi exatamente aí que a régua escorregou: data de exame, unidade,
 * faixa do laudo, delta da tendência e a REAÇÃO da alergia grave ficaram em 12px, enquanto
 * o construtor comentava na linha do medicamento que "o detalhe é 14px, e não 12: dose e
 * frequência são o dado que muda a prescrição". O mesmo critério, aplicado em um lugar só.
 *
 * A régua: dado clínico ≥ 13px. 11–12px só para o que o médico não precisa ler — rótulo de
 * estrutura (cabeçalho de coluna), kicker da marca e assinatura de rodapé. O vigilante
 * reconhece esses três pelo que eles SÃO, não por linha nem por contagem: qualquer 12px
 * novo fora deles falha aqui, com o arquivo, a linha e o texto.
 */
describe('a régua de tamanho da página do médico', () => {
  const ESTRUTURAL = [
    /uppercase/, // cabeçalho de coluna da tabela de exames ("Marcador" / "Resultado")
    /text-white\/60/, // kicker "resumo clínico" no timbre
    /text-\[#8a90a8\]/, // assinatura do rodapé ("formato v2")
  ];

  it('nada abaixo de 12px, e nenhum 12px sobre dado clínico', () => {
    const dir = fileURLToPath(new URL('../apps/web/app/s/[token]/', import.meta.url));
    const infratores: string[] = [];

    for (const arquivo of readdirSync(dir).filter((f) => f.endsWith('.tsx'))) {
      readFileSync(`${dir}${arquivo}`, 'utf8')
        .split('\n')
        .forEach((linha, i) => {
          const tamanhos = linha.match(/text-\[(\d+)px\]/g) ?? [];
          for (const t of tamanhos) {
            const px = Number(/(\d+)/.exec(t)![1]);
            if (px >= 13) continue;
            // Piso absoluto: abaixo de 12 não existe, nem para metadado.
            if (px < 12 || !ESTRUTURAL.some((p) => p.test(linha))) {
              infratores.push(`${arquivo}:${i + 1} ${t} → ${linha.trim().slice(0, 90)}`);
            }
          }
        });
    }

    expect(infratores).toEqual([]);
  });
});
