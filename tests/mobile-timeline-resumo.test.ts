import { describe, it, expect } from 'vitest';
import {
  DIAS_ATE_ESFRIAR,
  atividadeDeConsulta,
  atividadeDePedido,
  desdeNoPassado,
  montarAtividades,
  resumoDaAtividade,
} from '../apps/mobile/src/features/activity/timeline.js';
import { brDesde } from '../apps/mobile/src/lib/br-format.js';
import type { Consultation, Order, Quote } from '../apps/mobile/src/features/health/overview.js';

/**
 * O desfecho, a ação e a frase de estado — as três derivações que esta sessão somou à
 * timeline, e que existem por defeitos vistos na tela:
 *
 * 1. A frase "Nada em andamento no momento" ficava DEPOIS da pilha de encerrados. Quem
 *    abria via uma tela cheia de cartões e só descobria no fim que nada estava ativo.
 * 2. Encerrado era cartão completo de quatro etapas em `opacity: 0.6` — até quinze
 *    paredes de passos mortos na frente do único item que pede ação. Virar linha exige
 *    saber o desfecho em uma palavra, e o desfecho não pode ser deduzido na tela.
 * 3. `resumo` dizia "me chama no chat" em dois estados: o app empurrava pro paciente uma
 *    redação que ele pode errar em silêncio. Agora existe `acao`, com a mensagem pronta.
 */

/** "Agora" fixo dos testes: 05/08/2026, 11:30 BRT. */
const NOW = Date.parse('2026-08-05T14:30:00.000Z');
const VELHO = new Date(NOW - (DIAS_ATE_ESFRIAR + 5) * 86_400_000).toISOString();

function pedido(over: Partial<Order> = {}): Order {
  return {
    id: 'o1',
    status: 'pending',
    items: ['Losartana 50mg'],
    created_at: '2026-08-04T10:00:00.000Z',
    updated_at: '2026-08-04T10:00:00.000Z',
    ...over,
  };
}

function oferta(over: Partial<Quote> = {}): Quote {
  return { id: 'q1', status: 'quoted', total: 42.9, ...over };
}

function consulta(over: Partial<Consultation> = {}): Consultation {
  return { id: 'c1', status: 'pending', created_at: '2026-08-04T10:00:00.000Z', ...over };
}

describe('desfecho — o que faz um encerrado caber numa linha', () => {
  it('vivo NÃO tem desfecho', () => {
    expect(atividadeDePedido(pedido(), NOW).desfecho).toBeNull();
    expect(atividadeDeConsulta(consulta(), NOW).desfecho).toBeNull();
  });

  it('cada fim tem a sua palavra, e o tom não chama fracasso de sucesso', () => {
    expect(atividadeDePedido(pedido({ status: 'delivered' }), NOW).desfecho).toEqual({
      rotulo: 'entregue',
      tom: 'success',
    });
    // `handed_off` não é fracasso nem entrega nossa: a nossa perna acabou.
    expect(atividadeDePedido(pedido({ status: 'handed_off' }), NOW).desfecho).toEqual({
      rotulo: 'seguiu com a farmácia',
      tom: 'neutral',
    });
    expect(atividadeDePedido(pedido({ status: 'cancelled' }), NOW).desfecho?.tom).toBe('warn');
    expect(atividadeDeConsulta(consulta({ status: 'completed' }), NOW).desfecho).toEqual({
      rotulo: 'realizada',
      tom: 'success',
    });
  });

  it('esfriado ganha desfecho mesmo com status legítimo', () => {
    // Sem isso a linha do encerrado ficaria sem palavra nenhuma — e o item esfriado é
    // justamente o que mais precisa dizer por que parou de se anunciar como presente.
    const a = atividadeDePedido(pedido({ updated_at: VELHO }), NOW);
    expect(a.viva).toBe(false);
    expect(a.desfecho).toEqual({ rotulo: 'ficou parado', tom: 'warn' });
  });
});

describe('acao — o app faz, não pede que o paciente faça', () => {
  it('com oferta esperando, a ação leva às opções (não manda mensagem)', () => {
    const a = atividadeDePedido(pedido({ quotes: [oferta()] }), NOW);
    expect(a.esperandoVoce).toBe(true);
    expect(a.acao).toEqual({ tipo: 'responder', rotulo: 'Ver as opções' });
  });

  it('esfriado oferece retomar COM o pedido pronto — e o resumo não manda ninguém pro chat', () => {
    const a = atividadeDePedido(pedido({ updated_at: VELHO }), NOW);
    expect(a.acao?.tipo).toBe('retomar');
    if (a.acao?.tipo === 'retomar') {
      expect(a.acao.mensagem).toBe('Ainda preciso de Losartana 50mg. Pode retomar?');
    }
    expect(a.resumo).not.toContain('chat');
  });

  it('consulta esfriada usa a especialidade na mensagem, e sem ela não inventa uma', () => {
    const comEsp = atividadeDeConsulta(consulta({ specialty: 'cardiologia', created_at: VELHO }), NOW);
    if (comEsp.acao?.tipo === 'retomar') {
      expect(comEsp.acao.mensagem).toBe('Ainda quero a consulta de cardiologia. Pode retomar?');
    }
    const semEsp = atividadeDeConsulta(consulta({ created_at: VELHO }), NOW);
    if (semEsp.acao?.tipo === 'retomar') {
      expect(semEsp.acao.mensagem).toBe('Ainda quero marcar aquela consulta. Pode retomar?');
    }
    expect(semEsp.resumo).not.toContain('chat');
  });

  it('encerrado NÃO oferece ação — nem retomar, nem responder', () => {
    // "Ainda preciso" num pedido entregue reabriria uma cotação já resolvida.
    for (const status of ['delivered', 'handed_off', 'cancelled', 'failed', 'expired']) {
      expect(atividadeDePedido(pedido({ status }), NOW).acao).toBeNull();
    }
    expect(atividadeDeConsulta(consulta({ status: 'completed' }), NOW).acao).toBeNull();
  });

  it('consulta agendada não pede nada: o horário está marcado', () => {
    const a = atividadeDeConsulta(
      consulta({ scheduled_at: '2026-08-26T13:00:00.000Z', consultation_quotes: [] }),
      NOW,
    );
    expect(a.viva).toBe(true);
    expect(a.acao).toBeNull();
  });
});

/**
 * A consulta agendada — o único item agendado que existe em produção (26/08 às 10h).
 *
 * Dois defeitos vistos no cartão dela, e os dois eram sobre TEMPO:
 *
 * 1. A etapa dizia "Horário confirmado" e mais nada. Data, hora e clínica estavam nas
 *    mãos da função e nenhuma chegava à tela — um cartão que afirma estar tudo certo e
 *    não diz quando é a coisa menos acionável que a aba podia mostrar.
 * 2. `atualizadoEm` recebia o `scheduled_at`, que é FUTURO. `brDesde` devolve 'agora'
 *    pra qualquer diferença abaixo de um minuto (inclusive negativa — é a guarda de
 *    relógio adiantado), então o cartão dizia "atualizado agora" por três semanas
 *    seguidas. Status legítimo + tempo demais = mentira.
 */
describe('consulta agendada — diz QUANDO, e não mente sobre o presente', () => {
  /** 26/08/2026 às 10:00 BRT — a primeira consulta agendada da história do sistema. */
  const AGENDADA = '2026-08-26T13:00:00.000Z';

  function marcada(over: Partial<Consultation> = {}): Consultation {
    return consulta({ status: 'confirming', specialty: 'cardiologia', scheduled_at: AGENDADA, ...over });
  }

  it('a etapa "escolha" carrega o dia, a hora e a clínica escolhida', () => {
    const a = atividadeDeConsulta(
      marcada({
        consultation_quotes: [
          {
            id: 'q1',
            status: 'selected',
            price_brl: 950,
            proposed_datetime: AGENDADA,
            clinics: { id: 'cl1', name: 'Clínica do Setor Oeste' },
          },
          { id: 'q2', status: 'rejected', price_brl: 700, clinics: { id: 'cl2', name: 'Outra clínica' } },
        ],
      }),
      NOW,
    );
    const escolha = a.etapas.find((e) => e.chave === 'escolha')!;
    expect(escolha.estado).toBe('feito');
    expect(escolha.detalhe).toContain('10:00');
    expect(escolha.detalhe).toContain('26/08');
    expect(escolha.detalhe).toContain('Clínica do Setor Oeste');
  });

  it('a proposta escolhida também é reconhecida pelo instante marcado', () => {
    // Linha antiga cujo `status` nunca virou 'selected': `tool-executor-v2` grava
    // `scheduled_at = q.proposed_datetime` no mesmo passo, então a igualdade é fato.
    const a = atividadeDeConsulta(
      marcada({
        consultation_quotes: [
          { id: 'q1', price_brl: 950, proposed_datetime: AGENDADA, clinics: { id: 'cl1', name: 'Clínica Norte' } },
        ],
      }),
      NOW,
    );
    expect(a.etapas.find((e) => e.chave === 'escolha')!.detalhe).toContain('Clínica Norte');
  });

  it('sem proposta identificável, diz o horário e NÃO inventa clínica', () => {
    const a = atividadeDeConsulta(marcada({ consultation_quotes: [] }), NOW);
    expect(a.etapas.find((e) => e.chave === 'escolha')!.detalhe).toBe('qua, 26/08 às 10:00');
  });

  it('a etapa "consulta" conta quanto falta — e nunca conta pra trás', () => {
    expect(atividadeDeConsulta(marcada(), NOW).etapas.find((e) => e.chave === 'consulta')!.detalhe).toBe(
      'faltam 21 dias',
    );
    // Hora já passada e ninguém fechou: sem contagem, jamais "faltam -2 dias".
    const passada = atividadeDeConsulta(marcada({ scheduled_at: '2026-08-03T13:00:00.000Z' }), NOW);
    expect(passada.etapas.find((e) => e.chave === 'consulta')!.detalhe).toBeUndefined();
  });

  it('`atualizadoEm` é fato do PASSADO — nada de "atualizado agora" por três semanas', () => {
    const daquiA7Dias = new Date(NOW + 7 * 86_400_000).toISOString();
    const a = atividadeDeConsulta(marcada({ scheduled_at: daquiA7Dias }), NOW);

    expect(a.atualizadoEm).toBe('2026-08-04T10:00:00.000Z');
    expect(a.agendadoPara).toBe(daquiA7Dias);
    // O rótulo que o cartão imprime: era 'agora', agora é a idade real do pedido.
    expect(brDesde(a.atualizadoEm, NOW)).not.toBe('agora');
    expect(brDesde(a.atualizadoEm, NOW)).toBe('ontem');
  });

  it('o cinto duplo: carimbo declaradamente futuro não vira rótulo nenhum', () => {
    const futuro = new Date(NOW + 7 * 86_400_000).toISOString();
    // `brDesde` cru continua dizendo 'agora' — é a guarda de relógio adiantado dele.
    expect(brDesde(futuro, NOW)).toBe('agora');
    // O que a tela usa recusa o futuro declarado: rótulo vazio o layout absorve.
    expect(desdeNoPassado(futuro, NOW)).toBe('');
    expect(desdeNoPassado('2026-08-04T10:00:00.000Z', NOW)).toBe('ontem');
    expect(desdeNoPassado(null, NOW)).toBe('');
  });

  it('o compromisso marcado sobe entre os vivos — mas "sua vez" continua no topo', () => {
    const so = montarAtividades(
      [pedido({ id: 'novo', updated_at: '2026-08-05T13:00:00.000Z' })],
      [marcada({ id: 'marcada' })],
      NOW,
    );
    // Sem a regra explícita, 'novo' venceria por ter mexido há 1h30 — e a consulta só
    // ganhava antes porque carregava um carimbo do futuro em `atualizadoEm`.
    expect(so.map((a) => a.id)).toEqual(['marcada', 'novo']);

    const comPendencia = montarAtividades(
      [pedido({ id: 'sua-vez', quotes: [oferta()] })],
      [marcada({ id: 'marcada' })],
      NOW,
    );
    expect(comPendencia[0]?.id).toBe('sua-vez');
  });
});

describe('resumoDaAtividade — a frase de estado, que vem ANTES da lista', () => {
  it('o que espera o PACIENTE domina a frase', () => {
    const lista = montarAtividades(
      [pedido({ quotes: [oferta()] }), pedido({ id: 'o2', status: 'pending' })],
      [],
      NOW,
    );
    const r = resumoDaAtividade(lista);
    expect(r.precisaDeVoce).toBe(1);
    expect(r.frase).toBe('Uma coisa está esperando você');
  });

  it('duas ou mais pendências falam no plural', () => {
    const lista = montarAtividades(
      [pedido({ quotes: [oferta()] }), pedido({ id: 'o2', quotes: [oferta({ id: 'q2' })] })],
      [],
      NOW,
    );
    expect(resumoDaAtividade(lista).frase).toBe('2 coisas estão esperando você');
  });

  it('sem pendência mas com trabalho em curso, ela diz o que está em curso', () => {
    const lista = montarAtividades([pedido()], [consulta()], NOW);
    const r = resumoDaAtividade(lista);
    expect(r.vivas).toBe(2);
    expect(r.precisaDeVoce).toBe(0);
    expect(r.frase).toBe('Estou cuidando de 2 coisas agora');
  });

  it('SÓ histórico morto diz "nada em andamento" — o caso que ficava invisível', () => {
    const lista = montarAtividades([pedido({ status: 'delivered' }), pedido({ id: 'o2', status: 'cancelled' })], [], NOW);
    const r = resumoDaAtividade(lista);
    expect(r.vivas).toBe(0);
    expect(r.encerradas).toBe(2);
    expect(r.frase).toBe('Nada em andamento agora');
  });

  it('lista vazia não quebra a frase', () => {
    expect(resumoDaAtividade([])).toEqual({
      frase: 'Nada em andamento agora',
      precisaDeVoce: 0,
      vivas: 0,
      encerradas: 0,
    });
  });
});
