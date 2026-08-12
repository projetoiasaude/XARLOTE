/**
 * O PLANO de apagamento LGPD — puro, enumerado, e com vigilante na invariante.
 *
 * ## Por que isto é um arquivo separado, e puro
 *
 * O apagamento anterior vivia inline em `handleForgetMe` como uma lista de tabelas
 * escrita à mão. O problema não era a lista estar errada quando foi escrita: era que
 * **migrations posteriores criaram tabelas com `user_id` e ninguém voltou.** Em 12/08 o
 * levantamento contra `information_schema` achou cinco tabelas fora da lista, e duas
 * delas são graves:
 *
 *   · `app_sessions` (migration 0024) — o paciente apagava a conta e **continuava logado
 *     no aplicativo**, com JWT válido lendo um prontuário que já devia ter sumido.
 *   · `share_grants` (0026) — qualquer link que ele tivesse dado a um médico **continuava
 *     abrindo**, mesmo depois de a conta deixar de existir.
 *
 * Nenhuma das duas estava documentada como buraco. Elas nasceram depois da lista e a
 * lista não tinha como reclamar.
 *
 * Daí a forma deste arquivo: a lista de tabelas do schema é declarada de um lado, o
 * tratamento de cada uma do outro, e `tabelasSemTratamento()` compara os dois. O teste
 * chama essa função e exige lista vazia — então **tabela nova com `user_id` quebra a
 * suíte até alguém decidir, por escrito, se ela é apagada ou preservada.** Preservar é
 * uma escolha legítima (auditoria, prova de consentimento) e por isso exige `porque`.
 *
 * ## O que este arquivo NÃO faz
 *
 * Nada de I/O. Ele descreve o apagamento; `handlers/forget-me.ts` executa. É o que torna
 * a decisão testável sem banco — e apagamento é justamente a operação que a gente não
 * quer descobrir em produção que estava incompleta.
 */

/**
 * TODA tabela de `public` com coluna `user_id`.
 *
 * Conferido em 12/08/2026 contra o banco de produção. Para revalidar:
 *
 *   select c.table_name from information_schema.columns c
 *   join information_schema.tables t on t.table_schema=c.table_schema
 *     and t.table_name=c.table_name and t.table_type='BASE TABLE'
 *   where c.table_schema='public' and c.column_name='user_id'
 *   order by 1;
 *
 * Esta constante é mantida à mão de propósito: ela é o CONTRATO que o teste vigia. Se
 * fosse lida do banco em runtime, o teste passaria sozinho e não protegeria nada.
 */
export const TABELAS_COM_USER_ID = [
  'agent_skills',
  'app_exports',
  'app_media',
  'app_sessions',
  'assistant_tasks',
  'audit_log',
  'consent_events',
  'consultations',
  'conversations',
  'device_tokens',
  'entity_relations',
  'event_log',
  'feedback_events',
  'medication_inventory',
  'medication_log',
  'memory_cards_index',
  'orders',
  'prescribers',
  'prescriptions',
  'red_flag_pending',
  'reminders',
  'share_grants',
  'symptoms_log',
  'system_logs',
  'treatments',
  'user_addresses',
  'user_allergies',
  'user_exam_results',
  'user_health_conditions',
  'user_medications',
  'users',
] as const;

export type AcaoLgpd = 'apagar' | 'anonimizar' | 'preservar';

export interface TratamentoLgpd {
  tabela: string;
  acao: AcaoLgpd;
  /**
   * Obrigatório para `preservar` e `anonimizar` — o tipo não força, mas
   * `tratamentosSemJustificativa()` força, e o teste chama. Dado que sobrevive a um
   * pedido de apagamento precisa de um motivo escrito por alguém.
   */
  porque?: string;
}

/**
 * O tratamento de cada tabela.
 *
 * A ordem NÃO importa aqui (o executor decide a ordem, que tem dependências próprias);
 * o que importa é a cobertura.
 */
export const PLANO_LGPD: readonly TratamentoLgpd[] = [
  // ── Dado clínico e pessoal: apaga ───────────────────────────────────────────
  { tabela: 'symptoms_log', acao: 'apagar' },
  { tabela: 'treatments', acao: 'apagar' },
  { tabela: 'medication_inventory', acao: 'apagar' },
  { tabela: 'medication_log', acao: 'apagar' },
  { tabela: 'consultations', acao: 'apagar' },
  { tabela: 'prescriptions', acao: 'apagar' },
  { tabela: 'reminders', acao: 'apagar' },
  { tabela: 'orders', acao: 'apagar' },
  { tabela: 'user_health_conditions', acao: 'apagar' },
  { tabela: 'user_allergies', acao: 'apagar' },
  { tabela: 'user_medications', acao: 'apagar' },
  { tabela: 'user_addresses', acao: 'apagar' },
  { tabela: 'user_exam_results', acao: 'apagar' },
  // Nome e CRM do médico DO PACIENTE são dado pessoal dele. Estava faltando.
  { tabela: 'prescribers', acao: 'apagar' },

  // ── Estado operacional e memória: apaga ─────────────────────────────────────
  { tabela: 'assistant_tasks', acao: 'apagar' },
  { tabela: 'red_flag_pending', acao: 'apagar' },
  { tabela: 'feedback_events', acao: 'apagar' },
  { tabela: 'agent_skills', acao: 'apagar' },
  { tabela: 'entity_relations', acao: 'apagar' },
  { tabela: 'event_log', acao: 'apagar' },
  { tabela: 'memory_cards_index', acao: 'apagar' },
  { tabela: 'conversations', acao: 'apagar' },

  // ── Acesso: apaga PRIMEIRO, e é o mais urgente de tudo ──────────────────────
  // Sessão viva depois do apagamento = JWT válido lendo prontuário que não existe mais.
  { tabela: 'app_sessions', acao: 'apagar' },
  { tabela: 'device_tokens', acao: 'apagar' },
  // Link de médico vivo depois do apagamento = terceiro abrindo o prontuário de alguém
  // que pediu pra desaparecer.
  { tabela: 'share_grants', acao: 'apagar' },
  { tabela: 'app_media', acao: 'apagar' },
  { tabela: 'app_exports', acao: 'apagar' },

  // ── Preservado, com motivo ──────────────────────────────────────────────────
  {
    tabela: 'audit_log',
    acao: 'preservar',
    porque:
      'Append-only de compliance: é a prova de QUE o apagamento foi pedido e executado. ' +
      'Apagar o registro do apagamento destruiria a única evidência de que a LGPD foi cumprida.',
  },
  {
    tabela: 'consent_events',
    acao: 'preservar',
    porque:
      'Prova do aceite e da revogação (LGPD art. 8º §1º: o ônus da prova do consentimento ' +
      'é do controlador). Guarda user_id, tipo e versão da política — não conteúdo clínico.',
  },
  {
    tabela: 'system_logs',
    acao: 'preservar',
    porque:
      'Já nasce redatado por pino-redact e serve à operação (diagnóstico de incidente). ' +
      'O user_id sozinho, sem telefone nem conteúdo, não reidentifica.',
  },
  {
    tabela: 'users',
    acao: 'anonimizar',
    porque:
      'A LINHA fica, esvaziada: id preservado para que audit_log e consent_events sigam ' +
      'referenciando algo, e `deleted_at` marcado para que toda leitura recuse (ver o 404 ' +
      'user_gone em routes/app/overview.ts). Apagar a linha quebraria as FKs da prova.',
  },
] as const;

/**
 * As colunas de `users` que carregam PII ou dado clínico e precisam ser esvaziadas.
 *
 * Antes desta lista, a anonimização zerava TRÊS colunas — `phone_e164`, `full_name`,
 * `preferred_name` — e deixava para trás **CPF, data de nascimento, resumo clínico e o
 * telefone do contato de emergência**. O último é o pior: é o dado de um TERCEIRO, que
 * nunca pediu nada e não tem como pedir.
 *
 * Cada entrada diz o valor de destino, porque quatro dessas colunas são `NOT NULL` com
 * default e escrever `null` nelas falharia a UPDATE inteira — apagamento que estoura no
 * meio é o pior dos mundos.
 */
export const ANONIMIZACAO_USERS: ReadonlyArray<{ coluna: string; valor: unknown }> = [
  { coluna: 'full_name', valor: null },
  { coluna: 'preferred_name', valor: null },
  { coluna: 'birth_date', valor: null },
  { coluna: 'document_cpf', valor: null },
  { coluna: 'health_summary', valor: null },
  { coluna: 'emergency_contact_name', valor: null },
  { coluna: 'emergency_contact_phone_e164', valor: null },
  { coluna: 'emergency_contact_relation', valor: null },
  { coluna: 'home_city', valor: null },
  { coluna: 'home_state', valor: null },
  { coluna: 'adherence_score_30d', valor: null },
  { coluna: 'primary_doctor_id', valor: null },
  // Apontava para uma mensagem que acabou de ser apagada — referência órfã.
  { coluna: 'lgpd_consent_message_id', valor: null },
  // NOT NULL com default: volta ao default, nunca null.
  { coluna: 'gender', valor: 'not_informed' },
  { coluna: 'metadata', valor: {} },
  { coluna: 'communication_prefs', valor: {} },
  { coluna: 'professional_profile', valor: {} },
] as const;

/**
 * O patch completo da linha de `users`.
 *
 * `phone_e164` é NOT NULL e único: não pode virar null, e não pode continuar sendo o
 * telefone. Vira `deleted-<id>`, que é irreversível (não dá pra voltar ao número) e
 * único por construção — e é o que impede o telefone de ser reencontrado por busca.
 */
export function patchAnonimizacaoUser(userId: string, nowIso: string): Record<string, unknown> {
  const patch: Record<string, unknown> = {
    phone_e164: `deleted-${userId}`,
    deleted_at: nowIso,
  };
  for (const { coluna, valor } of ANONIMIZACAO_USERS) {
    // CÓPIA, não a referência. Os `{}` de `metadata`/`communication_prefs`/
    // `professional_profile` vivem na constante do módulo: devolver a mesma referência
    // faz o patch de um apagamento compartilhar objeto com o do próximo. Num worker que
    // processa uma fila de exclusões, qualquer mutação de um vaza pro seguinte — e o
    // seguinte é a conta de outra pessoa. Um teste pegou isso.
    patch[coluna] = valor !== null && typeof valor === 'object' ? structuredClone(valor) : valor;
  }
  return patch;
}

/** As tabelas a apagar por `user_id`, na ordem em que o executor deve tocá-las. */
export function tabelasParaApagar(): string[] {
  const apagar = PLANO_LGPD.filter((t) => t.acao === 'apagar').map((t) => t.tabela);
  // Acesso primeiro: enquanto a sessão vive, o dado ainda é alcançável. Se o apagamento
  // falhar no meio, é melhor ter fechado a porta antes de começar a limpar a casa.
  const primeiro = ['app_sessions', 'device_tokens', 'share_grants'];
  return [...primeiro, ...apagar.filter((t) => !primeiro.includes(t))];
}

/**
 * O VIGILANTE: tabelas com `user_id` que ninguém decidiu o que fazer.
 *
 * O teste exige `[]`. É este par de funções que transforma "a lista estava
 * desatualizada" — o defeito real de 12/08 — num erro de suíte em vez de um vazamento
 * silencioso descoberto meses depois.
 */
export function tabelasSemTratamento(): string[] {
  const tratadas = new Set(PLANO_LGPD.map((t) => t.tabela));
  return TABELAS_COM_USER_ID.filter((t) => !tratadas.has(t));
}

/** Tratamentos que sobrevivem ao apagamento sem justificar por quê. */
export function tratamentosSemJustificativa(): string[] {
  return PLANO_LGPD.filter((t) => t.acao !== 'apagar' && !t.porque?.trim()).map((t) => t.tabela);
}

/** Tabelas no plano que não existem no schema — plano desatualizado ao contrário. */
export function tratamentosDeTabelaInexistente(): string[] {
  const existentes = new Set<string>(TABELAS_COM_USER_ID);
  return PLANO_LGPD.filter((t) => !existentes.has(t.tabela)).map((t) => t.tabela);
}

// ─── A conversa do estabelecimento: o buraco que não era trivial ───────────────

/**
 * O que fazer com a conversa de uma farmácia ou clínica que fala sobre este paciente.
 *
 * O apagamento antigo tocava só as conversas com `user_id = <paciente>`. As conversas com
 * o ESTABELECIMENTO — que contêm o remédio pedido, o bairro da entrega, às vezes o nome —
 * ficavam intactas. Documentado como buraco, e nunca fechado. O levantamento de 12/08
 * mostrou por quê: **não é uma coisa, são duas.**
 *
 *   · **73 conversas** de fornecedor atendem UM paciente só. Nessas, apagar as mensagens
 *     é preciso e seguro.
 *   · **26 conversas** atendem de 2 a 8 pacientes diferentes. Apagar as mensagens dessas
 *     destruiria dado de gente que não pediu nada — trocar um vazamento por outro.
 *
 * Como `messages` não tem `user_id` (a linkagem é `orders → quotes.conversation_id`), não
 * existe forma de identificar cirurgicamente QUAIS mensagens de um fio compartilhado são
 * deste paciente. Então a decisão é por fio:
 *
 *   `apagar_mensagens`  — o fio é exclusivo dele.
 *   `redigir`           — o fio é compartilhado: remove os IDENTIFICADORES dele (telefone,
 *                         nome) e deixa o resto. É anonimização, que a LGPD aceita quando
 *                         a exclusão atingiria outros titulares.
 */
export type DestinoConversaEstabelecimento = 'apagar_mensagens' | 'redigir';

/**
 * O parâmetro é **OUTROS pacientes**, não o total — e a distinção não é estilo.
 *
 * A primeira versão recebia "pacientes no fio" e devolvia `apagar_mensagens` para `<= 1`.
 * O chamador, porém, conta os OUTROS (as cotações deste paciente já caíram por cascade
 * quando `orders` foi apagada). Com um único outro paciente no fio, `1` chegava aqui e a
 * função mandava APAGAR — destruindo o dado de alguém que não pediu nada.
 *
 * Peguei relendo o próprio código, antes de rodar. O nome do parâmetro estava certo na
 * função e errado na cabeça de quem chamou; renomear foi o que fez os dois concordarem.
 * Regra de bolso: em fronteira de apagamento, o parâmetro se chama pelo que é CONTADO.
 */
export function destinoDoFio(outrosPacientes: number): DestinoConversaEstabelecimento {
  // Estritamente ZERO. Qualquer outro titular no fio proíbe a exclusão.
  return outrosPacientes === 0 ? 'apagar_mensagens' : 'redigir';
}

/** O que substitui um identificador removido. Fica LEGÍVEL: o fio não vira enigma. */
export const MARCA_REDIGIDO = '[removido a pedido do titular]';

/**
 * Remove de um texto os identificadores de um paciente.
 *
 * Usado só nos fios compartilhados. Os identificadores vêm de quem chama (telefone em
 * todas as variantes do 9º dígito, nome completo, nome preferido) — esta função não
 * adivinha nada: ela substitui exatamente o que recebeu.
 *
 * Casa sem diferenciar acento nem caixa, porque "José" aparece como "jose" no texto de
 * fornecedor com a mesma frequência. E ignora identificador curto demais (menos de 4
 * caracteres): um nome preferido "Zé" viraria uma substituição que come pedaço de outras
 * palavras — redigir de menos é um problema, redigir palavra alheia é outro.
 */
export function redigirIdentificadores(texto: string, identificadores: readonly string[]): string {
  let saida = texto;
  for (const cru of identificadores) {
    const alvo = cru?.trim();
    if (!alvo || alvo.length < 4) continue;
    // Escapa metacaracteres: telefone tem `+`, que em regex significa outra coisa.
    const escapado = alvo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    saida = saida.replace(new RegExp(escapado, 'gi'), MARCA_REDIGIDO);
  }
  return saida;
}

/** O texto ainda contém algum dos identificadores? O vigilante da redação. */
export function aindaContemIdentificador(texto: string, identificadores: readonly string[]): boolean {
  const t = texto.toLowerCase();
  return identificadores.some((i) => {
    const alvo = i?.trim().toLowerCase();
    return !!alvo && alvo.length >= 4 && t.includes(alvo);
  });
}
