import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  STATUS_ATIVOS,
  STATUS_ENCERRADOS,
  descreverNovoLembrete,
  linhaHistorico,
  normalizarHorario,
  proximaOcorrenciaBrt,
  proximoInstanteRelevante,
  separarAgenda,
  validarNovoLembrete,
} from '../apps/mobile/src/features/reminders/format.js';
import type { ReminderRow } from '../apps/mobile/src/features/health/overview.js';

/**
 * A tela de Lembretes depois da queixa "eles vão se acumulando infinitamente".
 *
 * O defeito real era pior: os encerrados EXPULSAVAM os vivos, porque a rota ordenava por
 * `next_run_at ASC` sem filtrar status e cortava em 120 — e lembrete encerrado guarda a
 * data no passado pra sempre. O conserto partiu a lista em duas consultas de naturezas
 * diferentes (viva pequena e completa; histórico paginado por cursor e sob demanda), e é
 * essa partição que o primeiro bloco de testes vigia.
 *
 * O resto são as funções puras que a tela usa pra decidir: em que bloco cada lembrete
 * cai, quando o rótulo envelhece, e o que vira o corpo do POST de criação.
 */

const T = Date.parse('2026-08-18T14:30:00.000Z'); // 11:30 BRT de uma terça

function lembrete(over: Partial<ReminderRow> = {}): ReminderRow {
  return {
    id: 'r1',
    type: 'medication',
    title: 'Losartana',
    body: null,
    scheduled_at: null,
    rrule: null,
    next_run_at: null,
    status: 'pending',
    medication_id: null,
    last_confirmed_at: null,
    created_at: null,
    ...over,
  };
}

// ─── O vigilante da partição de status ──────────────────────────────────────────

const raiz = (rel: string) => fileURLToPath(new URL(`../${rel}`, import.meta.url));

/** Os valores do enum `reminder_status_t` como o BANCO os conhece hoje. */
function statusDoBanco(): string[] {
  const schema = readFileSync(raiz('infra/supabase/schema.sql'), 'utf8');
  const m = /create type reminder_status_t as enum \(([^)]+)\)/.exec(schema);
  if (!m?.[1]) throw new Error('não achei o enum reminder_status_t no schema.sql');
  const valores = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1] as string);

  // Uma migration pode ACRESCENTAR valor ao enum sem tocar no schema.sql — e é
  // justamente esse o caminho pelo qual um status novo apareceria sem ninguém
  // classificá-lo nas duas consultas.
  const dir = raiz('infra/supabase/migrations');
  for (const arquivo of readdirSync(dir)) {
    if (!arquivo.endsWith('.sql')) continue;
    const sql = readFileSync(`${dir}/${arquivo}`, 'utf8');
    for (const add of sql.matchAll(/alter type reminder_status_t add value\s+(?:if not exists\s+)?'([^']+)'/gi)) {
      valores.push(add[1] as string);
    }
  }
  return [...new Set(valores)];
}

/** A mesma lista, lida do FONTE da rota — o servidor não pode importar do app. */
function listaDaRota(nome: string): string[] {
  const fonte = readFileSync(raiz('apps/api/src/routes/app/reminders.ts'), 'utf8');
  const m = new RegExp(`const ${nome} = \\[([^\\]]+)\\]`).exec(fonte);
  if (!m?.[1]) throw new Error(`não achei ${nome} em routes/app/reminders.ts`);
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1] as string);
}

describe('o vigilante da partição de status', () => {
  it('todo status do enum está em exatamente UMA das duas listas', () => {
    const doBanco = statusDoBanco().sort();
    const classificados = [...STATUS_ATIVOS, ...STATUS_ENCERRADOS].sort();

    expect(
      classificados,
      `Status do enum reminder_status_t sem classificação em apps/mobile/src/features/` +
        `reminders/format.ts. Um status não classificado fica FORA das duas consultas da ` +
        `rota (?scope=active e ?scope=history) e o lembrete DESAPARECE da tela sem erro ` +
        `nenhum. Decida: ele é ativo (o paciente ainda age) ou encerrado?`,
    ).toEqual(doBanco);
  });

  it('as duas listas são disjuntas — nenhum status conta duas vezes', () => {
    const cruzamento = STATUS_ATIVOS.filter((s) => (STATUS_ENCERRADOS as readonly string[]).includes(s));
    expect(cruzamento).toEqual([]);
  });

  it('cliente e servidor concordam sobre a partição', () => {
    // Duas listas à mão sobre o mesmo enum, em dois pacotes que não podem se importar.
    // Se divergirem, a tela pede `?scope=active` e o servidor devolve outra coisa —
    // e ninguém percebe, porque as duas respostas são HTTP 200 com lembretes dentro.
    expect(listaDaRota('STATUS_ATIVOS')).toEqual([...STATUS_ATIVOS]);
    expect(listaDaRota('STATUS_ENCERRADOS')).toEqual([...STATUS_ENCERRADOS]);
  });

  it('`failed` NÃO entra nas listas do servidor (valor fora do enum recusa a consulta)', () => {
    // O cliente tolera `failed` como encerrado por causa de dado legado; o servidor não
    // pode, porque `.in('status', [...])` com valor fora do enum faz o Postgres recusar
    // a consulta INTEIRA — a tela ficaria vazia pra todo mundo.
    expect(listaDaRota('STATUS_ENCERRADOS')).not.toContain('failed');
    expect(listaDaRota('STATUS_ATIVOS')).not.toContain('failed');
  });
});

// ─── separarAgenda ──────────────────────────────────────────────────────────────

describe('separarAgenda', () => {
  it('atraso e hoje ficam ABERTOS; amanhã em diante vai pra seção recolhida', () => {
    const a = separarAgenda(
      [
        lembrete({ id: 'atrasado', next_run_at: '2026-08-18T13:00:00.000Z' }),
        lembrete({ id: 'hoje', next_run_at: '2026-08-18T23:00:00.000Z' }),
        lembrete({ id: 'amanha', next_run_at: '2026-08-19T11:00:00.000Z' }),
        lembrete({ id: 'semana', next_run_at: '2026-08-23T11:00:00.000Z' }),
      ],
      T,
    );

    expect(a.acionaveis.map((g) => g.bloco)).toEqual(['atrasado', 'hoje']);
    expect(a.futuros.map((g) => g.bloco)).toEqual(['amanha', 'semana']);
    expect(a.atrasados).toBe(1);
    expect(a.totalFuturos).toBe(2);
  });

  it('o próximo é o mais urgente de todos — e é o atrasado quando existe', () => {
    const a = separarAgenda(
      [
        lembrete({ id: 'hoje', next_run_at: '2026-08-18T23:00:00.000Z' }),
        lembrete({ id: 'atrasado', next_run_at: '2026-08-18T10:00:00.000Z' }),
      ],
      T,
    );
    expect(a.proximo?.id).toBe('atrasado');
  });

  it('sem atrasado, o próximo é o primeiro horário que vem', () => {
    const a = separarAgenda(
      [
        lembrete({ id: 'tarde', next_run_at: '2026-08-18T22:00:00.000Z' }),
        lembrete({ id: 'daqui-a-pouco', next_run_at: '2026-08-18T15:00:00.000Z' }),
      ],
      T,
    );
    expect(a.proximo?.id).toBe('daqui-a-pouco');
  });

  it('encerrado que chega pela lista VIVA é o eco de um toque — fica visível, fora dos blocos', () => {
    // A rota `?scope=active` nunca devolve encerrado. Quando um aparece, é porque o eco
    // otimista acabou de marcá-lo — e a linha tem que CONTINUAR na tela: desaparecer não
    // é confirmação, é o paciente perguntando se registrou.
    const a = separarAgenda(
      [
        lembrete({ id: 'feito', status: 'acknowledged', last_confirmed_at: '2026-08-18T14:29:00.000Z' }),
        lembrete({ id: 'cancelado', status: 'cancelled' }),
        lembrete({ id: 'vivo', next_run_at: '2026-08-18T23:00:00.000Z' }),
      ],
      T,
    );

    expect(a.recemEncerrados.map((r) => r.id)).toEqual(['feito', 'cancelado']);
    // E não contamina os grupos: o "Já resolvidos" da tela é a seção paginada, e o mesmo
    // dado dito duas vezes é exatamente o que essa separação evita.
    expect(a.acionaveis.flatMap((g) => g.lembretes.map((r) => r.id))).toEqual(['vivo']);
    expect(a.futuros).toEqual([]);
  });

  it('o confirmado PELO WHATSAPP sai do atraso sem sumir da tela', () => {
    // Status ativo ('sent') + carimbo de confirmação depois do horário = encerrado, mas
    // a linha continua visível. Se a separação fosse por STATUS, ele iria pra `vivos`,
    // `agruparLembretes` o jogaria no bloco 'encerrado' — que não está nem em
    // `acionaveis` nem em `futuros` — e ele desapareceria da tela inteira.
    const a = separarAgenda(
      [
        lembrete({
          id: 'confirmado-no-zap',
          status: 'sent',
          next_run_at: '2026-08-18T13:00:00.000Z',
          last_confirmed_at: '2026-08-18T13:05:00.000Z',
        }),
        lembrete({ id: 'atrasado-de-verdade', status: 'sent', next_run_at: '2026-08-18T12:00:00.000Z' }),
      ],
      T,
    );

    expect(a.recemEncerrados.map((r) => r.id)).toEqual(['confirmado-no-zap']);
    expect(a.acionaveis.flatMap((g) => g.lembretes.map((r) => r.id))).toEqual(['atrasado-de-verdade']);
    // E o cartão de alerta do topo conta 1, não 2: cobrar do paciente uma dose que o
    // sistema já registrou é o defeito que essa regra existe pra matar.
    expect(a.atrasados).toBe(1);
  });

  it('lista vazia não inventa bloco nenhum', () => {
    const a = separarAgenda([], T);
    expect(a).toMatchObject({ acionaveis: [], futuros: [], recemEncerrados: [], atrasados: 0, totalFuturos: 0, proximo: null });
  });
});

// ─── proximoInstanteRelevante (o despertador) ───────────────────────────────────

describe('proximoInstanteRelevante', () => {
  it('sem lembrete nenhum, acorda na meia-noite de Brasília', () => {
    // 11:30 BRT de 18/08 → 00:00 BRT de 19/08 = 03:00 UTC de 19/08.
    expect(proximoInstanteRelevante([], T)).toBe(Date.parse('2026-08-19T03:00:00.000Z'));
  });

  it('a próxima dose de hoje vence a meia-noite', () => {
    const alvo = '2026-08-18T17:00:00.000Z'; // 14h BRT
    expect(proximoInstanteRelevante([lembrete({ next_run_at: alvo })], T)).toBe(Date.parse(alvo));
  });

  it('horário que já passou não agenda nada — quem está atrasado já está no bloco certo', () => {
    expect(proximoInstanteRelevante([lembrete({ next_run_at: '2026-08-18T10:00:00.000Z' })], T)).toBe(
      Date.parse('2026-08-19T03:00:00.000Z'),
    );
  });

  it('encerrado é ignorado, mesmo com data futura', () => {
    const futuro = '2026-08-18T17:00:00.000Z';
    expect(
      proximoInstanteRelevante([lembrete({ status: 'cancelled', next_run_at: futuro })], T),
    ).toBe(Date.parse('2026-08-19T03:00:00.000Z'));
  });

  it('pega o MENOR dos futuros, não o primeiro da lista', () => {
    const a = proximoInstanteRelevante(
      [
        lembrete({ id: 'a', next_run_at: '2026-08-18T22:00:00.000Z' }),
        lembrete({ id: 'b', next_run_at: '2026-08-18T15:00:00.000Z' }),
      ],
      T,
    );
    expect(a).toBe(Date.parse('2026-08-18T15:00:00.000Z'));
  });

  it('cai no scheduled_at quando não há next_run_at', () => {
    expect(proximoInstanteRelevante([lembrete({ scheduled_at: '2026-08-18T16:00:00.000Z' })], T)).toBe(
      Date.parse('2026-08-18T16:00:00.000Z'),
    );
  });
});

// ─── normalizarHorario ──────────────────────────────────────────────────────────

describe('normalizarHorario', () => {
  it.each([
    ['08:00', '08:00'],
    ['8:00', '08:00'],
    ['8', '08:00'],
    ['08', '08:00'],
    ['830', '08:30'],
    ['0830', '08:30'],
    ['20:15', '20:15'],
    ['2015', '20:15'],
    ['8h30', '08:30'],
    ['  7:05 ', '07:05'],
    ['00:00', '00:00'],
    ['23:59', '23:59'],
  ])('%s → %s', (bruto, esperado) => {
    expect(normalizarHorario(bruto)).toBe(esperado);
  });

  it('uma casa só de minuto é DEZENA — "8:3" é oito e trinta', () => {
    // É como se lê num relógio digital, e é o erro de digitação mais comum no campo.
    expect(normalizarHorario('8:3')).toBe('08:30');
  });

  it.each([
    ['vazio', ''],
    ['só espaço', '   '],
    ['hora impossível', '25:00'],
    ['minuto impossível', '08:70'],
    ['dígitos demais', '123456'],
    ['letras', 'de manhã'],
    ['só os dois-pontos', ':'],
  ])('%s → null, sem lançar', (_nome, bruto) => {
    expect(normalizarHorario(bruto)).toBeNull();
  });
});

// ─── validarNovoLembrete ────────────────────────────────────────────────────────

describe('validarNovoLembrete', () => {
  it('devolve JÁ o corpo do POST, com o horário normalizado', () => {
    const v = validarNovoLembrete({ titulo: '  Losartana  50mg ', horario: '830', diario: true, tipo: 'medication' });
    expect(v).toEqual({
      ok: true,
      corpo: { title: 'Losartana 50mg', time: '08:30', daily: true, type: 'medication' },
    });
  });

  it('título curto reprova NO CAMPO, com frase que ensina', () => {
    const v = validarNovoLembrete({ titulo: 'a', horario: '08:00', diario: true, tipo: 'medication' });
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.campo).toBe('titulo');
    expect(v.mensagem).toMatch(/Losartana/);
  });

  it('título acima do teto da rota reprova AQUI, em vez de ser cortado em silêncio', () => {
    const v = validarNovoLembrete({ titulo: 'x'.repeat(81), horario: '08:00', diario: true, tipo: 'custom' });
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.campo).toBe('titulo');
  });

  it('horário ilegível reprova e diz o formato aceito', () => {
    const v = validarNovoLembrete({ titulo: 'Losartana', horario: 'de manhã', diario: true, tipo: 'medication' });
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.campo).toBe('horario');
    expect(v.mensagem).toMatch(/08:00/);
  });

  it('o `time` do corpo casa com o regex da rota', () => {
    // A rota valida `^([01]?\d|2[0-3]):[0-5]\d$`. Um corpo que o cliente monta e o
    // servidor recusa vira 400 mudo — e "invalid_body" não diz nada ao paciente.
    const regexDaRota = /^([01]?\d|2[0-3]):[0-5]\d$/;
    for (const bruto of ['8', '830', '23:59', '00:00', '0000', '1205']) {
      const v = validarNovoLembrete({ titulo: 'Losartana', horario: bruto, diario: false, tipo: 'custom' });
      expect(v.ok, `"${bruto}" deveria validar`).toBe(true);
      if (!v.ok) continue;
      expect(v.corpo.time, `"${bruto}" → "${v.corpo.time}" não casa com o regex da rota`).toMatch(regexDaRota);
    }
  });
});

// ─── A prévia (proximaOcorrenciaBrt / descreverNovoLembrete) ────────────────────

describe('a prévia do novo lembrete', () => {
  it('horário que ainda vem hoje é HOJE', () => {
    // 11:30 BRT; 20:00 BRT do mesmo dia = 23:00 UTC.
    expect(proximaOcorrenciaBrt('20:00', T)).toBe(Date.parse('2026-08-18T23:00:00.000Z'));
  });

  it('horário que já passou é AMANHÃ — a dúvida de quem cria às 21h pras 8h', () => {
    expect(proximaOcorrenciaBrt('08:00', T)).toBe(Date.parse('2026-08-19T11:00:00.000Z'));
  });

  it('a frase diz "todo dia" e quando é o primeiro', () => {
    const frase = descreverNovoLembrete({ title: 'Losartana', time: '08:00', daily: true, type: 'medication' }, T);
    expect(frase).toBe('Todo dia às 08:00 — o primeiro é amanhã às 08:00.');
  });

  it('sem recorrência a frase diz que é uma vez só', () => {
    const frase = descreverNovoLembrete({ title: 'Levar o exame', time: '20:00', daily: false, type: 'custom' }, T);
    expect(frase).toBe('Uma vez, hoje às 20:00.');
  });

  it('horário ilegível não vira prévia inventada', () => {
    expect(descreverNovoLembrete({ title: 'x', time: '99:99', daily: true, type: 'custom' }, T)).toBe('');
  });
});

// ─── linhaHistorico ─────────────────────────────────────────────────────────────

describe('linhaHistorico', () => {
  it('confirmado mostra a data da CONFIRMAÇÃO', () => {
    const l = linhaHistorico(
      lembrete({
        status: 'acknowledged',
        last_confirmed_at: '2026-08-17T11:05:00.000Z',
        next_run_at: '2026-08-17T11:00:00.000Z',
        created_at: '2026-01-02T00:00:00.000Z',
      }),
    );
    expect(l).toEqual({ desfecho: 'Confirmado', quandoIso: '2026-08-17T11:05:00.000Z', positivo: true });
  });

  it('cancelado NUNCA cai no created_at', () => {
    // Dizer "Cancelado · 02/01/2026" ao lado da data de criação faria o paciente ler que
    // o cancelamento foi em janeiro, quando ele aconteceu hoje.
    const l = linhaHistorico(
      lembrete({ status: 'cancelled', next_run_at: '2026-08-17T11:00:00.000Z', created_at: '2026-01-02T00:00:00.000Z' }),
    );
    expect(l.desfecho).toBe('Cancelado');
    expect(l.quandoIso).toBe('2026-08-17T11:00:00.000Z');
    expect(l.positivo).toBe(false);
  });

  it('status legado sem desfecho conhecido não inventa um', () => {
    const l = linhaHistorico(lembrete({ status: 'failed', next_run_at: '2026-08-17T11:00:00.000Z' }));
    expect(l.desfecho).toBe('Encerrado');
    expect(l.positivo).toBe(false);
  });

  it('sem data nenhuma volta null em vez de string vazia disfarçada', () => {
    expect(linhaHistorico(lembrete({ status: 'cancelled' })).quandoIso).toBeNull();
  });
});
