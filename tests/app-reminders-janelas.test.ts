import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  confirmadoForaDoApp,
  maisNovoPrimeiro,
  type LinhaLembrete,
} from '../apps/api/src/routes/app/reminders.js';

/**
 * A lista VIVA de lembretes — e o penhasco que mudou de lugar duas vezes.
 *
 * 1ª versão: `next_run_at ASC` + `LIMIT 120` sem filtro de status. Encerrado guarda a
 *    data no passado pra sempre, então o corte pegava os 120 mais ANTIGOS e a dose de
 *    hoje sumia. Penhasco no item 121.
 * 2ª versão: filtrou status e cortou em 60 — e o penhasco foi pro item 61, porque
 *    VENCIDO ORDENA PRIMEIRO e o conjunto de vencidos é justamente o que cresce sem
 *    teto (lembrete de uma vez só que ninguém confirmou fica vencido pra sempre).
 * 3ª versão (a atual): duas janelas. Vencido lido do mais RECENTE pro mais antigo, com
 *    teto pequeno; futuro lido do mais próximo pro mais distante, com o teto grande. O
 *    corte de um lado não alcança o outro.
 *
 * E uma das fontes do acúmulo de vencidos é o que o primeiro bloco vigia: o lembrete
 * confirmado pelo WhatsApp, que fica com status ATIVO e carimbo de confirmação.
 */

function linha(over: Record<string, unknown> = {}): LinhaLembrete {
  return {
    id: 'r1',
    rrule: null,
    scheduled_at: null,
    next_run_at: '2026-08-18T13:00:00.000Z',
    last_confirmed_at: null,
    status: 'sent',
    created_at: '2026-08-18T12:00:00.000Z',
    ...over,
  } as LinhaLembrete;
}

describe('confirmadoForaDoApp', () => {
  it('uma vez só, confirmado DEPOIS do horário → sai da lista viva', () => {
    // `handleLogMedicationTaken` e o backstop do inbound-user gravam SÓ
    // `last_confirmed_at`; o status continua 'sent'. Sem esta poda o lembrete vira um
    // vencido permanente: ocupa vaga na janela dos atrasos e a tela cobra do paciente
    // uma dose que o sistema já registrou.
    expect(confirmadoForaDoApp(linha({ last_confirmed_at: '2026-08-18T13:04:00.000Z' }))).toBe(true);
  });

  it('RECORRENTE nunca é podado — o carimbo é da ocorrência anterior', () => {
    // A guarda mais importante da função: sem ela, um atraso do dispatcher esconderia um
    // remédio de TODO DIA da tela, que é o pior desfecho possível.
    expect(
      confirmadoForaDoApp(
        linha({ rrule: 'FREQ=DAILY;BYHOUR=8;BYMINUTE=0', last_confirmed_at: '2026-08-18T13:04:00.000Z' }),
      ),
    ).toBe(false);
  });

  it('sem carimbo nenhum, o vencido continua vencido', () => {
    expect(confirmadoForaDoApp(linha())).toBe(false);
  });

  it('confirmar e DEPOIS adiar reabre a linha', () => {
    // `+30 min` empurra o `next_run_at` pra frente do carimbo — quem pediu pra ser
    // chamado de novo tem que ser chamado de novo.
    expect(
      confirmadoForaDoApp(
        linha({ next_run_at: '2026-08-18T18:00:00.000Z', last_confirmed_at: '2026-08-18T13:04:00.000Z' }),
      ),
    ).toBe(false);
  });

  it('confirmado e sem horário nenhum: não há o que cobrar', () => {
    expect(
      confirmadoForaDoApp(
        linha({ next_run_at: null, scheduled_at: null, last_confirmed_at: '2026-08-18T13:04:00.000Z' }),
      ),
    ).toBe(true);
  });

  it('cai no scheduled_at quando não há next_run_at', () => {
    expect(
      confirmadoForaDoApp(
        linha({
          next_run_at: null,
          scheduled_at: '2026-08-18T13:00:00.000Z',
          last_confirmed_at: '2026-08-18T13:04:00.000Z',
        }),
      ),
    ).toBe(true);
  });

  it('carimbo ilegível não encerra nada', () => {
    // Dado torto não pode APAGAR lembrete da tela: na dúvida, ele continua vivo.
    expect(confirmadoForaDoApp(linha({ last_confirmed_at: 'ontem' }))).toBe(false);
  });
});

describe('o vigilante das duas janelas', () => {
  const fonte = readFileSync(
    fileURLToPath(new URL('../apps/api/src/routes/app/reminders.ts', import.meta.url)),
    'utf8',
  );

  const porQue =
    'A lista viva precisa de DUAS janelas: vencidos do mais recente pro mais antigo (DESC, ' +
    'teto pequeno) e o que ainda vem do mais próximo pro mais distante (ASC). Com UMA janela ' +
    'ordenada por next_run_at ASC, o vencido — que cresce sem teto — ordena primeiro e come o ' +
    'teto inteiro: a dose de HOJE fica fora da resposta. É o penhasco do item 121, uma escala ' +
    'abaixo. Se mudou a forma de ler, prove a invariante de outro jeito antes de apagar isto.';

  it('a janela dos VENCIDOS lê do atraso mais recente pro mais antigo', () => {
    expect(fonte, porQue).toMatch(/\.lt\('next_run_at'/);
    expect(fonte, porQue).toMatch(/\.order\('next_run_at', \{ ascending: false \}\)/);
  });

  it('a janela do FUTURO carrega também os sem data — ninguém cai entre as duas', () => {
    // `.lt` não devolve NULL, então o lembrete sem próxima execução só existe se a outra
    // janela o pedir explicitamente.
    expect(fonte, porQue).toMatch(/next_run_at\.gte\./);
    expect(fonte, porQue).toMatch(/next_run_at\.is\.null/);
  });

  it('o teto dos vencidos é MENOR que o do futuro', () => {
    const teto = (nome: string) => {
      const m = new RegExp(`const ${nome} = (\\d+)`).exec(fonte);
      if (!m?.[1]) throw new Error(`não achei ${nome} em routes/app/reminders.ts`);
      return Number(m[1]);
    };
    // O vencido de março não muda nenhuma decisão de hoje; o próximo remédio, sim.
    expect(teto('VENCIDOS_MAX')).toBeLessThan(teto('FUTUROS_MAX'));
  });

  it('a resposta NÃO anuncia um "limite" — nenhum número descreve as duas janelas', () => {
    // `limite` valia a SOMA dos dois tetos (60), mas as janelas cortam de forma
    // independente: 20 vencidos + 3 futuros devolvem 18 linhas, e a tela imprimia
    // "estes são os 60 mais próximos". Pior, sem o campo ela dizia "os 0 mais
    // próximos". O único número que a tela pode afirmar é o tamanho do que recebeu.
    expect(fonte, 'a rota voltou a mandar `limite` — ver o docblock do scope=active').not.toMatch(
      /limite:/,
    );
  });
});

describe('o acervo é o que o paciente JÁ RESOLVEU — não um status', () => {
  const fonte = readFileSync(
    fileURLToPath(new URL('../apps/api/src/routes/app/reminders.ts', import.meta.url)),
    'utf8',
  );

  const porQue =
    'O que o paciente confirma pelo WhatsApp fica com `status` ATIVO e só o carimbo ' +
    '`last_confirmed_at` (tool-executor e inbound-user não gravam o status). `podarJanela` ' +
    'tira essas linhas da lista VIVA — e sem esta segunda consulta elas não ficam em lugar ' +
    'nenhum do app, enquanto a seção "Já resolvidos" promete por escrito que o confirmado ' +
    'fica registrado lá. Se o conserto definitivo (gravar acknowledged junto do carimbo) ' +
    'entrou, esta consulta passa a devolver vazio sozinha — mas só apague quando isso for ' +
    'verdade nos DOIS caminhos de confirmação.';

  it('o histórico também lê os confirmados que o status não denuncia', () => {
    expect(fonte, porQue).toMatch(/lerConfirmadosPorFora/);
    expect(fonte, porQue).toMatch(/\.not\('last_confirmed_at', 'is', null\)/);
  });

  it('recorrente NUNCA entra no acervo por carimbo — ele segue vivo', () => {
    // A guarda que impede um remédio de TODO DIA de ser mandado pro cemitério.
    expect(fonte, porQue).toMatch(/\.is\('rrule', null\)/);
  });

  it('a poda da lista viva e a leitura do acervo usam o MESMO juiz', () => {
    // Predicados diferentes nas duas pontas produzem o pior desfecho possível: a linha
    // some da lista E não aparece no histórico.
    expect(fonte, porQue).toMatch(/brutas\.filter\(confirmadoForaDoApp\)/);
  });

  it('o contador do cabeçalho soma as duas populações', () => {
    // "Já resolvidos · 143" tem que contar o que a seção consegue mostrar. Contar só um
    // lado faria o cabeçalho prometer menos do que ele abre.
    const m = /async function contarEncerrados[\s\S]*?\n}/.exec(fonte);
    expect(m?.[0], 'não achei contarEncerrados').toBeTruthy();
    expect(m?.[0], porQue).toMatch(/last_confirmed_at/);
  });
});

describe('maisNovoPrimeiro — a ordem que funde as duas consultas do acervo', () => {
  function l(id: string, createdAt: string | null): LinhaLembrete {
    return { id, created_at: createdAt } as LinhaLembrete;
  }

  it('mais recente primeiro (é `created_at desc` nas duas consultas)', () => {
    const linhas = [
      l('velho', '2026-01-02T10:00:00+00:00'),
      l('novo', '2026-08-18T10:00:00+00:00'),
      l('meio', '2026-05-01T10:00:00+00:00'),
    ].sort(maisNovoPrimeiro);
    expect(linhas.map((x) => x.id)).toEqual(['novo', 'meio', 'velho']);
  });

  it('empate no instante desempata por id DESC — a mesma regra do `.order(id)`', () => {
    const linhas = [l('a', '2026-08-18T10:00:00+00:00'), l('z', '2026-08-18T10:00:00+00:00')].sort(
      maisNovoPrimeiro,
    );
    expect(linhas.map((x) => x.id)).toEqual(['z', 'a']);
  });

  it('microssegundo desempata antes do id — `Date.parse` só enxerga a milésima', () => {
    // Duas linhas do mesmo milissegundo sairiam daqui numa ordem e do banco em outra, e
    // o cursor keyset pularia uma delas na virada de página.
    const linhas = [
      l('cedo', '2026-08-18T10:00:00.123001+00:00'),
      l('tarde', '2026-08-18T10:00:00.123999+00:00'),
    ].sort(maisNovoPrimeiro);
    expect(linhas.map((x) => x.id)).toEqual(['tarde', 'cedo']);
  });

  it('sem `created_at` vai pro FIM, como o `nullsFirst: false` das consultas', () => {
    // Uma linha sem carimbo no topo fixaria o começo do histórico pra sempre: com cursor
    // nulo, a paginação nunca sairia dela.
    const linhas = [l('torto', null), l('bom', '2026-01-02T10:00:00+00:00')].sort(maisNovoPrimeiro);
    expect(linhas.map((x) => x.id)).toEqual(['bom', 'torto']);
  });
});

describe('o teto de criação conta o que a TELA mostra', () => {
  const fonte = readFileSync(
    fileURLToPath(new URL('../apps/api/src/routes/app/reminders.ts', import.meta.url)),
    'utf8',
  );

  const porQue =
    'A contagem por `count exact head` não aplicava a poda dos confirmados-por-fora, que a ' +
    'lista viva aplica. Um paciente com 40 lembretes de dose única confirmados pelo WhatsApp ' +
    '(que ficam "sent" pra sempre) levava 409 dizendo "você já tem 40 lembretes ativos, ' +
    'cancela algum" com 3 lembretes na tela — e as 40 linhas não apareciam nem na lista nem ' +
    'no histórico. Beco sem saída na única rota de escrita do app.';

  it('o POST cobra o teto em cima de `lerAtivos`, a mesma leitura da tela', () => {
    const post = /app\.post\('\/reminders',[\s\S]*?\n  \}\);/.exec(fonte);
    expect(post?.[0], 'não achei o handler de POST /reminders').toBeTruthy();
    expect(post?.[0], porQue).toMatch(/await lerAtivos\(userId\)/);
    expect(post?.[0], porQue).not.toMatch(/count: 'exact'/);
  });

  it('a mensagem do 409 usa o número que foi contado, e não outro', () => {
    const post = /app\.post\('\/reminders',[\s\S]*?\n  \}\);/.exec(fonte);
    expect(post?.[0], porQue).toMatch(/Você já tem \$\{quantosAtivos\} lembretes ativos/);
  });

  it('o teto por paciente cabe dentro do que `lerAtivos` consegue ler', () => {
    // Se ATIVOS_POR_PACIENTE passar de VENCIDOS_MAX + FUTUROS_MAX, o teto vira
    // inalcançável: a lista nunca devolve linhas suficientes pra cobrá-lo, e o freio
    // que existe pra impedir o acúmulo some sem ninguém perceber.
    const num = (nome: string) => {
      const m = new RegExp(`const ${nome} = (\\d+)`).exec(fonte);
      if (!m?.[1]) throw new Error(`não achei ${nome} em routes/app/reminders.ts`);
      return Number(m[1]);
    };
    expect(num('ATIVOS_POR_PACIENTE')).toBeLessThanOrEqual(num('VENCIDOS_MAX') + num('FUTUROS_MAX'));
  });
});
