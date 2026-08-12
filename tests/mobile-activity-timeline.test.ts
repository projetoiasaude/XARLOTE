import { describe, it, expect } from 'vitest';
import {
  DIAS_ATE_ESFRIAR,
  atividadeDeConsulta,
  atividadeDePedido,
  montarAtividades,
} from '../apps/mobile/src/features/activity/timeline.js';
import type { Consultation, Order, Quote } from '../apps/mobile/src/features/health/overview.js';

/**
 * A timeline de Atividade.
 *
 * Duas regras que este arquivo protege, e as duas nasceram de ver a tela com dado real:
 *
 * 1. **Nenhuma etapa é marcada como feita por dedução otimista.** A auditoria de 04/08
 *    achou 18 consultas `failed` e UMA `scheduled` — se a tela pintasse "temos
 *    propostas" como "está agendado", mostraria dezoito consultas marcadas inexistentes.
 *
 * 2. **Nenhum número é inflado, e nada velho se anuncia como presente.** Em 12/08 a tela
 *    dizia "10 farmácias responderam" (a maioria era `timeout` — ninguém respondeu) e
 *    marcava pedidos de JULHO como "em andamento · A caminho".
 */

/** "Agora" fixo dos testes: 05/08/2026, 11:30 BRT. */
const NOW = Date.parse('2026-08-05T14:30:00.000Z');

function pedido(over: Partial<Order> = {}): Order {
  return {
    id: 'o1',
    status: 'pending',
    items: null,
    created_at: '2026-08-04T10:00:00.000Z',
    updated_at: '2026-08-04T10:00:00.000Z',
    ...over,
  };
}

/** Farmácia que respondeu COM preço — a única que conta como oferta. */
function oferta(over: Partial<Quote> = {}): Quote {
  return { id: 'q1', status: 'quoted', total: 42.9, ...over };
}

/** Farmácia que nunca respondeu. 187 destas no banco, contra 16 respondidas. */
function semResposta(over: Partial<Quote> = {}): Quote {
  return { id: 'qt', status: 'timeout', total: null, ...over };
}

function consulta(over: Partial<Consultation> = {}): Consultation {
  return { id: 'c1', status: 'pending', created_at: '2026-08-04T10:00:00.000Z', ...over };
}

const etapa = (a: ReturnType<typeof atividadeDePedido>, chave: string) =>
  a.etapas.find((e) => e.chave === chave)!;

describe('atividadeDePedido', () => {
  it('sem cotação, "consultando farmácias" está ACONTECENDO — não feito', () => {
    const a = atividadeDePedido(pedido(), NOW);
    expect(etapa(a, 'cotando').estado).toBe('agora');
    expect(etapa(a, 'escolha').estado).toBe('esperando');
    expect(a.viva).toBe(true);
    expect(a.esperandoVoce).toBe(false);
  });

  it('com oferta e sem escolha, a bola está com o PACIENTE', () => {
    const a = atividadeDePedido(
      pedido({ quotes: [oferta({ suppliers: { id: 's1', name: 'Drogasil Centro' } })] }),
      NOW,
    );
    expect(etapa(a, 'cotando').estado).toBe('feito');
    expect(etapa(a, 'escolha').estado).toBe('esperando');
    expect(a.esperandoVoce).toBe(true);
    // O detalhe mostra preço e farmácia REAIS — é o que faz o paciente decidir.
    expect(etapa(a, 'cotando').detalhe).toContain('Drogasil Centro');
    expect(etapa(a, 'cotando').detalhe).toContain('42,90');
  });

  it('cotação em TIMEOUT não conta como resposta', () => {
    // A frase que a tela mostrava — "10 farmácias responderam" — com nove `timeout`.
    const a = atividadeDePedido(
      pedido({
        quotes: [
          oferta({ id: 'q1', total: 30, suppliers: { id: 's1', name: 'Respondeu' } }),
          semResposta({ id: 'q2' }),
          semResposta({ id: 'q3' }),
          semResposta({ id: 'q4' }),
        ],
      }),
      NOW,
    );
    expect(etapa(a, 'cotando').rotulo).toContain('1 de 4');
    // O que não pode voltar é a frase ABRIR com o total consultado, como se todas
    // tivessem respondido. `not.toContain('4 farmácias responderam')` seria errado —
    // "1 de 4 farmácias responderam" contém isso e está certo.
    expect(etapa(a, 'cotando').rotulo).not.toMatch(/^4 /);
  });

  it('farmácia que respondeu SEM ter o remédio é resposta, mas não é oferta', () => {
    const a = atividadeDePedido(
      pedido({ quotes: [{ id: 'q1', status: 'unavailable', total: null }, semResposta({ id: 'q2' })] }),
      NOW,
    );
    expect(etapa(a, 'cotando').rotulo).toContain('nenhuma tinha');
    expect(a.esperandoVoce).toBe(false);
  });

  it('ninguém respondeu e o pedido morreu → diz isso, não fica "consultando"', () => {
    const a = atividadeDePedido(
      pedido({ status: 'failed', quotes: [semResposta({ id: 'q1' }), semResposta({ id: 'q2' })] }),
      NOW,
    );
    expect(etapa(a, 'cotando').rotulo).toBe('Nenhuma das 2 farmácias respondeu');
    expect(etapa(a, 'cotando').estado).toBe('parado');
  });

  it('mostra a MAIS BARATA entre as ofertas', () => {
    const a = atividadeDePedido(
      pedido({
        quotes: [
          oferta({ id: 'q1', total: 80, suppliers: { id: 's1', name: 'Caro' } }),
          oferta({ id: 'q2', total: 30, suppliers: { id: 's2', name: 'Barato' } }),
        ],
      }),
      NOW,
    );
    expect(etapa(a, 'cotando').detalhe).toContain('Barato');
  });

  it('escolha feita move a entrega pra "agora" e sai do esperandoVoce', () => {
    const a = atividadeDePedido(
      pedido({
        selected_quote_id: 'q1',
        quotes: [oferta({ eta_minutes: 40, suppliers: { id: 's1', name: 'Drogasil' } })],
      }),
      NOW,
    );
    expect(etapa(a, 'escolha').estado).toBe('feito');
    expect(etapa(a, 'entrega').estado).toBe('agora');
    expect(etapa(a, 'entrega').detalhe).toContain('40 min');
    expect(a.esperandoVoce).toBe(false);
  });

  it('entregue fecha tudo e deixa de ser vivo', () => {
    const a = atividadeDePedido(pedido({ status: 'delivered' }), NOW);
    expect(etapa(a, 'entrega').estado).toBe('feito');
    expect(a.viva).toBe(false);
    expect(a.esperandoVoce).toBe(false);
  });

  it('handed_off é TERMINAL — sete pedidos de julho diziam "A caminho" por causa disso', () => {
    const a = atividadeDePedido(pedido({ status: 'handed_off' }), NOW);
    expect(a.viva).toBe(false);
    expect(etapa(a, 'entrega').rotulo).toBe('Seguiu com a farmácia');
    expect(etapa(a, 'entrega').estado).toBe('feito');
    expect(a.resumo).not.toContain('A caminho');
    // E não é fracasso: nossa perna acabou porque foi entregue à farmácia.
    expect(a.resumo).toContain('Passei pra farmácia');
  });

  it('cancelado NÃO desaparece e as etapas ficam "parado", não "feito"', () => {
    const a = atividadeDePedido(pedido({ status: 'cancelled' }), NOW);
    expect(a.viva).toBe(false);
    expect(etapa(a, 'cotando').estado).toBe('parado');
    expect(etapa(a, 'entrega').estado).toBe('parado');
    expect(a.resumo).toContain('não seguiu');
  });

  it('items em JSONB de formatos diferentes viram título legível', () => {
    expect(atividadeDePedido(pedido({ items: ['Losartana 50mg'] }), NOW).titulo).toBe('Losartana 50mg');
    expect(atividadeDePedido(pedido({ items: [{ name: 'Dipirona' }] }), NOW).titulo).toBe('Dipirona');
    // Formato desconhecido não deixa o cartão sem título.
    expect(atividadeDePedido(pedido({ items: { estranho: true } }), NOW).titulo).toBe('Pedido de medicamento');
    expect(atividadeDePedido(pedido({ items: null }), NOW).titulo).toBe('Pedido de medicamento');
  });
});

describe('esfriamento — nada velho se anuncia como presente', () => {
  const velho = new Date(NOW - (DIAS_ATE_ESFRIAR + 5) * 86_400_000).toISOString();

  it('pedido sem mexida há semanas para de ser "em andamento"', () => {
    const a = atividadeDePedido(
      pedido({ status: 'pending', updated_at: velho, selected_quote_id: 'q1', quotes: [oferta({ eta_minutes: 60 })] }),
      NOW,
    );
    expect(a.viva).toBe(false);
    expect(a.resumo).toContain('ficou parado');
    // E o "chega em cerca de 60 min" NÃO aparece num pedido de semanas atrás.
    expect(etapa(a, 'entrega').detalhe).toBeUndefined();
  });

  it('frio não vira "sua vez": a cobrança some junto com a promessa', () => {
    const a = atividadeDePedido(pedido({ updated_at: velho, quotes: [oferta()] }), NOW);
    expect(a.esperandoVoce).toBe(false);
  });

  it('recente segue vivo', () => {
    const a = atividadeDePedido(pedido({ updated_at: '2026-08-04T10:00:00.000Z' }), NOW);
    expect(a.viva).toBe(true);
  });

  it('sem carimbo de data NÃO se afirma que esfriou', () => {
    // Não saber quando algo mexeu não autoriza dizer que está parado.
    const a = atividadeDePedido(pedido({ created_at: null, updated_at: null }), NOW);
    expect(a.viva).toBe(true);
  });

  it('consulta AGENDADA nunca esfria — o horário é no futuro', () => {
    const a = atividadeDeConsulta(
      consulta({ status: 'scheduled', created_at: velho, scheduled_at: '2026-08-26T13:00:00.000Z' }),
      NOW,
    );
    expect(a.viva).toBe(true);
    expect(a.resumo).toContain('marcado');
  });

  it('busca de consulta sem desfecho esfria', () => {
    const a = atividadeDeConsulta(consulta({ created_at: velho }), NOW);
    expect(a.viva).toBe(false);
    expect(a.resumo).toContain('ficou parada');
  });
});

describe('atividadeDeConsulta', () => {
  it('propostas NÃO são desenhadas como agendamento', () => {
    const a = atividadeDeConsulta(
      consulta({
        specialty: 'ortopedia',
        consultation_quotes: [
          {
            id: 'q1',
            price_brl: 950,
            proposed_datetime: '2026-08-26T13:00:00.000Z',
            clinics: { id: 'k1', name: 'Setor Oeste' },
          },
        ],
      }),
      NOW,
    );
    expect(a.etapas.find((e) => e.chave === 'escolha')!.estado).toBe('esperando');
    expect(a.etapas.find((e) => e.chave === 'escolha')!.rotulo).not.toContain('confirmado');
    expect(a.esperandoVoce).toBe(true);
  });

  it('scheduled_at é a ÚNICA prova de horário marcado', () => {
    const a = atividadeDeConsulta(
      consulta({
        status: 'scheduled',
        scheduled_at: '2026-08-26T13:00:00.000Z',
        consultation_quotes: [{ id: 'q1', price_brl: 950 }],
      }),
      NOW,
    );
    expect(a.etapas.find((e) => e.chave === 'escolha')!.estado).toBe('feito');
    expect(a.etapas.find((e) => e.chave === 'consulta')!.estado).toBe('agora');
    expect(a.esperandoVoce).toBe(false);
    expect(a.resumo).toContain('marcado');
  });

  it('scheduled_at corrompido não conta como agendado', () => {
    const a = atividadeDeConsulta(consulta({ scheduled_at: 'não é data' }), NOW);
    expect(a.etapas.find((e) => e.chave === 'escolha')!.estado).toBe('esperando');
  });

  it('failed vira "parado", visível, sem virar sucesso', () => {
    const a = atividadeDeConsulta(consulta({ status: 'failed' }), NOW);
    expect(a.viva).toBe(false);
    expect(a.etapas.find((e) => e.chave === 'buscando')!.estado).toBe('parado');
    expect(a.etapas.find((e) => e.chave === 'buscando')!.rotulo).toBe('Nenhuma clínica respondeu');
  });
});

describe('montarAtividades — a ordem da tela', () => {
  it('vivo antes de encerrado, e "sua vez" no topo dos vivos', () => {
    const lista = montarAtividades(
      [
        pedido({ id: 'entregue', status: 'delivered', updated_at: '2026-08-05T10:00:00.000Z' }),
        pedido({ id: 'cotando', status: 'pending', updated_at: '2026-08-02T10:00:00.000Z' }),
        pedido({
          id: 'sua-vez',
          status: 'pending',
          updated_at: '2026-08-01T10:00:00.000Z',
          quotes: [oferta({ total: 10 })],
        }),
      ],
      [],
      NOW,
    );
    // 'sua-vez' é o MAIS ANTIGO dos vivos e ainda vem primeiro: espera decisão dele.
    expect(lista.map((a) => a.id)).toEqual(['sua-vez', 'cotando', 'entregue']);
  });

  it('mistura pedidos e consultas na mesma lista', () => {
    const lista = montarAtividades([pedido()], [consulta()], NOW);
    expect(lista).toHaveLength(2);
    expect(new Set(lista.map((a) => a.tipo))).toEqual(new Set(['order', 'consultation']));
  });

  it('listas vazias devolvem lista vazia', () => {
    expect(montarAtividades([], [], NOW)).toEqual([]);
  });
});
