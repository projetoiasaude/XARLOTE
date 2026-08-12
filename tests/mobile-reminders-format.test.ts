import { describe, it, expect } from 'vitest';
import {
  acoesDisponiveis,
  agruparLembretes,
  blocoDoLembrete,
  fraseDaAcao,
  lembreteOtimista,
} from '../apps/mobile/src/features/reminders/format.js';
import type { ReminderRow } from '../apps/mobile/src/features/health/overview.js';

/**
 * A tela de Lembretes.
 *
 * O teste que mais importa aqui é o do **eco otimista honesto**: confirmar um remédio
 * recorrente não pode mostrar "concluído" e voltar pra "pendente amanhã às 7h" um
 * segundo depois. Como a decisão vem da mesma função pura que o servidor usa
 * (`reminderActionPatch`, de shared), a tela mostra de imediato o resultado CERTO — e
 * este arquivo é o que garante que continue assim quando alguém mexer na regra.
 */

const T = Date.parse('2026-08-05T14:30:00.000Z'); // 11:30 BRT

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

describe('blocoDoLembrete', () => {
  it('horário que já passou é ATRASADO, mesmo de semanas atrás', () => {
    // O lembrete indeliverável em loop (incidente A8) ficava invisível justamente por
    // ser antigo demais pra caber em "hoje". Aqui ele aparece no topo.
    expect(blocoDoLembrete(lembrete({ next_run_at: '2026-08-05T13:00:00.000Z' }), T)).toBe('atrasado');
    expect(blocoDoLembrete(lembrete({ next_run_at: '2026-07-01T13:00:00.000Z' }), T)).toBe('atrasado');
  });

  it('separa hoje, amanhã, esta semana e depois', () => {
    expect(blocoDoLembrete(lembrete({ next_run_at: '2026-08-05T23:00:00.000Z' }), T)).toBe('hoje');
    expect(blocoDoLembrete(lembrete({ next_run_at: '2026-08-06T10:00:00.000Z' }), T)).toBe('amanha');
    expect(blocoDoLembrete(lembrete({ next_run_at: '2026-08-10T10:00:00.000Z' }), T)).toBe('semana');
    expect(blocoDoLembrete(lembrete({ next_run_at: '2026-09-10T10:00:00.000Z' }), T)).toBe('depois');
  });

  it('cancelado e confirmado saem da lista de ação, mas não da tela', () => {
    expect(blocoDoLembrete(lembrete({ status: 'cancelled' }), T)).toBe('encerrado');
    expect(blocoDoLembrete(lembrete({ status: 'acknowledged' }), T)).toBe('encerrado');
    expect(blocoDoLembrete(lembrete({ status: 'failed' }), T)).toBe('encerrado');
  });

  it('pendente sem horário nenhum NÃO desaparece', () => {
    // Dado que existe no banco e não aparece em lugar algum é dado perdido.
    expect(blocoDoLembrete(lembrete({ next_run_at: null, scheduled_at: null }), T)).toBe('depois');
  });

  it('cai pro scheduled_at quando next_run_at está vazio', () => {
    expect(blocoDoLembrete(lembrete({ scheduled_at: '2026-08-06T10:00:00.000Z' }), T)).toBe('amanha');
  });
});

describe('agruparLembretes', () => {
  it('ordena blocos por urgência e não cria cabeçalho vazio', () => {
    const g = agruparLembretes(
      [
        lembrete({ id: 'depois', next_run_at: '2026-09-01T10:00:00.000Z' }),
        lembrete({ id: 'atrasado', next_run_at: '2026-08-05T10:00:00.000Z' }),
        lembrete({ id: 'hoje', next_run_at: '2026-08-05T22:00:00.000Z' }),
      ],
      T,
    );
    expect(g.map((x) => x.bloco)).toEqual(['atrasado', 'hoje', 'depois']);
    // 'amanha' e 'semana' não existem nesta lista → nenhum cabeçalho órfão.
    expect(g).toHaveLength(3);
  });

  it('dentro do bloco, o mais cedo primeiro', () => {
    const g = agruparLembretes(
      [
        lembrete({ id: 'tarde', next_run_at: '2026-08-05T23:00:00.000Z' }),
        lembrete({ id: 'cedo', next_run_at: '2026-08-05T20:00:00.000Z' }),
      ],
      T,
    );
    expect(g[0]!.lembretes.map((r) => r.id)).toEqual(['cedo', 'tarde']);
  });

  it('nos encerrados, o mais recente primeiro', () => {
    // O paciente acabou de confirmar: ele espera ver a confirmação no topo do bloco.
    const g = agruparLembretes(
      [
        lembrete({ id: 'antigo', status: 'acknowledged', next_run_at: '2026-08-01T10:00:00.000Z' }),
        lembrete({ id: 'recente', status: 'acknowledged', next_run_at: '2026-08-04T10:00:00.000Z' }),
      ],
      T,
    );
    expect(g[0]!.lembretes.map((r) => r.id)).toEqual(['recente', 'antigo']);
  });
});

describe('acoesDisponiveis', () => {
  it('cancelado não aceita nada — é terminal no servidor', () => {
    expect(acoesDisponiveis(lembrete({ status: 'cancelled' }))).toEqual([]);
  });

  it('confirmado avulso encerra; confirmado RECORRENTE segue acionável', () => {
    expect(acoesDisponiveis(lembrete({ status: 'acknowledged' }))).toEqual([]);
    expect(acoesDisponiveis(lembrete({ status: 'acknowledged', rrule: 'FREQ=DAILY;BYHOUR=8' }))).toEqual([
      'done',
      'snooze',
      'cancel',
    ]);
  });
});

describe('lembreteOtimista — o eco tem que ser o que o servidor VAI decidir', () => {
  it('recorrente confirmado volta PENDENTE com a próxima data, não "concluído"', () => {
    const r = lembrete({ rrule: 'FREQ=DAILY;BYHOUR=8;BYMINUTE=0', next_run_at: '2026-08-05T11:00:00.000Z' });
    const otimista = lembreteOtimista(r, 'done', undefined, T)!;

    // Marcar `acknowledged` aqui mataria a recorrência — e a tela mostraria por um
    // segundo um remédio "concluído" que voltaria a pendente na resposta.
    expect(otimista.status).toBe('pending');
    expect(otimista.next_run_at).not.toBe(r.next_run_at);
    expect(otimista.last_confirmed_at).toBeTruthy();
  });

  it('avulso confirmado fica acknowledged e grava last_confirmed_at', () => {
    const otimista = lembreteOtimista(lembrete(), 'done', undefined, T)!;
    expect(otimista.status).toBe('acknowledged');
    // `last_confirmed_at` é o que destrava o gate do backup condicional (migration 0020).
    expect(otimista.last_confirmed_at).toBe(new Date(T).toISOString());
  });

  it('adiar empurra exatamente os minutos pedidos', () => {
    const otimista = lembreteOtimista(lembrete(), 'snooze', 45, T)!;
    expect(otimista.status).toBe('pending');
    expect(Date.parse(otimista.next_run_at!)).toBe(T + 45 * 60_000);
  });

  it('ação que o servidor RECUSARIA devolve null — a tela não finge ter feito nada', () => {
    // Otimismo que aplica o que o servidor vai rejeitar é pior que nenhum otimismo:
    // a linha pisca e volta.
    expect(lembreteOtimista(lembrete({ status: 'cancelled' }), 'done', undefined, T)).toBeNull();
    expect(lembreteOtimista(lembrete({ status: 'cancelled' }), 'snooze', 30, T)).toBeNull();
    // Cancelar de novo é aceito (idempotência barata — o paciente tocou duas vezes).
    expect(lembreteOtimista(lembrete({ status: 'cancelled' }), 'cancel', undefined, T)?.status).toBe('cancelled');
  });

  it('não muta o lembrete de origem', () => {
    const r = lembrete();
    lembreteOtimista(r, 'done', undefined, T);
    expect(r.status).toBe('pending');
    expect(r.last_confirmed_at).toBeNull();
  });
});

describe('fraseDaAcao', () => {
  it('recorrente NÃO é anunciado como concluído', () => {
    // "Concluído" num remédio de todo dia sugere que acabou o tratamento.
    expect(fraseDaAcao(lembrete({ rrule: 'FREQ=DAILY' }), 'done', undefined)).toContain('o de hoje');
    expect(fraseDaAcao(lembrete(), 'done', undefined)).toContain('feito');
  });

  it('adiar diz o tempo real, inclusive quando é o padrão', () => {
    expect(fraseDaAcao(lembrete(), 'snooze', 45)).toContain('45');
    expect(fraseDaAcao(lembrete(), 'snooze', undefined)).toContain('30');
  });
});
