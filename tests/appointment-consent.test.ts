/**
 * A consulta que a Duda achou que tinha — e não tinha.
 *
 * 24/08/2026, 15:48. A Duda entrou na Xarlote às 15:20 e pediu um gastro. Às 15:47 a
 * recepção da Dra Mayra mandou um horário junto das condições de pagamento. Trinta
 * segundos depois a Duda recebeu "Confirmado, Duda! 🎉" — sem nunca ter escolhido nada,
 * e logo após ler, da própria Xarlote, "vou aguardar mais umas pra te trazer as
 * melhores opções". Às 15:48:22 a clínica ainda perguntava "Vamos agendar?".
 *
 * Os textos abaixo são os REAIS da conversa (a clínica é um estabelecimento, não uma
 * paciente — nome da doutora preservado porque é o dado que prova o caso; nenhum dado
 * pessoal da paciente entra aqui). O "andiantamento" com erro de digitação está no
 * original e fica: é exatamente o tipo de coisa que um detector precisa aguentar.
 */
import { describe, it, expect } from 'vitest';
import {
  readClinicSlotMessage,
  resolveCommittedSlot,
  isBareAffirmation,
} from '../packages/shared/src/appointment-commit.js';
import {
  readBookingPreconditions,
  blocksReservation,
  describePreconditionsForPatient,
  valorDoSinal,
  valorEmReais,
  percentualDe,
} from '../packages/shared/src/booking-preconditions.js';
import {
  mayDeclareScheduled,
  lerEscolhaDoPaciente,
  gravarEscolhaDoPaciente,
  type ConsentState,
} from '../packages/shared/src/appointment-consent.js';
import { limparPlaceholder, ehPlaceholder } from '../packages/shared/src/placeholder.js';
import { ehMenuDeAutoatendimento } from '../packages/shared/src/pharmacy.js';

const AGORA = Date.parse('2026-08-24T18:47:54Z');
const SLOT = '2026-08-26T21:00:00.000Z'; // quarta 26/08 às 18h de Brasília

/** A mensagem que fechou a consulta indevidamente. Literal. */
const MSG_CONDICOES =
  'Quarta\n26/Agosto 18h \n\nO valor de investimento da consulta da dra Mayra Storti é R$ 600,00. ' +
  'Esse valor já está incluso 1 retorno com até 30 dias ( para entrega de exames). O valor da consulta ' +
  'deve ser pago em dinheiro ou pix na recepção com a secretária da Dra. antes do inicio da consulta.\n\n' +
  'Para garantir seu agendamento, solicitamos um depósito de 30% do valor da consulta, correspondente a ' +
  'R$ 180,00. O pagamento do saldo restante poderá ser realizado no dia do atendimento. Ressaltamos que a ' +
  'reserva do horário só será confirmada após a realização do pagamento inicial. Em caso de cancelamento, ' +
  'o valor do andiantamento não é reembolsável.';

describe('o detector: a frase que dizia "não confirmada" fazia o sistema confirmar', () => {
  it('NÃO lê como fechamento a mensagem que condiciona a reserva ao pagamento', () => {
    const r = readClinicSlotMessage(MSG_CONDICOES, AGORA);
    expect(r.kind).toBe('offer');
    // O motivo tem que ser legível no log — sem isso, "não fechou" vira mistério.
    expect(r.blockedBy).toBeTruthy();
    expect(resolveCommittedSlot(r, [], null)).toBeNull();
  });

  it('mesmo assim EXTRAI o horário — recusar fechar não pode custar a oferta', () => {
    const r = readClinicSlotMessage(MSG_CONDICOES, AGORA);
    expect(r.datetimes[0]?.iso).toBe(SLOT);
  });

  it('"Vamos agendar?" continua sendo oferta, não fechamento', () => {
    const r = readClinicSlotMessage('Quarta\n26/Agosto 18h Vamos agendar?', AGORA);
    expect(r.kind).toBe('offer');
  });

  it('o fechamento de VERDADE continua passando (caso Rita, 03/08 — a 1ª consulta da história)', () => {
    // Esta é a regressão que importa: endurecer o detector não pode cegá-lo.
    const r = readClinicSlotMessage('Ficou então para o dia 26/08 quarta feira ás 10 horas, obrigada', AGORA);
    expect(r.kind).toBe('commitment');
    expect(r.blockedBy).toBeNull();
    expect(resolveCommittedSlot(r, [], null)?.iso).toBeTruthy();
  });

  it.each([
    ['a reserva só será confirmada após o pagamento', 'condicional clássico'],
    ['O horário ainda não está confirmado, aguardo o comprovante', 'negação explícita'],
    ['Para garantir o agendamento precisamos do pedido médico', 'exigência de documento'],
    ['Fica reservado mediante depósito de R$ 100', 'reserva mediante sinal'],
    ['Assim que cair o pix eu confirmo o horário', 'condicionado ao pix'],
  ])('veta o fechamento: "%s" (%s)', (texto) => {
    const r = readClinicSlotMessage(`${texto} — quarta 26/08 às 18h`, AGORA);
    expect(r.kind).not.toBe('commitment');
  });

  it.each([
    ['Confirmado! Está agendado para quarta 26/08 às 18h'],
    ['Marquei aqui para o dia 26/08 às 18h'],
    ['Pode vir quarta 26/08 às 18h'],
  ])('não vira paranoia: "%s" ainda fecha', (texto) => {
    expect(readClinicSlotMessage(texto, AGORA).kind).toBe('commitment');
  });

  it('afirmação seca continua exigindo estado (não mexemos nisso)', () => {
    expect(isBareAffirmation('ok')).toBe(true);
    expect(isBareAffirmation('ok, quarta às 18h está reservado')).toBe(false);
  });
});

describe('pré-condições: o que a Duda nunca soube', () => {
  const pcs = readBookingPreconditions(MSG_CONDICOES);

  it('encontra o sinal de 30% / R$ 180 e sabe que ele não volta', () => {
    const sinal = pcs.find((p) => p.kind === 'deposit');
    expect(sinal).toBeDefined();
    expect(sinal!.amountBrl).toBe(180);
    expect(sinal!.percent).toBe(30);
    expect(sinal!.refundable).toBe(false);
  });

  it('trava a reserva — é a diferença entre ter consulta e achar que tem', () => {
    expect(blocksReservation(pcs)).toBe(true);
  });

  it('não confunde o preço da consulta com sinal: forma de pagamento só informa', () => {
    const termos = readBookingPreconditions(
      'O valor da consulta deve ser pago em dinheiro ou pix na recepção antes do início da consulta.',
    );
    expect(termos.every((p) => p.kind === 'payment_terms')).toBe(true);
    expect(blocksReservation(termos)).toBe(false);
  });

  it('lê exigência de documento (o menu da secretária pedia foto do pedido médico)', () => {
    const doc = readBookingPreconditions(
      'disponibilidade, agendamentos e valores apenas após o envio de uma foto legível do pedido inteiro médico',
    );
    expect(doc.some((p) => p.kind === 'document')).toBe(true);
    expect(blocksReservation(doc)).toBe(true);
  });

  it('mensagem sem exigência nenhuma não inventa pré-condição', () => {
    expect(readBookingPreconditions('Tenho quarta às 18h disponível, pode ser?')).toHaveLength(0);
  });

  it('a frase pro paciente diz o valor E que não volta', () => {
    const linhas = describePreconditionsForPatient(pcs, 600);
    expect(linhas[0]).toContain('180,00');
    expect(linhas[0]).toContain('não é devolvido');
  });

  it('sem valor explícito, calcula o sinal pelo percentual', () => {
    const so_pct = readBookingPreconditions('Para garantir o agendamento pedimos um depósito de 30% do valor.');
    expect(valorDoSinal(so_pct[0]!, 600)).toBe(180);
  });

  it('lê dinheiro e percentual em formatos brasileiros', () => {
    expect(valorEmReais('R$ 1.250,50')).toBe(1250.5);
    expect(valorEmReais('custa 180 reais')).toBe(180);
    expect(valorEmReais('sem valor aqui')).toBeNull();
    expect(percentualDe('30% do valor')).toBe(30);
  });
});

describe('o gate: ninguém fecha consulta no lugar do paciente', () => {
  const base: ConsentState = { status: 'searching', selectedQuoteId: null, scheduledAt: null, patientChoice: null };

  it('NEGA o caso Duda — clínica falou, paciente nunca escolheu', () => {
    const v = mayDeclareScheduled(base, SLOT, 'clinic_detected');
    expect(v.allow).toBe(false);
    if (!v.allow) expect(v.reason).toBe('sem_escolha_do_paciente');
  });

  it('nega igual quando quem afirma é a tool do LLM, e não o detector', () => {
    // A porta é a mesma pros dois: se o caminho do LLM escapasse, o gate seria decorativo.
    expect(mayDeclareScheduled(base, SLOT, 'clinic_tool').allow).toBe(false);
  });

  it('PERMITE quando o paciente escolheu aquele horário', () => {
    const comEscolha: ConsentState = {
      ...base, status: 'confirming',
      patientChoice: { quoteId: 'q1', iso: SLOT, at: '2026-08-24T18:50:00Z', via: 'tool' },
    };
    expect(mayDeclareScheduled(comEscolha, SLOT, 'clinic_detected').allow).toBe(true);
  });

  it('NEGA quando a clínica fecha um horário DIFERENTE do que ele escolheu', () => {
    // "Não tenho 18h, ficou 19h" não é detalhe: é outra consulta na vida dele.
    const comEscolha: ConsentState = {
      ...base, status: 'confirming',
      patientChoice: { quoteId: 'q1', iso: SLOT, at: '2026-08-24T18:50:00Z', via: 'tool' },
    };
    const v = mayDeclareScheduled(comEscolha, '2026-08-26T22:00:00.000Z', 'clinic_detected');
    expect(v.allow).toBe(false);
    if (!v.allow) expect(v.reason).toBe('escolha_de_outro_horario');
  });

  it('a escolha do próprio paciente sempre passa', () => {
    expect(mayDeclareScheduled(base, SLOT, 'patient_selection').allow).toBe(true);
  });

  it('estado legado `confirming` com o slot na mesa passa — não quebra consulta em voo', () => {
    // Sem esta regra, subir o gate derrubaria toda consulta que já estava em andamento.
    const legado: ConsentState = { ...base, status: 'confirming', scheduledAt: SLOT };
    expect(mayDeclareScheduled(legado, SLOT, 'clinic_detected').allow).toBe(true);
  });

  it('já fechada no mesmo horário: idempotente (o worker de integridade precisa disto)', () => {
    const fechada: ConsentState = { ...base, status: 'scheduled', scheduledAt: SLOT };
    expect(mayDeclareScheduled(fechada, SLOT, 'integrity_worker').allow).toBe(true);
  });

  it('consulta cancelada não ressuscita', () => {
    const v = mayDeclareScheduled({ ...base, status: 'cancelled' }, SLOT, 'patient_selection');
    expect(v.allow).toBe(false);
    if (!v.allow) expect(v.reason).toBe('consulta_terminal');
  });

  it('grava e relê a escolha sem mutar o objeto original', () => {
    const antes = { plan: 'particular' };
    const depois = gravarEscolhaDoPaciente(antes, { quoteId: 'q1', iso: SLOT, at: '2026-08-24T18:50:00Z', via: 'tool' });
    expect(antes).toEqual({ plan: 'particular' });
    expect(depois['plan']).toBe('particular');
    expect(lerEscolhaDoPaciente(depois)?.iso).toBe(SLOT);
  });

  it('JSONB torto não derruba a leitura', () => {
    expect(lerEscolhaDoPaciente(null)).toBeNull();
    expect(lerEscolhaDoPaciente({ _patient_choice: 'sim' })).toBeNull();
    expect(lerEscolhaDoPaciente({ _patient_choice: { iso: SLOT } })).toBeNull(); // sem `at` não é registro
  });
});

describe('placeholder: "Não informado" não é endereço', () => {
  it('vira null — era o que ia impresso no card da Duda', () => {
    expect(limparPlaceholder('Não informado')).toBeNull();
    expect(ehPlaceholder('N/A')).toBe(true);
    expect(ehPlaceholder('  -  ')).toBe(true);
  });

  it('endereço de verdade passa intacto', () => {
    expect(limparPlaceholder('Rua 88, 500 - Setor Sul, Goiânia')).toBe('Rua 88, 500 - Setor Sul, Goiânia');
  });

  it('endereço ruim NÃO é ausência — não é papel deste módulo julgar qualidade', () => {
    expect(limparPlaceholder('Rua sem nome')).toBe('Rua sem nome');
  });
});

describe('menu de autoatendimento: ruído que a Duda não podia usar', () => {
  /** O primeiro retorno REAL do consultório, repassado cru pra ela. */
  const MENU =
    'Olá, tudo bem? Seja bem vindo (a)!  Meu nome é Ludmylla, sou a secretária da Dra Mayra Storti. 😊\n\n' +
    '*Em que eu posso te ajudar?*\n\n*1-* Agendamento de consultas:\n *1.1*- Nutrologia\n *1.2*- Gastro\n\n' +
    '*2*- Agendamento de retorno\n\n*3*- Teste do hidrogênio expirado\n' +
    '(_)disponibilidade, agendamentos e valores apenas após o envio de uma foto legível do pedido inteiro médico(_)\n\n*4*- Outros assuntos';

  it('reconhece o menu', () => {
    expect(ehMenuDeAutoatendimento(MENU)).toBe(true);
  });

  it('mas a EXIGÊNCIA dentro dele não se perde — vira frase que o paciente entende', () => {
    // Filtrar o repasse cru não pode custar a informação: o menu exigia foto do pedido
    // médico, e isso continua chegando a ele, em português.
    const pcs = readBookingPreconditions(MENU);
    expect(pcs.some((p) => p.kind === 'document')).toBe(true);
    expect(describePreconditionsForPatient(pcs)[0]).toContain('pedido médico');
  });

  it('atendimento humano de verdade NÃO é menu (senão calaríamos a clínica)', () => {
    expect(ehMenuDeAutoatendimento('Oi! Seja bem vindo. Tenho quarta às 18h com a Dra, o valor é R$ 600. Serve?')).toBe(false);
  });

  it('orientação numerada tampouco — 1) e 2) aqui são instruções reais', () => {
    expect(ehMenuDeAutoatendimento(
      'Anotado! Antes da consulta: 1- traga o pedido médico e exames 2- chegue 15 minutos antes, por gentileza.',
    )).toBe(false);
  });

  it('mensagem curta nunca é menu', () => {
    expect(ehMenuDeAutoatendimento('Vamos agendar?')).toBe(false);
  });
});
