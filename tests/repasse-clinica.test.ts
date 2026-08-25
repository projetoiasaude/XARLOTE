/**
 * O que da conversa com o consultório o paciente precisa ver.
 *
 * Este filtro vive entre dois incidentes que se contradizem:
 *   • 30/07 (Glauber): a clínica pediu carteirinha e pedido médico, nada foi repassado,
 *     e o fluxo travou dias esperando um documento que ele não sabia que precisava.
 *   • 24-25/08 (Duda, Ciro): o backstop criado por causa do Glauber despejou no paciente
 *     o menu da recepção, a apresentação da secretária e "Ok. Vou desmarcar aqui".
 *
 * Os textos abaixo são REAIS das duas conversas.
 */
import { describe, it, expect } from 'vitest';
import { decidirRepasseAoPaciente } from '../packages/shared/src/repasse-clinica.js';

describe('o que NÃO chega mais ao paciente', () => {
  it('a apresentação da secretária (foi pro Ciro em 25/08)', () => {
    const r = decidirRepasseAoPaciente('Olá, sou a Rita, secretária do dr Rafael e da dra Ana Lara Navarrete. Por favor, qual o seu nome? Como posso te atender?');
    expect(r.repassar).toBe(false);
  });

  it('a conversa operacional (foi pro Ciro em 25/08)', () => {
    const r = decidirRepasseAoPaciente('Ok. Vou desmarcar aqui, obrigada. Precisando é só me chamar aqui.');
    expect(r).toEqual({ repassar: false, motivo: 'operacional' });
  });

  it('o menu da recepção (foi pra Duda em 24/08)', () => {
    const menu = 'Olá, tudo bem? Seja bem vindo (a)! Meu nome é Ludmylla. *Em que eu posso te ajudar?* '
      + '*1-* Agendamento de consultas *2*- Agendamento de retorno *3*- Teste do hidrogênio *4*- Outros assuntos';
    expect(decidirRepasseAoPaciente(menu)).toEqual({ repassar: false, motivo: 'menu' });
  });

  it('cortesia pura', () => {
    expect(decidirRepasseAoPaciente('Bom dia! Obrigada pelo contato, estamos à disposição.').repassar).toBe(false);
  });

  it('"ok" solto nem chega a ser avaliado', () => {
    expect(decidirRepasseAoPaciente('Ok')).toEqual({ repassar: false, motivo: 'curto_demais' });
  });
});

describe('o que CONTINUA chegando — a proteção do caso Glauber', () => {
  it('a exigência que travou o Glauber passa', () => {
    const r = decidirRepasseAoPaciente('Precisamos que envie foto da carteirinha do Ipasgo e do pedido médico, e aguardar 72h para retorno.');
    expect(r.repassar).toBe(true);
  });

  it('mesmo DENTRO de um menu, a exigência de documento vence', () => {
    // O menu da Duda terminava com "agendamentos e valores apenas após o envio de uma
    // foto legível do pedido médico". Barrar o menu não pode engolir isso.
    const menu = 'Olá! Seja bem vindo. *Em que posso ajudar?* *1-* Consultas *2-* Retorno *3-* Exames. '
      + 'Disponibilidade, agendamentos e valores apenas após o envio de uma foto legível do pedido médico.';
    expect(decidirRepasseAoPaciente(menu).repassar).toBe(true);
  });

  it.each([
    ['O valor da consulta é R$ 600,00', 'valor'],
    ['Tenho quarta às 18h disponível', 'horário'],
    ['Infelizmente o Dr. não atende esse convênio', 'indisponibilidade'],
    ['Ficamos na Rua 88, número 500, Setor Sul', 'endereço'],
    ['É necessário jejum de 8 horas e chegar 15 minutos antes', 'preparo'],
  ])('repassa: "%s" (%s)', (texto) => {
    expect(decidirRepasseAoPaciente(texto).repassar).toBe(true);
  });

  it('na dúvida, REPASSA — calar informação real é o erro mais caro', () => {
    const r = decidirRepasseAoPaciente('O doutor pediu para avisar que prefere conversar sobre isso pessoalmente.');
    expect(r.repassar).toBe(true);
    if (r.repassar) expect(r.porque).toContain('dúvida');
  });

  it('cortesia GRUDADA em conteúdo real não engole o conteúdo', () => {
    const r = decidirRepasseAoPaciente('Bom dia! Obrigada por aguardar. Consegui quarta 26/08 às 18h, o valor é R$ 600.');
    expect(r.repassar).toBe(true);
  });
});
