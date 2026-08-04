import { describe, it, expect } from 'vitest';
import { parseBrDateTimes, pickFutureBrDateTimes, foldPt } from '../packages/shared/src/br-datetime.js';
import {
  readClinicSlotMessage,
  isBareAffirmation,
  resolveCommittedSlot,
  sameSlot,
} from '../packages/shared/src/appointment-commit.js';

/**
 * Blinda a leitura determinística de data/hora e a classificação oferta-vs-fechamento.
 *
 * Todos os textos deste arquivo são MENSAGENS REAIS da recepção (Rita, consultório do
 * Dr. Rafael Navarrete) e do paciente (Ciro), capturadas em produção em 03/08/2026. Nos
 * dois momentos decisivos daquela negociação o LLM do agente-clínica voltou
 * COMPLETAMENTE vazio — sem texto e sem tool — e o sistema não tinha caminho nenhum de
 * código pra ler o que estava escrito em português na tela:
 *
 *   15:14 "Eu tenho um horário disponível amanhã às 08:30, na quarta feira ás 10 horas
 *          ou então na quinta feira ás 08 horas"          → 3 ofertas, 0 registradas
 *   18:20 "Ficou então para o dia 26/08 quarta feira ás 10 horas, obrigada"
 *                                                          → confirmação, 0 registrada
 *
 * A segunda é a confirmação da PRIMEIRA consulta agendada da história do produto. Quem
 * a registrou foi um humano no terminal.
 */

// Segunda-feira, 03/08/2026, 12:14 em Brasília (15:14Z) — o instante real da mensagem.
const SEG_03_08 = Date.parse('2026-08-03T15:14:00Z');
// O mesmo dia, 15:20 BRT (18:20Z) — o instante real da confirmação.
const SEG_03_08_TARDE = Date.parse('2026-08-03T18:20:00Z');

/** Data/hora local de Brasília de um ISO, pra asserção legível. */
function br(iso: string): string {
  return new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
  }).format(new Date(iso));
}

describe('âncora de referência', () => {
  it('03/08/2026 é segunda-feira (base de todos os casos deste arquivo)', () => {
    const dow = new Date('2026-08-03T12:00:00-03:00').getUTCDay();
    expect(dow).toBe(1);
  });

  it('26/08/2026 é quarta-feira — a Rita e o Ciro estavam certos', () => {
    const dow = new Date('2026-08-26T12:00:00-03:00').getUTCDay();
    expect(dow).toBe(3);
  });
});

describe('parseBrDateTimes — os 3 horários REAIS da Rita', () => {
  const MSG = 'Eu tenho um horário disponível amanhã às 08:30, na quarta feira ás 10 horas ou então na quinta feira ás 08 horas';

  it('extrai os TRÊS horários, na ordem, com as datas certas', () => {
    const hits = parseBrDateTimes(MSG, SEG_03_08);
    expect(hits.map((h) => br(h.iso))).toEqual([
      '04/08/2026, 08:30', // "amanhã às 08:30"     → terça
      '05/08/2026, 10:00', // "na quarta feira ás 10 horas"
      '06/08/2026, 08:00', // "na quinta feira ás 08 horas"
    ]);
  });

  it('cada hit carrega a evidência do texto (nada inventado)', () => {
    const hits = parseBrDateTimes(MSG, SEG_03_08);
    expect(hits[0]?.evidence).toContain('amanhã');
    expect(hits[1]?.evidence.toLowerCase()).toContain('quarta');
    expect(hits[2]?.evidence.toLowerCase()).toContain('quinta');
  });
});

describe('parseBrDateTimes — 🔴 o REFORÇO de dia da semana sobre data exata', () => {
  it('"dia 26/08 quarta feira ás 10 horas" é 26/08 — NÃO a próxima quarta', () => {
    const hits = parseBrDateTimes('Ficou então para o dia 26/08 quarta feira ás 10 horas, obrigada', SEG_03_08_TARDE);
    expect(hits).toHaveLength(1);
    expect(br(hits[0]!.iso)).toBe('26/08/2026, 10:00');
  });

  it('a mensagem do PACIENTE ("Marca dia 26 quarta feira as 10") também dá 26/08', () => {
    const hits = parseBrDateTimes('Vou sair de viagem, não vai dar tempo.\nMarca dia 26 quarta feira as 10', SEG_03_08_TARDE);
    expect(hits).toHaveLength(1);
    expect(br(hits[0]!.iso)).toBe('26/08/2026, 10:00');
  });

  it('ordem invertida ("quarta feira dia 26/08 às 10h") dá o mesmo resultado', () => {
    const hits = parseBrDateTimes('quarta feira dia 26/08 às 10h', SEG_03_08_TARDE);
    expect(br(hits[0]!.iso)).toBe('26/08/2026, 10:00');
  });

  it('dia da semana SOZINHO segue valendo (não quebrou o caso simples)', () => {
    const hits = parseBrDateTimes('pode ser na quarta às 10h', SEG_03_08_TARDE);
    expect(br(hits[0]!.iso)).toBe('05/08/2026, 10:00');
  });
});

describe('parseBrDateTimes — formatos que a recepção usa de verdade', () => {
  it.each([
    ['amanhã às 8h', '04/08/2026, 08:00'],
    ['hoje às 16:30', '03/08/2026, 16:30'],
    ['depois de amanhã às 9h', '05/08/2026, 09:00'],
    ['dia 26/08 às 10h', '26/08/2026, 10:00'],
    ['26/08 as 14', '26/08/2026, 14:00'],
    ['dia 26 de agosto às 10:15', '26/08/2026, 10:15'],
    ['26/08/2026 às 7h45', '26/08/2026, 07:45'],
    ['sexta 9h30', '07/08/2026, 09:30'],
    ['no sábado às 8 horas', '08/08/2026, 08:00'],
  ])('"%s" → %s', (texto, esperado) => {
    const hits = parseBrDateTimes(texto, SEG_03_08_TARDE);
    expect(br(hits[0]!.iso)).toBe(esperado);
  });

  it('"quarta" numa quarta-feira significa HOJE (não semana que vem)', () => {
    const quarta = Date.parse('2026-08-05T11:00:00Z'); // 08:00 BRT, quarta
    const hits = parseBrDateTimes('quarta às 15h', quarta);
    expect(br(hits[0]!.iso)).toBe('05/08/2026, 15:00');
  });

  it('data sem ano perto da virada não cai no ano que já passou', () => {
    const janeiro = Date.parse('2027-01-10T12:00:00Z');
    const hits = parseBrDateTimes('dia 26/08 às 10h', janeiro);
    expect(br(hits[0]!.iso)).toBe('26/08/2027, 10:00');
  });
});

describe('parseBrDateTimes — 🔴 o que NÃO pode virar horário', () => {
  it('a mensagem de PREÇO real da Rita não produz data nenhuma', () => {
    const preco = 'A consulta está 950,00 no dinheiro ou pix e 1.000,00 no cartão, parcelado em até 5x \nA consulta inclui retorno em até 30 días';
    expect(parseBrDateTimes(preco, SEG_03_08_TARDE)).toEqual([]);
  });

  it.each([
    'Ele já e paciente do dr Rafael',
    'Qual o nome do paciente pra mim pegar o prontuário dele por favor',
    'Ele consultou aqui no setor oeste, Goiânia',
    'Nunca veio aqui não, vou te passar o valor da consulta pra você',
    'Ok',
    'Eu que agradeço, boa tarde',
  ])('"%s" → nenhuma data', (texto) => {
    expect(parseBrDateTimes(texto, SEG_03_08_TARDE)).toEqual([]);
  });

  it('hora SEM nenhuma âncora de data não é adivinhada', () => {
    expect(parseBrDateTimes('pode ser às 10h?', SEG_03_08_TARDE)).toEqual([]);
  });

  it('"a segunda opção" é ordinal, não segunda-feira', () => {
    expect(parseBrDateTimes('a segunda opção serve às 10h', SEG_03_08_TARDE)).toEqual([]);
  });

  it('31/02 não faz rollover silencioso pra março', () => {
    expect(parseBrDateTimes('dia 31/02 às 10h', SEG_03_08_TARDE)).toEqual([]);
  });
});

describe('pickFutureBrDateTimes', () => {
  it('descarta o que já passou e mantém o que está por vir', () => {
    const hits = pickFutureBrDateTimes('tenho hoje às 08:00 ou amanhã às 08:00', SEG_03_08_TARDE);
    expect(hits.map((h) => br(h.iso))).toEqual(['04/08/2026, 08:00']);
  });
});

describe('readClinicSlotMessage — oferta vs fechamento', () => {
  it('🔴 a confirmação REAL da Rita é COMMITMENT com o horário certo', () => {
    const r = readClinicSlotMessage('Ficou então para o dia 26/08 quarta feira ás 10 horas, obrigada', SEG_03_08_TARDE);
    expect(r.kind).toBe('commitment');
    expect(r.needsAnchor).toBe(false);
    expect(br(r.datetimes[0]!.iso)).toBe('26/08/2026, 10:00');
  });

  it('🔴 a mensagem de 3 horários da Rita é OFFER — nunca fechamento', () => {
    const r = readClinicSlotMessage('Eu tenho um horário disponível amanhã às 08:30, na quarta feira ás 10 horas ou então na quinta feira ás 08 horas', SEG_03_08);
    expect(r.kind).toBe('offer');
    expect(r.datetimes).toHaveLength(3);
  });

  it.each([
    'Está agendado para o dia 26/08 às 10h',
    'Marquei pra quarta às 10h',
    'Consegui encaixar amanhã às 8h30',
    'Reservado dia 26/08 às 10 horas',
    'Fechado pra quinta às 8h, pode vir',
  ])('fechamento: "%s"', (texto) => {
    expect(readClinicSlotMessage(texto, SEG_03_08_TARDE).kind).toBe('commitment');
  });

  it.each([
    'Teria horário amanhã às 8h30?',
    'Tenho vaga na quarta às 10h',
    'Pode ser dia 26/08 às 10h?',
    'Temos disponibilidade quinta às 8 horas',
    'Marcamos pra quarta às 10h?',
  ])('oferta/pergunta (NÃO fecha): "%s"', (texto) => {
    expect(readClinicSlotMessage(texto, SEG_03_08_TARDE).kind).toBe('offer');
  });

  it('fechamento SEM data no texto pede âncora', () => {
    const r = readClinicSlotMessage('Confirmado! Já deixei reservado.', SEG_03_08_TARDE);
    expect(r.kind).toBe('commitment');
    expect(r.needsAnchor).toBe(true);
  });

  it('"está 950,00 no dinheiro" não é "está marcado"', () => {
    const r = readClinicSlotMessage('A consulta está 950,00 no dinheiro ou pix', SEG_03_08_TARDE);
    expect(r.kind).toBe('neither');
  });
});

describe('isBareAffirmation — o "Ok" das 18:21 não pode fechar consulta sozinho', () => {
  it.each(['Ok', 'ok', 'Isso', 'isso mesmo', 'Sim', 'Perfeito', 'Beleza', 'Tudo bem'])('"%s" é afirmação seca', (t) => {
    expect(isBareAffirmation(t)).toBe(true);
  });

  it.each([
    'Ficou então para o dia 26/08 quarta feira ás 10 horas, obrigada',
    'Ok, mas o Dr. Rafael não atende nesse horário',
    '',
  ])('"%s" NÃO é afirmação seca', (t) => {
    expect(isBareAffirmation(t)).toBe(false);
  });

  it('afirmação seca isolada não é classificada como fechamento', () => {
    expect(readClinicSlotMessage('Ok', SEG_03_08_TARDE).kind).toBe('neither');
  });
});

describe('resolveCommittedSlot', () => {
  const NA_MESA = ['2026-08-26T13:00:00.000Z'];

  it('prefere a data do texto que CASA com o slot que estava na mesa', () => {
    const r = readClinicSlotMessage('Ficou então para o dia 26/08 quarta feira ás 10 horas', SEG_03_08_TARDE);
    expect(resolveCommittedSlot(r, NA_MESA, null)).toEqual({
      iso: '2026-08-26T13:00:00.000Z',
      source: 'text-matched',
    });
  });

  it('data no texto que não casa com nada vale como NOVA', () => {
    const r = readClinicSlotMessage('Ficou então para o dia 27/08 às 10 horas', SEG_03_08_TARDE);
    expect(resolveCommittedSlot(r, NA_MESA, null)?.source).toBe('text-new');
  });

  it('fechamento sem data usa a âncora — nunca inventa horário', () => {
    const r = readClinicSlotMessage('Confirmado, está reservado!', SEG_03_08_TARDE);
    expect(resolveCommittedSlot(r, NA_MESA, NA_MESA[0])).toEqual({
      iso: NA_MESA[0],
      source: 'anchor',
    });
  });

  it('sem data e sem âncora devolve null (não chuta)', () => {
    const r = readClinicSlotMessage('Confirmado, está reservado!', SEG_03_08_TARDE);
    expect(resolveCommittedSlot(r, [], null)).toBeNull();
  });

  it('oferta NUNCA produz slot confirmado', () => {
    const r = readClinicSlotMessage('Tenho vaga dia 26/08 às 10h', SEG_03_08_TARDE);
    expect(resolveCommittedSlot(r, NA_MESA, NA_MESA[0])).toBeNull();
  });
});

describe('sameSlot / foldPt', () => {
  it('tolera segundos de diferença entre caminhos', () => {
    expect(sameSlot('2026-08-26T13:00:00Z', '2026-08-26T13:00:30Z')).toBe(true);
    expect(sameSlot('2026-08-26T13:00:00Z', '2026-08-26T14:00:00Z')).toBe(false);
    expect(sameSlot(null, '2026-08-26T13:00:00Z')).toBe(false);
    expect(sameSlot('lixo', '2026-08-26T13:00:00Z')).toBe(false);
  });

  it('foldPt dobra acento e caixa', () => {
    expect(foldPt('Ás 10 HORAS, terça-feira')).toBe('as 10 horas, terca-feira');
  });
});
