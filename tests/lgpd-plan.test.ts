import { describe, it, expect } from 'vitest';
import {
  ANONIMIZACAO_USERS,
  MARCA_REDIGIDO,
  PLANO_LGPD,
  TABELAS_COM_USER_ID,
  aindaContemIdentificador,
  destinoDoFio,
  identificadorRedigivel,
  patchAnonimizacaoUser,
  redigirIdentificadores,
  tabelasParaApagar,
  tabelasSemTratamento,
  tratamentosDeTabelaInexistente,
  tratamentosSemJustificativa,
} from '../apps/api/src/lib/lgpd-plan.js';

/**
 * O plano de apagamento LGPD.
 *
 * ## Este arquivo é o vigilante, não uma checagem de rotina
 *
 * O defeito real, encontrado em 12/08/2026, não foi uma lista escrita errada: foi uma
 * lista escrita CERTA que envelheceu. Migrations posteriores criaram tabelas com
 * `user_id` e o apagamento não sabia delas. Cinco ficaram de fora, sendo duas graves:
 *
 *   · `app_sessions` — o paciente apagava a conta e SEGUIA LOGADO no app, com JWT válido
 *     lendo um prontuário que já devia ter deixado de existir.
 *   · `share_grants` — qualquer link dado a um médico CONTINUAVA abrindo depois de a
 *     conta desaparecer.
 *
 * Nenhuma das duas estava na lista de buracos conhecidos. Elas nasceram depois.
 *
 * O primeiro teste aqui existe pra que isso não se repita: tabela nova com `user_id`
 * **quebra a suíte** até alguém escrever se ela é apagada ou preservada. Um teste que
 * falha ao adicionar uma migration é exatamente o que se quer neste ponto do sistema.
 */

describe('o vigilante da cobertura', () => {
  it('TODA tabela com user_id tem tratamento explícito', () => {
    const semTratamento = tabelasSemTratamento();
    expect(
      semTratamento,
      `Estas tabelas têm user_id e ninguém decidiu o que fazer com elas no apagamento ` +
        `LGPD: ${semTratamento.join(', ')}. Adicione cada uma ao PLANO_LGPD com ` +
        `acao 'apagar', ou 'preservar'/'anonimizar' COM justificativa.`,
    ).toEqual([]);
  });

  it('nada sobrevive ao apagamento sem justificativa escrita', () => {
    const semPorque = tratamentosSemJustificativa();
    expect(
      semPorque,
      `Estas tabelas preservam dado de um usuário que pediu apagamento e não dizem por ` +
        `quê: ${semPorque.join(', ')}.`,
    ).toEqual([]);
  });

  it('o plano não cita tabela que não existe', () => {
    // A deriva também acontece ao contrário: tabela removida por migration e o plano
    // tentando apagá-la. Em PostgREST isso é um erro por request, silencioso sob o
    // catch — o mesmo padrão que deixou a biblioteca de exames vazia.
    expect(tratamentosDeTabelaInexistente()).toEqual([]);
  });

  it('a lista do schema não tem duplicata (sinal de edição manual desatenta)', () => {
    expect(new Set(TABELAS_COM_USER_ID).size).toBe(TABELAS_COM_USER_ID.length);
  });

  it('cada tabela aparece UMA vez no plano', () => {
    const tabelas = PLANO_LGPD.map((t) => t.tabela);
    expect(new Set(tabelas).size).toBe(tabelas.length);
  });
});

describe('as tabelas de ACESSO são as primeiras', () => {
  it('sessão, aparelho e link do médico vêm antes de tudo', () => {
    const ordem = tabelasParaApagar();
    // Enquanto a sessão vive, o dado segue alcançável. Se o apagamento falhar no meio, é
    // melhor ter fechado a porta antes de começar a limpar a casa.
    expect(ordem.slice(0, 3)).toEqual(['app_sessions', 'device_tokens', 'share_grants']);
  });

  it('não duplica as tabelas de acesso no resto da lista', () => {
    const ordem = tabelasParaApagar();
    expect(new Set(ordem).size).toBe(ordem.length);
  });

  it('a ordem cobre exatamente as tabelas marcadas como apagar', () => {
    const doPlano = PLANO_LGPD.filter((t) => t.acao === 'apagar').map((t) => t.tabela);
    expect(new Set(tabelasParaApagar())).toEqual(new Set(doPlano));
  });

  it('as três tabelas de acesso ESTÃO no plano como apagar', () => {
    // Guarda contra o erro de mão inversa: pôr uma tabela no `primeiro` da ordenação e
    // esquecer de declará-la no plano — a ordem a incluiria sem justificativa nenhuma.
    for (const t of ['app_sessions', 'device_tokens', 'share_grants']) {
      expect(PLANO_LGPD.find((p) => p.tabela === t)?.acao, t).toBe('apagar');
    }
  });
});

describe('as cinco tabelas que estavam faltando', () => {
  // Uma asserção por tabela, nomeando a consequência: se alguém "simplificar" o plano no
  // futuro, o teste que falha diz exatamente o que volta a vazar.
  const esperadas: Array<[string, string]> = [
    ['app_sessions', 'o paciente seguiria logado no app depois de apagar a conta'],
    ['share_grants', 'o link dado a um médico seguiria abrindo o prontuário'],
    ['prescribers', 'nome e CRM dos médicos do paciente sobreviveriam'],
    ['app_media', 'as fotos de exame enviadas pelo app sobreviveriam'],
    ['app_exports', 'o JSON completo exportado antes sobreviveria, baixável'],
  ];

  for (const [tabela, consequencia] of esperadas) {
    it(`${tabela} é apagada — senão ${consequencia}`, () => {
      expect(PLANO_LGPD.find((t) => t.tabela === tabela)?.acao).toBe('apagar');
    });
  }
});

describe('o que é preservado, e por quê', () => {
  it('audit_log e consent_events sobrevivem — são a PROVA do apagamento', () => {
    for (const t of ['audit_log', 'consent_events']) {
      const trat = PLANO_LGPD.find((p) => p.tabela === t);
      expect(trat?.acao, t).toBe('preservar');
      expect(trat?.porque?.length ?? 0, t).toBeGreaterThan(40);
    }
  });

  it('users é ANONIMIZADA, não apagada — as FKs da prova dependem da linha', () => {
    expect(PLANO_LGPD.find((t) => t.tabela === 'users')?.acao).toBe('anonimizar');
  });
});

describe('patchAnonimizacaoUser', () => {
  const ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const AGORA = '2026-08-12T13:00:00.000Z';

  it('o telefone vira irrecuperável e único, nunca null', () => {
    const p = patchAnonimizacaoUser(ID, AGORA);
    // NOT NULL e único no schema: null falharia a UPDATE inteira, e manter o número
    // manteria o paciente encontrável por busca.
    expect(p['phone_e164']).toBe(`deleted-${ID}`);
    expect(p['phone_e164']).not.toContain('+55');
  });

  it('apaga o CPF, a data de nascimento e o resumo clínico', () => {
    const p = patchAnonimizacaoUser(ID, AGORA);
    expect(p['document_cpf']).toBeNull();
    expect(p['birth_date']).toBeNull();
    expect(p['health_summary']).toBeNull();
  });

  it('apaga o contato de emergência — dado de um TERCEIRO', () => {
    // O pior sobrevivente da versão anterior: o telefone de outra pessoa, que nunca
    // pediu nada e não tem como pedir.
    const p = patchAnonimizacaoUser(ID, AGORA);
    expect(p['emergency_contact_name']).toBeNull();
    expect(p['emergency_contact_phone_e164']).toBeNull();
    expect(p['emergency_contact_relation']).toBeNull();
  });

  it('colunas NOT NULL voltam ao DEFAULT, não a null', () => {
    // `metadata`, `communication_prefs`, `professional_profile` e `gender` são NOT NULL
    // com default. Escrever null nelas estouraria a UPDATE — e apagamento que falha no
    // meio é o pior dos mundos: sobra dado e o paciente foi avisado que sumiu.
    const p = patchAnonimizacaoUser(ID, AGORA);
    expect(p['metadata']).toEqual({});
    expect(p['communication_prefs']).toEqual({});
    expect(p['professional_profile']).toEqual({});
    expect(p['gender']).toBe('not_informed');
    for (const chave of ['metadata', 'communication_prefs', 'professional_profile', 'gender']) {
      expect(p[chave], chave).not.toBeNull();
    }
  });

  it('marca deleted_at — é o que faz toda leitura recusar', () => {
    // `routes/app/overview.ts` devolve 404 user_gone lendo este campo. Sem ele, uma
    // sessão sobrevivente leria uma linha vazia em vez de ser derrubada.
    expect(patchAnonimizacaoUser(ID, AGORA)['deleted_at']).toBe(AGORA);
  });

  it('NÃO apaga a prova de consentimento', () => {
    const p = patchAnonimizacaoUser(ID, AGORA);
    // LGPD art. 8º §1º: o ônus da prova do consentimento é do controlador. Apagar isto
    // junto destruiria a defesa de que houve consentimento enquanto durou.
    expect('lgpd_consent_at' in p).toBe(false);
    expect('lgpd_consent_version' in p).toBe(false);
  });

  it('limpa a referência à mensagem de consentimento, que acabou de ser apagada', () => {
    expect(patchAnonimizacaoUser(ID, AGORA)['lgpd_consent_message_id']).toBeNull();
  });

  it('toda coluna declarada em ANONIMIZACAO_USERS chega ao patch', () => {
    const p = patchAnonimizacaoUser(ID, AGORA);
    for (const { coluna } of ANONIMIZACAO_USERS) {
      expect(coluna in p, `${coluna} declarada mas ausente do patch`).toBe(true);
    }
  });

  it('não muta nada entre chamadas', () => {
    const a = patchAnonimizacaoUser(ID, AGORA);
    (a['metadata'] as Record<string, unknown>)['sujeira'] = 1;
    const b = patchAnonimizacaoUser(ID, AGORA);
    expect(b['metadata']).toEqual({});
  });
});

/**
 * A conversa do estabelecimento.
 *
 * Aqui está a razão pela qual este buraco ficou aberto tanto tempo: não dava pra fechar
 * com uma decisão só. Em produção, 73 fios de fornecedor atendem UM paciente e 26 atendem
 * de 2 a 8. Apagar as mensagens dos 26 trocaria o vazamento deste paciente pela destruição
 * do dado de outros oito.
 */
describe('destinoDoFio', () => {
  it('nenhum OUTRO paciente no fio → apaga as mensagens', () => {
    expect(destinoDoFio(0)).toBe('apagar_mensagens');
  });

  it('UM outro paciente já proíbe a exclusão', () => {
    // Este é o teste que importa. A primeira versão da função recebia "total de
    // pacientes" e devolvia `apagar_mensagens` para `<= 1`; o chamador passa OUTROS
    // pacientes. Com um único outro titular no fio, o `1` mandava APAGAR — destruindo
    // dado de quem não pediu nada. Peguei relendo o código, antes de rodar.
    expect(destinoDoFio(1)).toBe('redigir');
  });

  it('fio compartilhado por muitos → REDIGE', () => {
    expect(destinoDoFio(2)).toBe('redigir');
    expect(destinoDoFio(8)).toBe('redigir');
  });

  it('a fronteira é ESTRITAMENTE zero', () => {
    // Guarda contra alguém "relaxar" o limite de novo com um <= por engano.
    for (let n = 1; n <= 10; n++) expect(destinoDoFio(n), `${n} outros`).toBe('redigir');
  });
});

describe('redigirIdentificadores', () => {
  it('remove telefone e nome, e deixa o resto legível', () => {
    // Fixtures FICTÍCIAS de propósito. A primeira versão deste arquivo usava o telefone e
    // o nome reais do fundador — PII num teste versionado, que é justamente a coisa que o
    // módulo sob teste existe pra remover. Peguei na varredura antes do commit.
    const texto = 'Cliente Fulana de Teste, +5562900000001, quer Losartana 50mg pra Setor Bueno';
    const r = redigirIdentificadores(texto, ['Fulana de Teste', '+5562900000001']);
    expect(r).toContain('Losartana 50mg');
    expect(r).toContain('Setor Bueno');
    expect(r).toContain(MARCA_REDIGIDO);
    expect(r).not.toContain('Fulana de Teste');
  });

  it('ignora acento e caixa', () => {
    // "José" no cadastro aparece como "jose" no texto do fornecedor com a mesma frequência.
    expect(redigirIdentificadores('falei com FULANA DE TESTE hoje', ['Fulana de Teste'])).toContain(MARCA_REDIGIDO);
  });

  it('escapa metacaracteres — o + do telefone é regex', () => {
    // Sem escapar, `+5562...` viraria uma regex inválida ou casaria errado.
    const r = redigirIdentificadores('contato +5562900000001 confirmado', ['+5562900000001']);
    expect(r).toBe(`contato ${MARCA_REDIGIDO} confirmado`);
  });

  it('NÃO redige nome de uma palavra só — colide com palavra comum', () => {
    // O teste com dado real pegou isto: um paciente "Sintetico" fez a redação comer
    // "remédio sintético", texto que descrevia o PEDIDO e não a pessoa. Num fio
    // compartilhado, isso apaga informação do registro de OUTROS pacientes.
    const texto = 'Rosa pediu rosa mosqueta e verapamil';
    expect(redigirIdentificadores(texto, ['Rosa'])).toBe(texto);
    expect(redigirIdentificadores(texto, ['Vera'])).toBe(texto);
    expect(redigirIdentificadores('Zé pediu dipirona', ['Zé', '', '  ', 'ab'])).toBe('Zé pediu dipirona');
  });

  it('o REMÉDIO nunca é confundido com o paciente', () => {
    // "Vera" comeria "verapamil" (anti-hipertensivo); "Dora" comeria "adora".
    const r = redigirIdentificadores('paciente toma verapamil e adora caminhar', ['Vera', 'Dora']);
    expect(r).toContain('verapamil');
    expect(r).toContain('adora');
  });

  it('nome COMPLETO (2+ palavras) é redigido — a combinação identifica', () => {
    const r = redigirIdentificadores('Rosa Mendonca pediu rosa mosqueta', ['Rosa Mendonca']);
    expect(r).not.toContain('Rosa Mendonca');
    expect(r).toContain('rosa mosqueta');
  });

  it('remove TODAS as ocorrências, não só a primeira', () => {
    // Nome COMPLETO: um nome de uma palavra só não é redigível (ver o teste acima).
    const r = redigirIdentificadores('Fulana de Teste ligou; Fulana de Teste pediu', ['Fulana de Teste']);
    expect(r).not.toContain('Fulana de Teste');
    expect(r.match(new RegExp(MARCA_REDIGIDO.replace(/[[\]]/g, '\\$&'), 'g'))).toHaveLength(2);
  });

  it('a marca é legível — o fio não vira enigma pro fornecedor', () => {
    expect(MARCA_REDIGIDO).toMatch(/titular/);
  });
});

describe('identificadorRedigivel — o filtro que separa forte de colidente', () => {
  it('telefone é sempre forte', () => {
    expect(identificadorRedigivel('+5562900000001')).toBe('+5562900000001');
    expect(identificadorRedigivel('5562900000001')).toBe('5562900000001');
  });

  it('nome com 2+ palavras é forte', () => {
    expect(identificadorRedigivel('Ana Paula')).toBe('Ana Paula');
  });

  it('nome de uma palavra, inicial ou vazio NÃO passa', () => {
    expect(identificadorRedigivel('Rosa')).toBeNull();
    expect(identificadorRedigivel('Ana P')).toBeNull();
    expect(identificadorRedigivel('')).toBeNull();
    expect(identificadorRedigivel(null)).toBeNull();
  });

  it('número curto não é confundido com telefone', () => {
    // Um `like '%55%'` apagaria meio banco; o piso de 10 dígitos é a guarda.
    expect(identificadorRedigivel('5562')).toBeNull();
  });
});

describe('aindaContemIdentificador — o vigilante da redação', () => {
  it('acusa quando sobrou identificador', () => {
    expect(aindaContemIdentificador('cliente Fulana de Teste', ['Fulana de Teste'])).toBe(true);
  });

  it('não acusa depois de redigir', () => {
    const ids = ['Fulana de Teste', '+5562900000001'];
    const redigido = redigirIdentificadores('Fulana de Teste, +5562900000001', ids);
    expect(aindaContemIdentificador(redigido, ids)).toBe(false);
  });

  it('usa o MESMO filtro da redação', () => {
    // Se divergissem, o vigilante reprovaria para sempre um texto que a redação não tem
    // como consertar — e o apagamento entraria em retry infinito.
    expect(aindaContemIdentificador('Zé pediu', ['Zé'])).toBe(false);
    expect(aindaContemIdentificador('Rosa pediu rosa mosqueta', ['Rosa'])).toBe(false);
  });
});
