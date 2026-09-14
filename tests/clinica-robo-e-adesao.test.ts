import { describe, it, expect } from 'vitest';
import {
  analisarMensagemDeRobo, extrairOpcoes, escolherOpcaoDeAgendamento, responderRobo,
  assuntoDaPergunta, roboEmLoop, pareceNarracaoInterna,
} from '../packages/shared/src/robo-de-atendimento';
import { decidirRepasseAoPaciente } from '../packages/shared/src/repasse-clinica';
import { checkOutboundSanity } from '../packages/shared/src/sanity';
import {
  normalizarAck, classificarAckDeDose, lembretesQueTocaramJuntos, anunciouRegistroDeDose, falaHonestaDeDose,
} from '../packages/shared/src/adesao-ack';

// As mensagens REAIS do robô da GastroEla (10/09/2026, conversa com a Duda) e o menu da
// secretária da Dra. Mayra (24/08). Copiadas do banco, sem edição.
const GASTROELA = {
  saudacao: 'Olá! 👋\nBem-vindo(a) ao atendimento da Clínica GastroEla',
  nome1: 'Por favor, informe o seu nome completo',
  nome2: 'Por favor, informe o nome completo para seguirmos com o seu atendimento.',
  nasc: 'Por favor, informe a sua data de nascimento.',
  menu: 'Como posso ajudar você hoje?\n\n1. Teste Respiratório H. pylori\n2. Agendamento de exames\n3. Agendamento de consultas\n4. Dúvidas no preparo de exames\n5. Localização da clínica\n6. Horário de funcionamento\n7. Valores\n8. Convênios atendidos\n9. Cancelamento de exames e consultas\n10. Resultado de Exames\n11. Confirmação de horários\n12. Falar com um de nossos atendentes\n\n*Digite o número* que deseja atendimento.',
  numero: 'Por favor, informe apenas o número da opção desejada.',
};
const LUDMYLLA = 'Olá, tudo bem? Seja bem vindo (a)!  Meu nome é Ludmylla, sou a secretária da Dra Mayra Storti. 😊\n\n*Em que eu posso te ajudar?*\n\n*1-* Agendamento de consultas:\n *1.1*- Nutrologia\n *1.2*- Gastro\n\n*2*- Agendamento de retorno\n\n*3*- Teste do hidrogênio expirado\n(_)disponibilidade, agendamentos e valores apenas após o envio de uma foto legível do pedido inteiro médico(_)\n\n*4*- Outros assuntos';

describe('analisarMensagemDeRobo — as mensagens reais da GastroEla', () => {
  it('reconhece saudação automática, pedido de dado, menu e "informe o número"', () => {
    expect(analisarMensagemDeRobo(GASTROELA.saudacao)).toMatchObject({ robo: true, tipo: 'saudacao_automatica' });
    expect(analisarMensagemDeRobo(GASTROELA.nome1)).toMatchObject({ robo: true, tipo: 'pede_dado', dadoPedido: 'nome_completo' });
    expect(analisarMensagemDeRobo(GASTROELA.nome2)).toMatchObject({ robo: true, tipo: 'pede_dado', dadoPedido: 'nome_completo' });
    expect(analisarMensagemDeRobo(GASTROELA.nasc)).toMatchObject({ robo: true, tipo: 'pede_dado', dadoPedido: 'nascimento' });
    const menu = analisarMensagemDeRobo(GASTROELA.menu);
    expect(menu.robo).toBe(true); expect(menu.tipo).toBe('menu'); expect(menu.opcoes.length).toBe(12);
    expect(analisarMensagemDeRobo(GASTROELA.numero)).toMatchObject({ robo: true, tipo: 'pede_numero' });
  });
  it('gente de verdade NÃO é robô', () => {
    expect(analisarMensagemDeRobo('Boa tarde! A Dra Mayra tem quarta 26/08 às 18h por R$ 600').robo).toBe(false);
    expect(analisarMensagemDeRobo('Precisamos que envie a foto da carteirinha do Ipasgo e do pedido médico, e aguardar 72h').robo).toBe(false); // exigência de documento (caso Glauber)
    expect(analisarMensagemDeRobo('qual o nome do paciente?').robo).toBe(false); // pergunta humana, sem "informe o seu"
    expect(analisarMensagemDeRobo('tem sim, 64,90').robo).toBe(false);
    expect(analisarMensagemDeRobo('').robo).toBe(false);
  });
  it('o menu da Ludmylla (secretária humana com menu) é menu, com sub-opções', () => {
    const a = analisarMensagemDeRobo(LUDMYLLA);
    expect(a.tipo).toBe('menu');
    expect(extrairOpcoes(LUDMYLLA).map((o) => o.numero)).toEqual(expect.arrayContaining(['1', '1.1', '1.2', '2', '3', '4']));
  });
});

describe('escolherOpcaoDeAgendamento', () => {
  it('GastroEla → "3" (Agendamento de consultas), não exames/cancelamento/confirmação', () => {
    expect(escolherOpcaoDeAgendamento(extrairOpcoes(GASTROELA.menu))).toBe('3');
  });
  it('Ludmylla → gastro (1.2) vence "agendamento de consultas" genérico? não: o genérico "1" vale 10 e a sub-opção só cita a especialidade', () => {
    const n = escolherOpcaoDeAgendamento(extrairOpcoes(LUDMYLLA));
    expect(['1', '1.2']).toContain(n);
  });
  it('sem opção de consulta cai em "falar com atendente"; sem nada → null', () => {
    expect(escolherOpcaoDeAgendamento([{ numero: '1', rotulo: 'Resultado de exames' }, { numero: '2', rotulo: 'Falar com um atendente' }])).toBe('2');
    expect(escolherOpcaoDeAgendamento([{ numero: '1', rotulo: 'Resultado de exames' }, { numero: '2', rotulo: 'Boletos' }])).toBeNull();
  });
});

describe('responderRobo — a conversa da Duda sem modelo de linguagem', () => {
  const dados = { nomeCompleto: 'Maria Eduarda Moura Macedo', nascimento: '29/12/1999', cpf: null, telefone: '+5562992552727', convenio: 'Ipasgo' };
  it('saudação → espera; nome completo conhecido → envia; desconhecido → pergunta UMA vez ao paciente', () => {
    expect(responderRobo(analisarMensagemDeRobo(GASTROELA.saudacao), dados).acao).toBe('esperar');
    expect(responderRobo(analisarMensagemDeRobo(GASTROELA.nome2), dados)).toMatchObject({ acao: 'enviar', texto: 'Maria Eduarda Moura Macedo' });
    const r = responderRobo(analisarMensagemDeRobo(GASTROELA.nome2), { ...dados, nomeCompleto: null });
    expect(r).toMatchObject({ acao: 'perguntar_paciente', dado: 'nome_completo' });
  });
  it('nascimento conhecido → envia; menu → "3"; "informe apenas o número" sem menu → repete a última opção', () => {
    expect(responderRobo(analisarMensagemDeRobo(GASTROELA.nasc), dados)).toMatchObject({ acao: 'enviar', texto: '29/12/1999' });
    expect(responderRobo(analisarMensagemDeRobo(GASTROELA.menu), dados)).toMatchObject({ acao: 'enviar', texto: '3' });
    expect(responderRobo(analisarMensagemDeRobo(GASTROELA.numero), dados, '3')).toMatchObject({ acao: 'enviar', texto: '3' });
    expect(responderRobo(analisarMensagemDeRobo(GASTROELA.numero), dados, null).acao).toBe('desistir');
  });
  it('opção inválida → desiste (não insiste com robô)', () => {
    expect(responderRobo(analisarMensagemDeRobo('Opção inválida. Digite o número da opção desejada.'), dados, '3').acao).toBe('desistir');
  });
});

describe('assuntoDaPergunta — dedupe por tema, não por texto', () => {
  it('as 6 paráfrases do nome completo têm o MESMO assunto; nascimento é outro', () => {
    const p = [
      'A clínica pediu seu nome completo para seguir com o agendamento. Pode me passar, por favor?',
      'A clínica está pedindo seu nome completo para prosseguir com o agendamento. Pode me informar, por favor?',
      'Duda, a clínica está pedindo seu nome completo para conseguir prosseguir com o agendamento. Pode me informar?',
      'Por favor, informe o seu nome completo',
    ].map(assuntoDaPergunta);
    expect(new Set(p).size).toBe(1);
    expect(p[0]).toBe('nome_completo');
    expect(assuntoDaPergunta('Duda, a clínica pediu sua data de nascimento para prosseguir')).toBe('nascimento');
    expect(assuntoDaPergunta('é plano ou particular?')).toBe('convenio');
  });
  it('perguntas sem tema conhecido: paráfrases são o mesmo assunto; assunto diferente não', async () => {
    const { mesmoAssunto } = await import('../packages/shared/src/robo-de-atendimento');
    expect(assuntoDaPergunta('A clínica quer saber se você prefere manhã ou tarde')).toBe('outro');
    expect(mesmoAssunto('A clínica quer saber se você prefere manhã ou tarde', 'A clínica perguntou se prefere pela manhã ou à tarde')).toBe(true);
    expect(mesmoAssunto('A clínica quer saber se você prefere manhã ou tarde', 'A clínica perguntou se você tem o pedido médico em mãos')).toBe(false);
    expect(mesmoAssunto('A clínica pediu seu nome completo', 'Duda, a clínica está pedindo seu nome completo para prosseguir')).toBe(true);
    expect(mesmoAssunto('A clínica pediu seu nome completo', 'A clínica pediu sua data de nascimento')).toBe(false);
  });
});

describe('roboEmLoop — só conta prompt repetido DEPOIS de uma resposta nossa', () => {
  const inn = (c: string) => ({ direction: 'in' as const, content: c });
  const out = (c: string) => ({ direction: 'out' as const, content: c });
  it('respondemos 2× e o prompt voltou igual as duas vezes → loop', () => {
    expect(roboEmLoop([inn(GASTROELA.nome2), out('Maria Eduarda'), inn(GASTROELA.nome2), out('Maria Eduarda Moura Macedo'), inn(GASTROELA.nome2)])).toBe(true);
  });
  it('robô re-perguntando enquanto esperamos o paciente NÃO é loop', () => {
    expect(roboEmLoop([inn(GASTROELA.nome1), inn(GASTROELA.nome2), inn(GASTROELA.nome2), inn(GASTROELA.nome2)])).toBe(false);
  });
  it('conversa humana variada não é loop; uma resposta só não basta', () => {
    expect(roboEmLoop([inn('oi'), out('boa tarde'), inn('tem sim'), out('ótimo'), inn('quarta às 18h')])).toBe(false);
    expect(roboEmLoop([inn(GASTROELA.numero), out('3'), inn(GASTROELA.numero)])).toBe(false);
    expect(roboEmLoop([inn(GASTROELA.numero), out('3'), inn(GASTROELA.numero), out('3'), inn(GASTROELA.numero)])).toBe(true);
  });
});

describe('pareceNarracaoInterna — o que vazou pra GastroEla', () => {
  it('as frases reais são narração; cortesia e resposta direta não são', () => {
    expect(pareceNarracaoInterna('A clínica está pedindo o nome completo do paciente para prosseguir. Só tenho o primeiro nome. Vou precisar perguntar ao paciente.')).toBe(true);
    expect(pareceNarracaoInterna('Preciso do nome completo do paciente para prosseguir com o atendimento da clínica.')).toBe(true);
    expect(pareceNarracaoInterna('A clínica está insistindo no nome completo do paciente para poder prosseguir. Vou perguntar à Duda.')).toBe(true);
    expect(pareceNarracaoInterna('Deixa eu confirmar isso aqui rapidinho e já te respondo, tá?')).toBe(false);
    expect(pareceNarracaoInterna('Maria Eduarda Moura Macedo, nascida em 29/12/1999. Convênio Ipasgo.')).toBe(false);
    expect(pareceNarracaoInterna('3')).toBe(false);
  });
});

describe('repasse ao paciente — prompt de robô nunca vai', () => {
  it('"informe apenas o número" e "informe o seu nome completo" são operacionais (robo)', () => {
    expect(decidirRepasseAoPaciente(GASTROELA.numero)).toEqual({ repassar: false, motivo: 'robo' });
    expect(decidirRepasseAoPaciente(GASTROELA.nome2)).toEqual({ repassar: false, motivo: 'robo' });
    expect(decidirRepasseAoPaciente(GASTROELA.saudacao)).toEqual({ repassar: false, motivo: 'robo' });
  });
  it('o caso Glauber continua protegido: exigência de documento passa', () => {
    expect(decidirRepasseAoPaciente('Precisamos que envie a foto da carteirinha do Ipasgo e do pedido médico, e aguardar 72h').repassar).toBe(true);
  });
});

describe('sanidade de saída — "3" é resposta válida a menu', () => {
  it('dígito de 1–2 casas passa; "." e vazio continuam bloqueados', () => {
    expect(checkOutboundSanity('3').blockers).toEqual([]);
    expect(checkOutboundSanity('12').blockers).toEqual([]);
    expect(checkOutboundSanity('.').blockers).toContain('texto vazio ou curto demais');
    expect(checkOutboundSanity('').blockers).toContain('texto vazio ou curto demais');
    expect(checkOutboundSanity('123').blockers).toEqual([]); // 3 chars já passava
  });
});

describe('adesão — o ack como o Glauber escreve', () => {
  it('normalizarAck colapsa letra esticada e tira emoji do fim', () => {
    expect(normalizarAck('Simmmmm')).toBe('Sim');
    expect(normalizarAck('Simm')).toBe('Sim');
    expect(normalizarAck('Tomado!! 👍')).toBe('Tomado!!');
    expect(normalizarAck('okkk ✅')).toBe('ok');
    expect(normalizarAck('tomei uma surra')).toBe('tomei uma surra'); // dupla no meio fica
  });
  it('classifica: "Simmmmm" é ack fraco; "tomei" forte; "não tomei" negado; "tomei um susto" não é dose', () => {
    expect(classificarAckDeDose('Simmmmm')).toMatchObject({ fraco: true, forte: false, negado: false });
    expect(classificarAckDeDose('Tomei')).toMatchObject({ forte: true });
    expect(classificarAckDeDose('já tomei viu')).toMatchObject({ forte: true });
    expect(classificarAckDeDose('não tomei ainda')).toMatchObject({ negado: true });
    expect(classificarAckDeDose('tomei um susto')).toMatchObject({ objetoNaoMedicamentoso: true });
    expect(classificarAckDeDose('tudo certo')).toMatchObject({ forte: false, fraco: false });
  });
  it('lembretesQueTocaramJuntos: Domperidona 20:00:24 + Nimesulida 20:00:26 → os dois; o das 11:30 não', () => {
    const l = lembretesQueTocaramJuntos([
      { id: 'domp', last_run_at: '2026-09-10T23:00:24Z' },
      { id: 'nime', last_run_at: '2026-09-10T23:00:26Z' },
      { id: 'almoco', last_run_at: '2026-09-10T14:30:23Z' },
    ]);
    expect(l.map((x) => x.id).sort()).toEqual(['domp', 'nime']);
    expect(lembretesQueTocaramJuntos([])).toEqual([]);
  });
  it('anúncio de registro e a fala honesta', () => {
    expect(anunciouRegistroDeDose('Anotado ✅ Bom dia, Glauber!')).toBe(true);
    expect(anunciouRegistroDeDose('Marcado! Bom descanso 💙')).toBe(true);
    expect(anunciouRegistroDeDose('Que bom! Como você está se sentindo?')).toBe(false);
    expect(falaHonestaDeDose(['Esomeprazol magnésico 40mg'])).toContain('*Esomeprazol magnésico 40mg*');
    expect(falaHonestaDeDose(['Domperidona 10mg (jantar)', 'Nimesulida 100mg'])).toContain('*Domperidona 10mg (jantar)* e *Nimesulida 100mg*');
  });
});
