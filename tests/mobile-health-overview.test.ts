import { describe, it, expect } from 'vitest';
import {
  agruparExamesPorMes,
  agruparMemoria,
  detalheDoMedicamento,
  ordenarAlergias,
  paresDoExame,
  resumoAdesao,
  tarjaDoMedicamento,
  tomDaSeveridade,
  type Allergy,
  type ExamResult,
  type MemoryCard,
} from '../apps/mobile/src/features/health/overview.js';
import { brMesAno } from '../apps/mobile/src/lib/br-format.js';

/**
 * As derivações do prontuário.
 *
 * Cada teste aqui corresponde a uma forma de a tela MENTIR sobre um dado clínico:
 * inventar adesão onde não houve registro, esconder uma alergia grave no fim da lista,
 * sumir com um exame por causa de um campo torto, ou omitir que uma memória foi
 * deduzida por nós e não dita pelo paciente. Nenhuma delas é hipotética — todas
 * dependem de decisões que este arquivo trava.
 */

const T = Date.parse('2026-08-05T14:30:00.000Z'); // 11:30 BRT

describe('resumoAdesao', () => {
  it('dia sem dose fica null, NUNCA zero', () => {
    const r = resumoAdesao([{ id: '1', status: 'taken', scheduled_at: '2026-08-05T11:00:00.000Z' }], 3, T);

    expect(r.serie).toHaveLength(3);
    // Só o dia 05 teve registro; os dois anteriores são ausência de dado, não falha.
    expect(r.serie.map((d) => d.ratio)).toEqual([null, null, 1]);
    expect(r.diasComRegistro).toBe(1);
  });

  it('score vem das doses cruas, não da média das razões diárias', () => {
    // Dia A: 1 de 1 tomada (100%). Dia B: 1 de 4 tomadas (25%).
    // Média das razões daria 62,5%; a definição do banco (taken/total) dá 2/5 = 40%.
    const log = [
      { id: '1', status: 'taken', scheduled_at: '2026-08-04T11:00:00.000Z' },
      { id: '2', status: 'taken', scheduled_at: '2026-08-05T11:00:00.000Z' },
      { id: '3', status: 'skipped', scheduled_at: '2026-08-05T14:00:00.000Z' },
      { id: '4', status: 'snoozed', scheduled_at: '2026-08-05T17:00:00.000Z' },
      { id: '5', status: 'no_response', scheduled_at: '2026-08-05T20:00:00.000Z' },
    ];
    expect(resumoAdesao(log, 30, T).score).toBe(0.4);
  });

  it('sem nenhuma dose registrada, score é null e não 0', () => {
    const r = resumoAdesao([], 30, T);
    expect(r.score).toBeNull();
    expect(r.diasComRegistro).toBe(0);
  });
});

describe('ordenarAlergias', () => {
  it('grave primeiro — e gravidade DESCONHECIDA não é tratada como leve', () => {
    const alergias: Allergy[] = [
      { id: 'leve', substance: 'Poeira', severity: 'leve' },
      { id: 'sem', substance: 'Amendoim', severity: null },
      { id: 'grave', substance: 'Dipirona', severity: 'grave' },
      { id: 'mod', substance: 'Látex', severity: 'moderada' },
    ];
    // Sem gravidade cai ENTRE moderada e leve: tratar desconhecido como brando é a
    // forma silenciosa de esconder risco numa lista que alguém lê às pressas.
    expect(ordenarAlergias(alergias).map((a) => a.id)).toEqual(['grave', 'mod', 'sem', 'leve']);
  });

  it('não muta a lista original', () => {
    const alergias: Allergy[] = [
      { id: 'b', substance: 'B', severity: 'leve' },
      { id: 'a', substance: 'A', severity: 'grave' },
    ];
    ordenarAlergias(alergias);
    expect(alergias.map((a) => a.id)).toEqual(['b', 'a']);
  });

  it('anafilaxia é o topo absoluto', () => {
    expect(tomDaSeveridade('anafilaxia')).toBe('danger');
    expect(tomDaSeveridade('grave')).toBe('danger');
    expect(tomDaSeveridade('moderada')).toBe('warn');
    expect(tomDaSeveridade(null)).toBe('neutral');
  });
});

describe('agruparExamesPorMes', () => {
  it('agrupa por mês, do mais recente pro mais antigo', () => {
    const exames: ExamResult[] = [
      { id: 'jul', exam_type: 'Hemograma', exam_date: '2026-07-10' },
      { id: 'ago2', exam_type: 'Glicemia', exam_date: '2026-08-01' },
      { id: 'ago1', exam_type: 'TSH', exam_date: '2026-08-20' },
    ];
    const g = agruparExamesPorMes(exames, brMesAno);
    expect(g.map((x) => x.rotulo)).toEqual(['ago/2026', 'jul/2026']);
    expect(g[0]!.exames.map((e) => e.id)).toEqual(['ago1', 'ago2']);
  });

  it('exame sem data legível NÃO desaparece — vai pro fim, num grupo próprio', () => {
    const exames: ExamResult[] = [
      { id: 'sem', exam_type: 'Laudo', exam_date: null },
      { id: 'com', exam_type: 'Hemograma', exam_date: '2026-08-01' },
    ];
    const g = agruparExamesPorMes(exames, brMesAno);
    expect(g.map((x) => x.rotulo)).toEqual(['ago/2026', 'sem data']);
    expect(g[1]!.exames.map((e) => e.id)).toEqual(['sem']);
  });

  it('data corrompida cai no grupo sem data em vez de derrubar o agrupamento', () => {
    const g = agruparExamesPorMes([{ id: 'x', exam_type: 'T', exam_date: 'não é data' }], brMesAno);
    expect(g).toHaveLength(1);
    expect(g[0]!.rotulo).toBe('sem data');
  });
});

describe('paresDoExame — JSONB livre não pode sumir com o exame', () => {
  it('objeto simples vira pares', () => {
    expect(paresDoExame({ hemoglobina: '13,2 g/dL', hematocrito: '40%' })).toEqual([
      { rotulo: 'hemoglobina', valor: '13,2 g/dL' },
      { rotulo: 'hematocrito', valor: '40%' },
    ]);
  });

  it('underscore vira espaço no rótulo', () => {
    expect(paresDoExame({ glicemia_de_jejum: '92' })).toEqual([
      { rotulo: 'glicemia de jejum', valor: '92' },
    ]);
  });

  it('lista de {name,value} — o outro formato que o extrator já gravou', () => {
    expect(paresDoExame([{ name: 'TSH', value: 2.1 }, { label: 'T4', result: '1,1' }])).toEqual([
      { rotulo: 'TSH', valor: '2.1' },
      { rotulo: 'T4', valor: '1,1' },
    ]);
  });

  it('texto solto ainda aparece pro paciente', () => {
    expect(paresDoExame('Resultado dentro da normalidade')).toEqual([
      { rotulo: 'Resultado', valor: 'Resultado dentro da normalidade' },
    ]);
  });

  it('valor aninhado não vira [object Object]', () => {
    const r = paresDoExame({ hemoglobina: { value: '13,2', ref: '12-16' } });
    expect(r).toHaveLength(1);
    expect(r[0]!.valor).toContain('13,2');
    expect(r[0]!.valor).not.toContain('[object');
  });

  it('vazio e nulo não geram linha fantasma', () => {
    expect(paresDoExame(null)).toEqual([]);
    expect(paresDoExame(undefined)).toEqual([]);
    expect(paresDoExame('   ')).toEqual([]);
    expect(paresDoExame({ vazio: '', nulo: null })).toEqual([]);
  });
});

/**
 * ## O contrato de NOMES DE COLUNA
 *
 * Esta seção existe por causa de dois bugs reais encontrados rodando o app em 12/08:
 *
 *   1. A tela mostrou 5 medicamentos com dosagem e SEM nome — eu lia `name`, a coluna é
 *      `medication_name` (o web já lia certo desde sempre).
 *   2. A biblioteca de exames ficaria PERMANENTEMENTE vazia com 8 exames no banco — o
 *      backend selecionava `values, notes`, que não existem; são `findings, summary`.
 *
 * Nenhum dos dois é pegável por typecheck: os tipos são declarados à mão sobre JSON de
 * rede e não validam nada em runtime. O que sobra é fixar os nomes num teste. As
 * fixtures abaixo usam EXATAMENTE as colunas de `information_schema` (conferidas em
 * produção em 12/08/2026); se alguém renomear no app, isto quebra.
 */
describe('nomes de coluna que a tela consome', () => {
  it('medicamento vem em medication_name/dosage/form/frequency', () => {
    const m = {
      id: 'm1',
      medication_name: 'Losartana',
      active_ingredient: 'losartana potássica',
      dosage: '50mg',
      form: 'comprimido',
      frequency: '1x ao dia',
      active: true,
      controlled_class: null,
      needs_prescription: false,
    };
    expect(m.medication_name).toBe('Losartana');
    expect(detalheDoMedicamento(m)).toBe('50mg · comprimido · 1x ao dia');
  });

  it('detalhe sem nenhum campo preenchido diz isso, sem " · " solto', () => {
    expect(detalheDoMedicamento({ id: 'm', medication_name: 'X' })).toBe('sem detalhes ainda');
    expect(detalheDoMedicamento({ id: 'm', medication_name: 'X', dosage: '50mg' })).toBe('50mg');
  });

  it('"não especificado" gravado pelo extrator não vira informação na tela', () => {
    // Visto ao vivo: a dipirona aparecia como "500mg · não especificado". A string existe
    // no banco; o que ela quer dizer é ausência, e ausência se comunica calando.
    expect(detalheDoMedicamento({ id: 'm', medication_name: 'Dipirona', dosage: '500mg', form: 'não especificado' })).toBe('500mg');
    expect(detalheDoMedicamento({ id: 'm', medication_name: 'X', dosage: 'n/a', form: '-' })).toBe('sem detalhes ainda');
  });

  it('tarja sai de controlled_class/needs_prescription — não de um "critical" inventado', () => {
    expect(tarjaDoMedicamento({ id: 'm', medication_name: 'X', controlled_class: 'tarja_preta' })).toEqual({
      rotulo: 'tarja preta',
      tom: 'danger',
    });
    expect(tarjaDoMedicamento({ id: 'm', medication_name: 'X', controlled_class: 'tarja_vermelha' })?.tom).toBe('warn');
    expect(tarjaDoMedicamento({ id: 'm', medication_name: 'X', needs_prescription: true })?.rotulo).toBe(
      'precisa de receita',
    );
    // Venda livre não ganha etiqueta: badge em tudo é badge em nada.
    expect(tarjaDoMedicamento({ id: 'm', medication_name: 'X' })).toBeNull();
  });

  it('exame vem em findings/summary/title — não em values/notes', () => {
    const e: ExamResult = {
      id: 'e1',
      exam_type: 'hemograma',
      title: 'Hemograma completo',
      summary: 'Valores dentro da referência.',
      findings: { hemoglobina: '13,2 g/dL' },
      exam_date: '2026-08-01',
      source: 'photo',
      confidence: 0.9,
    };
    // O caminho REAL da tela: findings → pares desenháveis.
    expect(paresDoExame(e.findings)).toEqual([{ rotulo: 'hemoglobina', valor: '13,2 g/dL' }]);
    expect(e.summary).toBeTruthy();
    // E o agrupamento tem que casar o mês certo pra uma coluna DATE.
    expect(agruparExamesPorMes([e], brMesAno)[0]!.rotulo).toBe('ago/2026');
  });
});

describe('agruparMemoria', () => {
  const card = (id: string, kind: string): MemoryCard => ({ id, kind, text: `t${id}` });

  it('respeita a ordem de importância — fatos antes de episódios', () => {
    const g = agruparMemoria([card('1', 'episode'), card('2', 'fact'), card('3', 'preference')]);
    expect(g.map((x) => x.kind)).toEqual(['fact', 'preference', 'episode']);
  });

  it('kind DESCONHECIDO não desaparece da tela', () => {
    // O enricher é a única via que escreve memória e pode passar a gravar um tipo que
    // este app não conhece. Memória invisível é memória inauditável — e a portabilidade
    // LGPD depende de o paciente ver tudo que guardamos dele.
    const g = agruparMemoria([card('1', 'fact'), card('2', 'kind_que_nao_existe_ainda')]);
    expect(g).toHaveLength(2);
    expect(g[1]!.kind).toBe('kind_que_nao_existe_ainda');
    expect(g[1]!.rotulo).toBe('Outras anotações');
  });

  it('grupo vazio não entra', () => {
    const g = agruparMemoria([card('1', 'fact')]);
    expect(g).toHaveLength(1);
  });

  it('lista vazia devolve lista vazia, sem cabeçalhos órfãos', () => {
    expect(agruparMemoria([])).toEqual([]);
  });
});
