import { describe, it, expect } from 'vitest';
import {
  DIAS_ESTOQUE_BAIXO,
  MESES_EXAME_ANTIGO,
  TIPOS_DE_EXAME_NA_FAIXA,
  agruparExamesPorTipo,
  avisosDeEstoque,
  avisosDeExame,
  avisosDoProntuario,
  estoqueDoMedicamento,
  mesesDesde,
} from '../apps/mobile/src/features/health/insights.js';
import { adesaoEmPartes } from '../apps/mobile/src/features/health/overview.js';
import type {
  ExamResult,
  InventoryRow,
  Medication,
} from '../apps/mobile/src/features/health/overview.js';

/**
 * Os avisos do prontuário — o que transforma lista em ação.
 *
 * Cada teste aqui corresponde a uma forma de o aviso MENTIR, e nenhuma é hipotética:
 *
 * · inflar estoque somando caixas que ninguém decrementa (o app diria 40 dias de
 *   Losartana pra quem tem 4);
 * · discordar da Xarlote sobre o mesmo vidro de comprimido, porque a tela usou um
 *   limite diferente do `THRESHOLD_DAYS` do inventory-tracker;
 * · deslocar um exame do dia 1º pro mês anterior, que é o bug de fuso que a coluna
 *   DATE já causou duas vezes neste projeto;
 * · sugerir exame que o paciente nunca fez, que é indicação de exame — ato médico;
 * · dizer "acabou" pra quem tem comprimido na mão, porque `floor()` de meio dia é 0;
 * · chamar o exame de "sangue", que é a CATEGORIA e não o nome do laudo.
 *
 * ## Os fixtures têm a forma da PRODUÇÃO, e isso é parte do teste
 *
 * `exam_type` é a categoria grossa ('sangue' | 'imagem' | 'urina' | 'cardiologico' |
 * 'covid' | 'outro') e `title` é o nome do laudo ("Hemograma completo") — é o que a
 * migration 0014 declara e o que a tool `save_exam_result` instrui o modelo a mandar, com
 * as duas obrigatórias. A primeira versão destes testes escrevia `exam_type: 'Hemograma'`,
 * uma forma que produção nunca produz, e por isso passava verde por cima de um defeito
 * que juntava hemograma, glicemia, colesterol, TSH e creatinina num grupo só.
 */

/** "Agora" fixo: 18/08/2026, 11:30 BRT. */
const NOW = Date.parse('2026-08-18T14:30:00.000Z');

function med(over: Partial<Medication> = {}): Medication {
  return { id: 'm1', medication_name: 'Losartana', daily_consumption: 1, ...over };
}

function caixa(over: Partial<InventoryRow> = {}): InventoryRow {
  return {
    id: 'i1',
    medication_id: 'm1',
    tablets_remaining: 30,
    purchased_at: '2026-08-01T10:00:00.000Z',
    ...over,
  };
}

/** A forma que produção grava: categoria em `exam_type`, nome do laudo em `title`. */
function exame(over: Partial<ExamResult> = {}): ExamResult {
  return {
    id: 'e1',
    exam_type: 'sangue',
    title: 'Hemograma completo',
    exam_date: '2026-08-01',
    ...over,
  };
}

describe('mesesDesde — meses de CALENDÁRIO, no fuso do paciente', () => {
  it('coluna DATE não escorrega pro mês anterior', () => {
    // `Date.parse('2026-08-01')` é meia-noite UTC = 21h de 31/JULHO em Brasília. Sem a
    // correção de `msDe`, um exame do dia 1º conta um mês a mais.
    expect(mesesDesde('2026-08-01', NOW)).toBe(0);
    expect(mesesDesde('2026-02-01', NOW)).toBe(6);
  });

  it('o mês só fecha quando o DIA passa', () => {
    // De 20/jul a 18/ago não é "1 mês": faltam dois dias.
    expect(mesesDesde('2026-07-20', NOW)).toBe(0);
    expect(mesesDesde('2026-07-18', NOW)).toBe(1);
  });

  it('atravessa o ano sem contar errado', () => {
    expect(mesesDesde('2025-08-18', NOW)).toBe(12);
    expect(mesesDesde('2025-12-18', NOW)).toBe(8);
  });

  it('data inválida é null, e data no futuro é 0 — nunca negativo', () => {
    expect(mesesDesde(null, NOW)).toBeNull();
    expect(mesesDesde('não é data', NOW)).toBeNull();
    expect(mesesDesde('2027-01-01', NOW)).toBe(0);
  });
});

describe('estoqueDoMedicamento', () => {
  it('conta pela caixa MAIS RECENTE com sobra, não pela soma das caixas', () => {
    // Duas caixas: uma velha esquecida com 90 e a atual com 4. O decremento por dose
    // confirmada só mexe na atual — somar diria 94 dias de tranquilidade a quem tem 4.
    const e = estoqueDoMedicamento(med(), [
      caixa({ id: 'velha', tablets_remaining: 90, purchased_at: '2026-01-01T10:00:00.000Z' }),
      caixa({ id: 'atual', tablets_remaining: 4, purchased_at: '2026-08-10T10:00:00.000Z' }),
    ]);
    expect(e).toEqual({ dias: 4, comprimidosRestantes: 4 });
  });

  it('meio comprimido por dia dobra os dias (daily_consumption é DECIMAL)', () => {
    expect(estoqueDoMedicamento(med({ daily_consumption: 0.5 }), [caixa({ tablets_remaining: 10 })]))
      .toEqual({ dias: 20, comprimidosRestantes: 10 });
  });

  it('sem consumo diário não há como saber — devolve null, não zero', () => {
    // Zero dias seria desenhado como "acabou" e mandaria o paciente comprar remédio.
    expect(estoqueDoMedicamento(med({ daily_consumption: null }), [caixa()])).toBeNull();
    expect(estoqueDoMedicamento(med({ daily_consumption: 0 }), [caixa()])).toBeNull();
  });

  it('sem nenhuma caixa registrada é null; caixa zerada é ACABOU', () => {
    expect(estoqueDoMedicamento(med(), [])).toBeNull();
    expect(estoqueDoMedicamento(med(), [caixa({ tablets_remaining: 0 })])).toEqual({
      dias: 0,
      comprimidosRestantes: 0,
    });
  });

  it('ignora caixa de OUTRO medicamento', () => {
    expect(estoqueDoMedicamento(med({ id: 'm1' }), [caixa({ medication_id: 'm2' })])).toBeNull();
  });
});

describe('avisosDeEstoque', () => {
  it('avisa dentro do limite do inventory-tracker e cala fora dele', () => {
    expect(DIAS_ESTOQUE_BAIXO).toBe(7);
    const dentro = avisosDeEstoque([med()], [caixa({ tablets_remaining: 7 })]);
    expect(dentro).toHaveLength(1);
    // 8 comprimidos / 1 por dia = 8 dias: a RPC `medications_running_low` não pegaria,
    // e a tela também não pode — senão ela alarma sobre o que a Xarlote não mencionou.
    expect(avisosDeEstoque([med()], [caixa({ tablets_remaining: 8 })])).toHaveLength(0);
  });

  it('o pedido já vai pronto com nome e dose — o paciente não redige nada', () => {
    const [a] = avisosDeEstoque([med({ dosage: '50mg' })], [caixa({ tablets_remaining: 3 })]);
    expect(a?.titulo).toBe('Losartana 50mg está acabando');
    expect(a?.detalhe).toContain('3 dias');
    expect(a?.acao.tipo).toBe('perguntar');
    if (a?.acao.tipo === 'perguntar') {
      expect(a.acao.mensagem).toBe('Minha Losartana 50mg está acabando. Pode cotar uma caixa pra mim?');
    }
  });

  it('caixa zerada diz que ACABOU, não "sobram 0 dias"', () => {
    const [a] = avisosDeEstoque([med()], [caixa({ tablets_remaining: 0 })]);
    expect(a?.titulo).toBe('Losartana acabou');
    expect(a?.detalhe).not.toContain('0 dia');
  });

  it('sobra que não fecha um dia NÃO é "acabou" — dois comprimidos são dois comprimidos', () => {
    /**
     * Antibiótico de 8/8h com 2 na caixa: `dias` é `floor(2/3)` = 0, e decidir a frase por
     * ele fazia o cartão dizer "Amoxicilina acabou" e, embaixo, "Pelas minhas contas não
     * sobrou nenhum comprimido" — uma afirmação falsa sobre o estoque clínico de alguém
     * com dois comprimidos na mão. A palavra sai do COMPRIMIDO, não do `dias`.
     */
    const [a] = avisosDeEstoque(
      [med({ medication_name: 'Amoxicilina', daily_consumption: 3 })],
      [caixa({ tablets_remaining: 2 })],
    );
    expect(a?.titulo).toBe('Amoxicilina está no fim');
    expect(a?.detalhe).toBe('Sobram 2 comprimidos — menos de um dia, pelas minhas contas.');
    expect(a?.detalhe).not.toContain('nenhum comprimido');
  });

  it('um comprimido só fala no singular', () => {
    const [a] = avisosDeEstoque([med({ daily_consumption: 3 })], [caixa({ tablets_remaining: 1 })]);
    expect(a?.detalhe).toBe('Sobra 1 comprimido — menos de um dia, pelas minhas contas.');
  });

  it('a faixa abre pelo que ACABA PRIMEIRO, não pela ordem do alfabeto', () => {
    /**
     * `TETO_AVISOS` (3, em `saude/index.tsx`) corta o FIM da lista. Em ordem alfabética
     * pura, o polimedicado com quatro remédios em falta tinha a Sinvastatina que ACABOU
     * escondida atrás de "ver os outros N" — porque começa com 'S' — enquanto uma
     * Amoxicilina de 7 dias ocupava a faixa aberta. O dado com prazo vai na frente.
     */
    const avisos = avisosDeEstoque(
      [
        med({ id: 'a', medication_name: 'Amoxicilina' }),
        med({ id: 'l', medication_name: 'Losartana' }),
        med({ id: 'm', medication_name: 'Metformina' }),
        med({ id: 's', medication_name: 'Sinvastatina' }),
      ],
      [
        caixa({ id: 'ia', medication_id: 'a', tablets_remaining: 7 }),
        caixa({ id: 'il', medication_id: 'l', tablets_remaining: 5 }),
        caixa({ id: 'im', medication_id: 'm', tablets_remaining: 2 }),
        caixa({ id: 'is', medication_id: 's', tablets_remaining: 0 }),
      ],
    );
    expect(avisos.map((a) => a.chave)).toEqual([
      'estoque:s',
      'estoque:m',
      'estoque:l',
      'estoque:a',
    ]);
    expect(avisos[0]?.titulo).toBe('Sinvastatina acabou');
  });

  it('empate de prazo desempata no alfabeto — a ordem não dança entre renders', () => {
    const avisos = avisosDeEstoque(
      [med({ id: 'z', medication_name: 'Zolpidem' }), med({ id: 'a', medication_name: 'AAS' })],
      [
        caixa({ id: 'iz', medication_id: 'z', tablets_remaining: 3 }),
        caixa({ id: 'ia', medication_id: 'a', tablets_remaining: 3 }),
      ],
    );
    expect(avisos.map((a) => a.chave)).toEqual(['estoque:a', 'estoque:z']);
  });

  it('medicamento inativo não gera aviso', () => {
    expect(avisosDeEstoque([med({ active: false })], [caixa({ tablets_remaining: 1 })])).toHaveLength(0);
  });

  it('já ter oferecido reposição NÃO esconde o estoque baixo', () => {
    // `reorder_offered_at` serve pro worker não repetir a oferta. A tela é o ESTADO do
    // estoque: esconder um remédio acabando porque já avisamos é dado que existe e não
    // aparece — o defeito que esta sessão está consertando.
    const avisos = avisosDeEstoque(
      [med()],
      [caixa({ tablets_remaining: 2, reorder_offered_at: '2026-08-17T10:00:00.000Z' })],
    );
    expect(avisos).toHaveLength(1);
  });
});

describe('agruparExamesPorTipo', () => {
  it('agrupa pelo NOME ignorando caixa e espaço, e usa a grafia do mais recente', () => {
    const tipos = agruparExamesPorTipo(
      [
        exame({ id: 'a', title: 'hemograma  completo', exam_date: '2026-01-10' }),
        exame({ id: 'b', title: 'Hemograma completo', exam_date: '2026-06-10' }),
        exame({ id: 'c', title: 'TSH', exam_date: '2026-07-10' }),
      ],
      NOW,
    );
    expect(tipos).toHaveLength(2);
    expect(tipos[0]?.rotulo).toBe('TSH');
    const hemo = tipos.find((t) => t.chave === 'hemograma completo');
    expect(hemo?.total).toBe(2);
    expect(hemo?.ultimo.id).toBe('b');
    expect(hemo?.rotulo).toBe('Hemograma completo');
  });

  it('dois exames de SANGUE com nomes diferentes são DOIS grupos', () => {
    /**
     * O defeito que este teste tranca: agrupar por `exam_type` punha hemograma, glicemia,
     * colesterol, TSH e creatinina no mesmo grupo 'sangue'. Quem fez glicemia mês passado
     * e não faz hemograma há dois anos não recebia aviso nenhum — a glicemia recente
     * respondia pelo hemograma antigo —, e o cartão dizia "sangue — faz 8 meses".
     */
    const tipos = agruparExamesPorTipo(
      [
        exame({ id: 'g', exam_type: 'sangue', title: 'Glicemia de jejum', exam_date: '2026-07-10' }),
        exame({ id: 'h', exam_type: 'sangue', title: 'Hemograma completo', exam_date: '2024-08-10' }),
      ],
      NOW,
    );
    expect(tipos).toHaveLength(2);
    expect(tipos.map((t) => t.rotulo)).toEqual(['Glicemia de jejum', 'Hemograma completo']);
    // A categoria fica guardada, mas nunca é o rótulo que vai à tela.
    expect(tipos.every((t) => t.categoria === 'sangue')).toBe(true);
    expect(tipos.map((t) => t.mesesDesdeUltimo)).toEqual([1, 24]);
  });

  it('laudo sem título cai na categoria — o grupo existe, não some', () => {
    // `title` é obrigatório na tool, mas a coluna aceita null (migration 0014) e há linha
    // antiga sem ele. Sem a queda pra `exam_type` o grupo ficaria com rótulo vazio.
    const tipos = agruparExamesPorTipo(
      [exame({ id: 'x', exam_type: 'imagem', title: null })],
      NOW,
    );
    expect(tipos).toHaveLength(1);
    expect(tipos[0]?.rotulo).toBe('imagem');
    expect(tipos[0]?.categoria).toBe('imagem');
  });

  it('NÃO junta "hemograma" com "hemograma completo"', () => {
    // Casar nome de exame por semelhança é decisão clínica, e o erro esconde o mais
    // antigo dos dois: quem fez só o completo pareceria estar em dia com o simples.
    const tipos = agruparExamesPorTipo(
      [exame({ id: 'a', title: 'Hemograma' }), exame({ id: 'b', title: 'Hemograma completo' })],
      NOW,
    );
    expect(tipos).toHaveLength(2);
  });

  it('exame sem data não desaparece — vai pro fim com meses null', () => {
    const tipos = agruparExamesPorTipo(
      [
        exame({ id: 'sem', exam_type: 'imagem', title: 'Raio-X de tórax', exam_date: null }),
        exame({ id: 'com' }),
      ],
      NOW,
    );
    expect(tipos).toHaveLength(2);
    const raio = tipos.find((t) => t.chave === 'raio-x de tórax');
    expect(raio).toBeDefined();
    expect(raio?.mesesDesdeUltimo).toBeNull();
    expect(tipos[tipos.length - 1]?.chave).toBe('raio-x de tórax');
  });
});

describe('avisosDeExame', () => {
  it('avisa só depois do limite, e diz o mês do último', () => {
    expect(MESES_EXAME_ANTIGO).toBe(6);
    expect(avisosDeExame([exame({ exam_date: '2026-04-18' })], NOW)).toHaveLength(0);

    const [a] = avisosDeExame([exame({ exam_date: '2026-01-18' })], NOW);
    // O NOME do laudo, nunca a categoria: "sangue — faz 7 meses" não diz nada a ninguém,
    // e a mensagem que ia pra Xarlote era "Meu último sangue foi de jan/2026".
    expect(a?.titulo).toBe('Hemograma completo — faz 7 meses');
    expect(a?.detalhe).toContain('jan/2026');
    if (a?.acao.tipo === 'perguntar') {
      expect(a.acao.mensagem).toBe('Meu último Hemograma completo foi de jan/2026. Vale repetir?');
    }
  });

  it('a ação é uma PERGUNTA, nunca uma recomendação', () => {
    // A Xarlote não indica exame nem muda conduta. A tela dela também não.
    const [a] = avisosDeExame([exame({ exam_date: '2025-08-18' })], NOW);
    expect(a?.detalhe).toContain('Vale repetir?');
    expect(a?.titulo.toLowerCase()).not.toContain('precisa');
    expect(a?.titulo.toLowerCase()).not.toContain('repita');
    if (a?.acao.tipo === 'perguntar') expect(a.acao.mensagem).toMatch(/Vale repetir\?$/);
  });

  it('um aviso por NOME de exame, do mais antigo pro mais recente', () => {
    const avisos = avisosDeExame(
      [
        exame({ id: 'h1', title: 'Hemograma completo', exam_date: '2026-01-18' }),
        exame({ id: 'h2', title: 'Hemograma completo', exam_date: '2025-06-18' }),
        exame({ id: 't1', title: 'TSH', exam_date: '2024-08-18' }),
      ],
      NOW,
    );
    expect(avisos).toHaveLength(2);
    expect(avisos[0]?.titulo).toContain('TSH');
  });

  it('a faixa não é o acervo: só os 2 tipos mais antigos viram pergunta', () => {
    /**
     * O defeito: um paciente com histórico de verdade (hemograma, glicemia, colesterol,
     * TSH, creatinina, urina) recebia SEIS cartões de ~130px com botão de 44pt entre o
     * herói e as Alergias, todo santo dia, sem nada pra dispensar. Nenhum exame some —
     * todos continuam na biblioteca, que tem entrada própria na mesma tela; o que este
     * teto limita é quantas perguntas a faixa faz de uma vez.
     */
    expect(TIPOS_DE_EXAME_NA_FAIXA).toBe(2);
    // Cinco destes seis são `exam_type: 'sangue'` — a forma da produção. Agrupados pela
    // categoria eles seriam UM aviso; pelo nome do laudo são cinco, e o teto é que corta.
    const avisos = avisosDeExame(
      [
        exame({ id: 'e1', exam_type: 'sangue', title: 'Hemograma completo', exam_date: '2026-01-18' }),
        exame({ id: 'e2', exam_type: 'sangue', title: 'Glicemia de jejum', exam_date: '2025-11-18' }),
        exame({ id: 'e3', exam_type: 'sangue', title: 'Colesterol total', exam_date: '2025-09-18' }),
        exame({ id: 'e4', exam_type: 'sangue', title: 'TSH', exam_date: '2024-08-18' }),
        exame({ id: 'e5', exam_type: 'sangue', title: 'Creatinina', exam_date: '2023-08-18' }),
        exame({ id: 'e6', exam_type: 'urina', title: 'Urina tipo 1', exam_date: '2022-08-18' }),
      ],
      NOW,
    );
    expect(avisos).toHaveLength(2);
    // E os que ficam são os mais antigos, na ordem em que a pergunta faz mais sentido.
    expect(avisos.map((a) => a.chave)).toEqual(['exame:e6', 'exame:e5']);
  });

  it('exame sem data legível nunca vira aviso de "faz N meses"', () => {
    expect(avisosDeExame([exame({ exam_date: null })], NOW)).toHaveLength(0);
  });

  it('não inventa exame que o paciente nunca fez', () => {
    // Prontuário sem exame nenhum não produz sugestão: indicar exame é ato médico.
    expect(avisosDeExame([], NOW)).toHaveLength(0);
  });
});

describe('avisosDoProntuario — a ordem da faixa', () => {
  it('estoque (tem prazo) vem antes de exame (não tem)', () => {
    const avisos = avisosDoProntuario(
      {
        medications: [med()],
        inventory: [caixa({ tablets_remaining: 2 })],
        examResults: [exame({ exam_date: '2024-08-18' })],
      },
      NOW,
    );
    expect(avisos.map((a) => a.chave)).toEqual(['estoque:m1', 'exame:e1']);
  });

  it('prontuário sem nada não produz faixa nenhuma', () => {
    expect(avisosDoProntuario({ medications: [], inventory: [], examResults: [] }, NOW)).toEqual([]);
  });

  it('nenhum aviso repete a mesma chave (a `key` da lista é estável)', () => {
    const avisos = avisosDoProntuario(
      {
        medications: [med({ id: 'm1' }), med({ id: 'm2', medication_name: 'Dipirona' })],
        inventory: [caixa({ id: 'i1' }), caixa({ id: 'i2', medication_id: 'm2', tablets_remaining: 1 })],
        examResults: [],
      },
      NOW,
    );
    const chaves = avisos.map((a) => a.chave);
    expect(new Set(chaves).size).toBe(chaves.length);
  });
});

describe('adesaoEmPartes', () => {
  it('o número é herói e a frase não o repete', () => {
    const p = adesaoEmPartes(0.87);
    expect(p.numero).toBe('87%');
    expect(p.frase).toBe('quase sempre');
    expect(p.frase).not.toContain('87');
  });

  it('sem registro NÃO vira 0%', () => {
    // 0% afirma "tinha remédio pra tomar e não tomou"; null é "não houve registro".
    const p = adesaoEmPartes(null);
    expect(p.numero).toBe('—');
    expect(p.frase).toBe('sem registro ainda');
  });

  it('adesão baixa mantém o tom da Xarlote — sem repreender', () => {
    const p = adesaoEmPartes(0.44);
    expect(p.numero).toBe('44%');
    expect(p.frase).toBe('vamos ajustar juntos');
  });
});
