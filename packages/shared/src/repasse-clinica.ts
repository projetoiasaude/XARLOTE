/**
 * repasse-clinica — o que da conversa com o consultório o PACIENTE precisa ver.
 *
 * ─── AS DUAS FALHAS OPOSTAS ───────────────────────────────────────────────────
 * Este filtro existe entre dois incidentes que se contradizem, e é por isso que ele
 * é assimétrico de propósito.
 *
 * • 30/07, Glauber: o consultório pediu "foto da carteirinha do Ipasgo e do pedido
 *   médico, aguardar 72h". Nenhuma tool voltada ao paciente rodou, e ele NUNCA soube.
 *   O fluxo inteiro travou esperando um documento que ele não sabia que precisava
 *   mandar. Nasceu daí o backstop que repassa VERBATIM o que a clínica diz.
 *
 * • 24-25/08, Duda e Ciro: o mesmo backstop despejou no paciente o menu da recepção
 *   ("1.1- Nutrologia 1.2- Gastro…"), a apresentação da secretária ("Olá, sou a Rita,
 *   secretária do dr Rafael… Por favor, qual o seu nome?") e a conversa operacional
 *   ("Ok. Vou desmarcar aqui, obrigada"). Nada disso é acionável por quem está com dor
 *   de estômago: o menu e a pergunta são pra QUEM NEGOCIA, e quem negocia é a Xarlote.
 *
 * ─── A ASSIMETRIA ─────────────────────────────────────────────────────────────
 * Calar informação real custa uma consulta parada por dias. Repassar ruído custa uma
 * mensagem estranha. Então a estrutura é:
 *
 *   1. tem conteúdo ACIONÁVEL pro paciente?  → repassa
 *   2. é reconhecidamente cortesia/menu/operacional?  → não repassa
 *   3. na dúvida → REPASSA
 *
 * Só o que é CONFIDENTEMENTE inútil é barrado. O caso Glauber continua protegido: a
 * exigência de documento cai na regra 1 e passa.
 *
 * PURO: sem I/O, sem relógio.
 */
import { foldPt } from './br-datetime.js';
import { ehMenuDeAutoatendimento } from './pharmacy.js';

export type MotivoNaoRepassar = 'curto_demais' | 'menu' | 'cortesia' | 'operacional';

export type DecisaoRepasse =
  | { repassar: true; porque: string }
  | { repassar: false; motivo: MotivoNaoRepassar };

/**
 * Conteúdo que o paciente precisa ver. Qualquer um destes basta pra repassar.
 * Vale pra texto dobrado (minúsculo, sem acento).
 */
const ACIONAVEL: Array<[RegExp, string]> = [
  // Dinheiro em qualquer forma
  [/\br?\$\s*\d|\b\d{2,6}\s*reais\b|\bvalor\b|\bpre[cç]o\b|\bcusta\b|\bhonorario/, 'fala de valor'],
  // Data / hora / agenda
  [/\b\d{1,2}[\/hx:]\d{1,2}\b|\b\d{1,2}\s*h\b|\b(segunda|terca|quarta|quinta|sexta|sabado|domingo)\b|\b(amanha|hoje|semana que vem)\b|\bhorario/, 'fala de horário'],
  // Exigência de documento/preparo — o caso Glauber
  [/\b(envi\w+|mand\w+|trag\w+|apresent\w+|precisa\w*|necessario|solicitamos)\b[^.!?]{0,45}\b(foto|copia|documento|pedido|encaminhament|guia|carteirinha|exame|laudo|comprovant|jejum|receita)/, 'exige documento/preparo'],
  [/\b(pedido\s+medico|encaminhamento|carteirinha|guia\s+de\s+consulta)\b/, 'cita documento exigido'],
  // Indisponibilidade / recusa — o paciente precisa saber pra decidir outra clínica
  [/\bnao\b[^.!?]{0,25}\b(atende|temos|trabalha|aceita|faz|cobre|tem vaga|ha vaga)\b|\bsem\s+(vaga|agenda|disponibilidade)\b|\bagenda\s+(fechada|lotada|cheia)\b/, 'indisponibilidade'],
  // Plano / convênio
  [/\b(convenio|plano de saude|unimed|amil|bradesco|hapvida|sulamerica|notredame|ipasgo|particular)\b/, 'fala de plano'],
  // Endereço — é pra lá que ele vai
  [/\b(rua|avenida|av\.|setor|bairro|edificio|sala|andar|cep)\b/, 'passa endereço'],
  // Preparo/orientação clínica
  [/\b(jejum|preparo|chegar\s+\d|antecedencia|levar)\b/, 'orientação de preparo'],
];

/**
 * Cortesia pura: cumprimento, apresentação, agradecimento, despedida. Sozinhas não
 * dizem nada ao paciente — e chegam em quase toda primeira mensagem de recepção.
 */
const CORTESIA: RegExp[] = [
  /\b(bom dia|boa tarde|boa noite|ola|oi|seja bem vind|tudo bem)\b/,
  /\b(obrigad[ao]|de nada|disponha|imagina|por nada)\b/,
  /\bsou\s+a?\s*\w+[,.]?\s*(secretaria|recepcionista|atendente)\b|\b(secretaria|recepcionista)\s+d[oa]\b/,
  /\bprecisando\b[^.!?]{0,20}\b(chamar|falar|contatar)\b/,
  /\b(as ordens|a disposicao|estamos a disposicao)\b/,
];

/**
 * Conversa OPERACIONAL dirigida a quem negocia (a Xarlote), não ao paciente:
 * confirmações de processo interno, promessas de retorno, pedidos de dado do cadastro.
 */
const OPERACIONAL: RegExp[] = [
  /\bvou\s+(verificar|ver|checar|conferir|desmarcar|cancelar|anotar|passar)\b/,
  /\b(um momento|so um instante|aguarde|aguarda|ja te retorno|ja retorno|ja verifico)\b/,
  /\bqual\s+(o\s+)?seu\s+nome\b|\bcomo\s+posso\s+(te\s+)?(atender|ajudar)\b/,
  /\bpode\s+(me\s+)?(informar|passar)\b[^.!?]{0,25}\b(nome|cpf|telefone|contato)\b/,
];

function algum(f: string, tabela: RegExp[]): boolean {
  return tabela.some((re) => re.test(f));
}

/**
 * Vale a pena levar esta fala da clínica ao paciente?
 *
 * `porque` é a etiqueta do sinal que autorizou o repasse — vai pro log, pra quando
 * alguém precisar entender por que uma mensagem passou (ou não).
 */
export function decidirRepasseAoPaciente(texto: string): DecisaoRepasse {
  const t = (texto ?? '').trim();
  if (t.length < 15) return { repassar: false, motivo: 'curto_demais' };

  const f = foldPt(t);

  // 1. Acionável vence tudo — inclusive um menu que traga exigência de documento.
  const acionavel = ACIONAVEL.find(([re]) => re.test(f));
  if (acionavel) return { repassar: true, porque: acionavel[1] };

  // 2. Menu de autoatendimento sem nada acionável dentro.
  if (ehMenuDeAutoatendimento(t)) return { repassar: false, motivo: 'menu' };

  // 3. Operacional antes de cortesia: "Vou desmarcar aqui, obrigada" tem as duas
  //    marcas, e o que ela é de verdade é processo interno.
  if (algum(f, OPERACIONAL)) return { repassar: false, motivo: 'operacional' };

  // 4. Cortesia pura. Exige que NADA além de cortesia esteja no texto — por isso vem
  //    depois de todas as outras portas.
  if (algum(f, CORTESIA)) return { repassar: false, motivo: 'cortesia' };

  // 5. Não reconheci. Repassa — calar informação real é o erro mais caro dos dois.
  return { repassar: true, porque: 'não reconhecido (na dúvida, repassa)' };
}
