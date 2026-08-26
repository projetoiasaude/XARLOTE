/**
 * Lembretes do paciente — a lista, a criação, e as três ações (feito / adiar / cancelar).
 *
 * ## O penhasco do item 121 (o que esta rota consertou)
 *
 * A primeira versão do GET era `.order('next_run_at', asc, nullsFirst:false).limit(120)`
 * sem filtro de status. Lembrete encerrado NUNCA perde a data: `reminderActionPatch`
 * grava `{status:'cancelled'}` no cancelar e `{status:'acknowledged'}` no feito de
 * one-shot, e o dispatcher grava `{status:'sent'}` no claim — nenhum deles zera
 * `next_run_at`. Então todo cadáver guarda um instante no PASSADO, para sempre.
 *
 * Como o `ORDER BY next_run_at ASC` põe o passado PRIMEIRO, o `LIMIT 120` cortava pelo
 * lado errado: passado o 120º lembrete da vida do paciente, a tela recebia só cadáver
 * de meses atrás e o remédio de HOJE (next_run_at no futuro) ficava fora da janela. Não
 * é degradação gradual — é um penhasco: no item 120 a tela está perfeita, no 121 o
 * bloco "Passou da hora" (construído pro caso Arthur, 44% de adesão) enche de lixo
 * antigo e a dose de hoje desaparece.
 *
 * O conserto é partir a lista em consultas de naturezas diferentes:
 *
 *  • **vivos** (`STATUS_ATIVOS`): conjunto pequeno, lido em DUAS JANELAS (o vencido e o
 *    que ainda vem — ver `lerAtivos`), pra que o teto seja um limite de PAYLOAD e não
 *    um filtro que decide o que o paciente vê. Truncar é anunciado (`truncado`), nunca
 *    silencioso.
 *  • **histórico**: cresce para sempre, então é paginado por CURSOR KEYSET
 *    (`created_at desc, id desc`), nunca OFFSET, e só é pedido quando o paciente abre a
 *    seção. Abrir a aba não baixa histórico nenhum. Ele é o que o paciente JÁ RESOLVEU,
 *    e isso são duas populações: os `STATUS_ENCERRADOS` e o que foi confirmado pelo
 *    WhatsApp sem que ninguém gravasse o status (ver `lerConfirmadosPorFora`).
 *
 * ### O penhasco não some com um teto — ele só muda de lugar
 *
 * A primeira versão deste conserto filtrava por status e cortava em 60, ainda com
 * `next_run_at ASC`. Isso move o penhasco do item 121 pro item 61: **vencido ordena
 * PRIMEIRO**, e o conjunto de vencidos é justamente o que cresce sem teto (lembrete de
 * uma vez só que ninguém confirmou fica vencido pra sempre). Com 60 vivos-vencidos, a
 * consulta devolvia 60 atrasos antigos e a dose de HOJE — `next_run_at` no futuro —
 * ficava fora da janela outra vez.
 *
 * Daí as duas janelas: o vencido é lido do mais RECENTE pro mais antigo com teto
 * pequeno (o atraso que importa é o de hoje, não o de março), e o futuro é lido do mais
 * próximo pro mais distante com o teto grande. O corte de um lado nunca alcança o
 * outro. Custa uma consulta a mais e devolve a garantia de que a dose de hoje está lá.
 *
 * ### Por que `created_at` e não "quando encerrou"
 *
 * "Mais recentemente resolvido primeiro" seria a ordem ideal, e a coluna para isso
 * seria `updated_at` — mas `reminders` **não tem trigger `set_updated_at`** (confere:
 * o schema cria o trigger em users/conversations/orders/quotes e NÃO em reminders), e
 * nenhum caminho de escrita o preenche à mão. Ordenar por um carimbo que quase sempre
 * é igual ao `created_at` seria fingir precisão. `created_at` é imutável — e cursor
 * keyset sobre chave imutável não repete nem pula página, que é o requisito de verdade.
 *
 * ## Compatibilidade com o binário JÁ INSTALADO
 *
 * O app no aparelho do paciente chama `GET /app/reminders` sem parâmetro nenhum e lê
 * `data.reminders`. Sem `scope`, a rota devolve exatamente isso — os vivos + a primeira
 * página do histórico numa lista só. O app antigo continua funcionando E ganha o
 * conserto do penhasco de graça, porque agora os vivos são buscados em consulta própria
 * e não competem mais por vaga com o cemitério.
 *
 * ## Por que a ação vive AQUI e não no plugin legado
 *
 * Os dois plugins montam sob o mesmo prefixo `/app`, e Fastify não registra dois
 * handlers para `/app/reminders/:id/action`. Como o web legado ainda chama essa rota
 * com token compartilhado + telefone no corpo, e o app nativo chama com JWT, a rota
 * é ÚNICA e reconhece as duas credenciais — o "dual-auth" previsto no plano.
 *
 * A ordem importa e é deliberada: **tenta o JWT primeiro**. `requireAppToken` leria o
 * mesmo header `Authorization: Bearer`, acharia um JWT onde esperava o token do app e
 * responderia 401 — o app nativo nunca conseguiria confirmar um remédio.
 *
 * O que NÃO acontece aqui: o JWT valer como credencial nas outras rotas legadas. Um
 * paciente autenticado não ganha `POST /app/overview` com telefone arbitrário — é
 * exatamente o buraco que a F0 fechou. A exceção é uma rota só, e por um motivo
 * mecânico (colisão de path), não por conveniência.
 *
 * ## Autorização é por DONO, sempre
 *
 * Nos dois caminhos o lembrete é comparado com o usuário resolvido (`user_id`) antes
 * do patch. Sem isso, um id de lembrete adivinhado deixaria alguém cancelar o
 * remédio de outra pessoa — a cadeia de ataque que a auditoria de 05/08 documentou.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { db, findUserByPhone, writeEvent } from '@iasaude/db';
import { brPhoneVariants, nextOccurrence, reminderActionPatch } from '@iasaude/shared';
import { requirePatient, tryPatient } from '../../middleware/patient-auth.js';
import { resolverSujeitoDaRequisicao } from '../../lib/care-subject.js';
import { requireAppToken } from '../../middleware/auth.js';
import { checkUserRateLimit } from '../../middleware/rate-limit.js';
import { decodeCursor, encodeCursor } from '../../lib/messages-cursor.js';

/**
 * As colunas que o app desenha. `select('*')` traria campos internos sem uso.
 *
 * `payload` saiu: é um JSONB arbitrário (condição de backup, `event_at`, origem) que
 * NENHUMA tela do app lê — grep em apps/mobile não acha um leitor. Ele viajava em toda
 * abertura da aba, em rede móvel, e ainda era gravado no cache em disco do aparelho.
 */
const REMINDER_COLUMNS =
  'id, type, title, body, scheduled_at, rrule, next_run_at, status, medication_id, created_at, last_confirmed_at';

/**
 * A PARTIÇÃO do enum `reminder_status_t`, e é uma partição de verdade: todo status cai
 * em exatamente uma das duas listas. União = os 5 valores do enum, interseção = vazio.
 *
 * Isso não é zelo de tipagem — é a invariante que faz a tela não perder lembrete. Se
 * uma migration acrescentar um status ao enum e ninguém o classificar aqui, ele fica
 * FORA das duas consultas e o lembrete desaparece do app sem erro nenhum. O vigilante
 * que quebra a suíte nesse caso está em `tests/mobile-reminders-agenda.test.ts`, e ele
 * lê o enum do `schema.sql` e as duas listas DESTE arquivo e do cliente.
 *
 * `failed` NÃO entra: não existe no enum, e `.in('status', [...])` com valor fora do
 * enum é erro do Postgres — a consulta inteira falharia (o cliente trata `failed` como
 * encerrado por tolerância a dado legado, o servidor não pode).
 */
const STATUS_ATIVOS = ['pending', 'sent', 'snoozed'] as const;
const STATUS_ENCERRADOS = ['acknowledged', 'cancelled'] as const;

/**
 * Teto da janela dos VENCIDOS. Pequeno de propósito: o atraso que pede ação é o
 * recente, e a janela é lida do mais novo pro mais velho. O vencido de março não muda
 * nenhuma decisão de hoje — e é ele que cresce sem limite.
 */
const VENCIDOS_MAX = 15;

/**
 * Teto da janela do que AINDA VEM (mais os sem data). Largo: um polimedicado com 8
 * remédios em 4 horários chega a ~32 lembretes ativos, e aqui o corte é no futuro mais
 * distante, que é o lado descartável.
 */
const FUTUROS_MAX = 45;

/**
 * Quanto a janela dos vencidos lê a mais do que devolve.
 *
 * A poda dos confirmados-por-fora (ver `confirmadoForaDoApp`) acontece em JS, e não no
 * `WHERE`, porque a condição compara DUAS COLUNAS (`last_confirmed_at >= next_run_at`)
 * e o PostgREST só compara coluna com literal. Ler 3× e podar depois é o que impede
 * esses cadáveres de comerem as vagas dos atrasos de verdade — que é o mesmo penhasco,
 * uma escala abaixo. 46 linhas curtas num índice é custo de arredondamento.
 */
const SOBRA_VENCIDOS = 3;

/** Página do histórico. Pequena porque é rolagem sob demanda, não carga inicial. */
const HISTORICO_PAGINA = 12;
const HISTORICO_MAX = 50;

/**
 * Quanto histórico o app ANTIGO recebe junto dos vivos. Ele monta tudo numa
 * `ScrollView` sem virtualização, então o número é conservador de propósito.
 */
const HISTORICO_LEGADO = 20;

/**
 * Teto de lembretes ATIVOS por paciente, cobrado na criação.
 *
 * O pedido do fundador foi "os lembretes vão se acumulando infinitamente". Paginar a
 * leitura resolve a TELA; o teto aqui resolve a CAUSA no lado da escrita pela mão do
 * paciente. 40 ativos é mais do que qualquer tratamento real precisa — quem bate nele
 * está criando duplicata, e a resposta diz isso em português.
 */
const ATIVOS_POR_PACIENTE = 40;

const ActionSchema = z.object({
  /** Só no caminho legado — no caminho JWT o telefone é ignorado se vier. */
  phone: z.string().min(8).max(20).optional(),
  action: z.enum(['done', 'snooze', 'cancel']),
  minutes: z.number().int().min(5).max(24 * 60).optional(),
});

const ListaQuery = z.object({
  /** Ausente = modo legado (vivos + 1ª página do histórico numa lista só). */
  scope: z.enum(['active', 'history']).optional(),
  cursor: z.string().max(256).optional(),
  limit: z.coerce.number().int().min(1).max(HISTORICO_MAX).optional(),
});

/**
 * O lembrete que o paciente cria pela tela — três campos, e nada mais.
 *
 * Três porque é o que uma pessoa de 55 anos preenche sem hesitar: o quê, que horas,
 * todo dia. Data explícita ficou de FORA de propósito: "não é todo dia" resolve como a
 * próxima vez que aquele horário chegar (hoje mais tarde, ou amanhã), que cobre o caso
 * real ("me lembra às 20h de levar o exame") sem um seletor de calendário — que, além
 * de ser mais um campo, exigiria dependência nativa nova e portanto build novo.
 */
const CriarSchema = z.object({
  title: z.string().trim().min(2).max(80),
  /** `HH:MM` no horário de BRASÍLIA — o mesmo fuso que o `nextOccurrence` interpreta. */
  time: z.string().regex(/^([01]?\d|2[0-3]):[0-5]\d$/),
  daily: z.boolean(),
  /** O ícone e o rótulo da linha saem daqui. Restrito ao que o enum aceita. */
  type: z.enum(['medication', 'appointment', 'custom']).default('medication'),
  body: z.string().trim().max(200).optional(),
});

async function findUserByAnyVariant(phoneRaw: string) {
  const trimmed = phoneRaw.replace(/[^\d+]/g, '');
  const e164 = trimmed.startsWith('+') ? trimmed : `+${trimmed}`;
  if (!/^\+\d{10,15}$/.test(e164)) return null;
  for (const candidate of brPhoneVariants(e164)) {
    const user = await findUserByPhone(candidate);
    if (user) return user;
  }
  return null;
}

/**
 * Quem está pedindo — JWT do app, ou token compartilhado + telefone (web legado).
 *
 * Devolve `null` quando já respondeu (401/429/404): quem chama só precisa sair.
 */
async function resolveOwner(
  req: FastifyRequest,
  reply: FastifyReply,
  phone: string | undefined,
): Promise<string | null> {
  const patient = tryPatient(req);
  if (patient) {
    /**
     * Marcar `req.patient` NÃO é decoração — é o que a auditoria lê.
     *
     * A primeira versão devolvia só o `userId`, e o `writeEvent` logo abaixo grava
     * `via: req.patient ? 'jwt' : 'legacy_token'`. Sem esta linha, TODA ação vinda do app
     * nativo era registrada como `legacy_token`. Peguei no primeiro toque real: o
     * lembrete foi adiado com sucesso pelo JWT e o log disse que veio do token do web.
     *
     * O campo existe pra sustentar UMA decisão específica — no F5, provar que ninguém
     * mais chega por telefone antes de remover a rota legada. Um campo que sempre diz
     * "legado" faria essa decisão em cima de dado falso, e a rota antiga ficaria viva
     * pra sempre (ou seria removida às cegas). Detecção que não propaga é pior que
     * ausência de detecção.
     */
    req.patient = patient;
    return patient.userId;
  }

  // Caminho legado. O plugin novo não tem hook global, então os dois guardas que o
  // legado aplicava (token do app + anti-flood) são chamados à mão — tirá-los junto
  // com a mudança de arquivo transformaria um refactor em regressão de segurança.
  await requireAppToken(req, reply);
  if (reply.sent) return null;

  if (!phone) {
    await reply.code(401).send({ error: 'unauthorized' });
    return null;
  }

  const rl = await checkUserRateLimit(`app:${phone}`);
  if (!rl.allowed) {
    await reply
      .code(429)
      .send({ error: 'rate_limited', message: 'Calma! Muitas ações em sequência. Tenta de novo em alguns segundos.' });
    return null;
  }

  const user = await findUserByAnyVariant(phone);
  if (!user) {
    await reply.code(404).send({ error: 'user_not_found' });
    return null;
  }
  return user.id;
}

export interface LinhaLembrete {
  id: string;
  created_at?: string | null;
  [k: string]: unknown;
}

/**
 * Quantos encerrados existem — só o número, sem trazer linha (`head: true`).
 *
 * Ele viaja com a lista VIVA, e não com o histórico, e isso é o ponto: a tela precisa do
 * número pra desenhar o cabeçalho recolhido ("Já resolvidos · 143") ANTES de o paciente
 * abrir a seção. Sem ele, a seção fechada seria indistinguível de uma seção vazia — e
 * seção que parece vazia ensina que o app não guarda aquilo.
 *
 * `null` quando a contagem falha: a tela mostra a seção sem número em vez de mostrar
 * zero. Zero é uma afirmação sobre o banco, e não temos o direito de fazê-la aqui.
 */
async function contarEncerrados(userId: string): Promise<number | null> {
  const [fechados, confirmados] = await Promise.all([
    db
      .from('reminders')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .in('status', STATUS_ENCERRADOS as unknown as string[]),
    // A MESMA condição de `lerConfirmadosPorFora` — o que o histórico devolve tem que
    // ser o que o cabeçalho conta. Duas contagens porque não existe um `status` só que
    // descreva as duas populações; ver o docblock de `confirmadoForaDoApp`.
    db
      .from('reminders')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .in('status', STATUS_ATIVOS as unknown as string[])
      .is('rrule', null)
      .not('last_confirmed_at', 'is', null),
  ]);

  // Qualquer uma das duas falhando devolve `null` ("não deu pra contar"), nunca a
  // parcial: somar só metade é afirmar um número menor do que o banco tem, e a tela
  // imprimiria essa afirmação como verdade.
  if (fechados.error || confirmados.error) return null;

  /**
   * A segunda contagem erra pra CIMA num caso raro e conhecido: o lembrete confirmado e
   * DEPOIS adiado (`last_confirmed_at < next_run_at`) continua vivo e não vai pro
   * histórico, mas conta aqui — a condição que o exclui compara duas colunas, e o
   * PostgREST só compara coluna com literal. Preferir errar pra cima é deliberado: o
   * caminho oposto seria a seção prometer menos do que ela mostra.
   */
  return (fechados.count ?? 0) + (confirmados.count ?? 0);
}

function instanteDe(v: unknown): number | null {
  if (typeof v !== 'string') return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * O lembrete que já foi confirmado por fora do app — e que o status não denuncia.
 *
 * Os dois caminhos de confirmação por WhatsApp (`handleLogMedicationTaken` no
 * tool-executor e o backstop do inbound-user) gravam SÓ `last_confirmed_at`; o `status`
 * continua 'sent', que é ATIVO. Como o `next_run_at` de um lembrete de uma vez só nunca
 * avança, ele vira um vencido permanente: ocupa vaga na janela dos atrasos, aparece no
 * app como "Passou da hora" e nunca sai da lista viva. É o acúmulo que o fundador
 * relatou, com a agravante de a tela cobrar uma dose que o sistema já registrou.
 *
 * `rrule` presente NÃO cai aqui, e essa guarda é o coração da função: num recorrente o
 * carimbo é da ocorrência ANTERIOR e o claim do dispatcher já empurrou `next_run_at`
 * pra próxima. Sem a guarda, um atraso de dispatcher esconderia um remédio de TODO DIA.
 *
 * O conserto definitivo é os dois caminhos gravarem `status:'acknowledged'` junto do
 * carimbo quando `rrule is null` — que é o que a ação do app já faz
 * (`packages/shared/src/reminder-actions.ts`). Enquanto isso não acontece, esta função
 * é o ÚNICO juiz das duas pontas: ela tira a linha da lista viva (`podarJanela`) e a
 * põe no acervo (`lerConfirmadosPorFora`). Usar predicados diferentes nas duas pontas
 * criaria o pior desfecho possível — a linha some da lista E não aparece no histórico,
 * que é exatamente o defeito que a primeira versão da poda deixou no ar.
 */
export function confirmadoForaDoApp(l: LinhaLembrete): boolean {
  if (l['rrule']) return false;
  const confirmado = instanteDe(l['last_confirmed_at']);
  if (confirmado === null) return false;
  const alvo = instanteDe(l['next_run_at']) ?? instanteDe(l['scheduled_at']);
  // Confirmado e sem horário nenhum: não há o que cobrar. Com horário, só encerra se a
  // confirmação veio DEPOIS dele — adiar depois de confirmar empurra `next_run_at` pro
  // futuro e reabre a linha, que é o certo.
  return alvo === null || confirmado >= alvo;
}

function podarJanela(data: unknown, teto: number): { linhas: LinhaLembrete[]; truncado: boolean } {
  const brutas = (data ?? []) as unknown as LinhaLembrete[];
  const vivas = brutas.filter((l) => !confirmadoForaDoApp(l));
  return { linhas: vivas.slice(0, teto), truncado: vivas.length > teto };
}

/**
 * A janela dos VENCIDOS — do atraso mais recente pro mais antigo.
 *
 * DESC é o ponto: o atraso que pede ação é o de hoje. Ordenar ASC aqui (que é o que a
 * lista fazia antes) entrega o vencido de março e corta o de ontem.
 *
 * O desempate por `id` não é enfeite: dois lembretes no MESMO minuto (o incidente B6)
 * sairiam em ordem indefinida a cada consulta, e a tela piscaria trocando as duas
 * linhas de lugar.
 */
async function lerVencidos(userId: string, agoraIso: string) {
  const { data, error } = await db
    .from('reminders')
    .select(REMINDER_COLUMNS)
    .eq('user_id', userId)
    .in('status', STATUS_ATIVOS as unknown as string[])
    // `.lt` não devolve NULL (comparação com NULL é desconhecida) — os sem data ficam
    // todos com a outra janela, então nenhum lembrete cai entre as duas.
    .lt('next_run_at', agoraIso)
    .order('next_run_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(VENCIDOS_MAX * SOBRA_VENCIDOS + 1);

  if (error) return null;
  return podarJanela(data, VENCIDOS_MAX);
}

/**
 * A janela do que AINDA VEM, mais os sem data — do mais próximo ao mais distante.
 *
 * `nullsFirst: false` porque lembrete pendente sem próxima execução (dado torto,
 * acontece) tem que ir pro fim: o topo da lista é o que ainda vai acontecer. Ele entra
 * aqui, e não na janela dos vencidos, porque "sem data" não é atraso — some da tela é
 * que ele não pode.
 */
async function lerFuturos(userId: string, agoraIso: string) {
  const { data, error } = await db
    .from('reminders')
    .select(REMINDER_COLUMNS)
    .eq('user_id', userId)
    .in('status', STATUS_ATIVOS as unknown as string[])
    // Aspas DUPLAS no instante pelo mesmo motivo do cursor do histórico: o valor entra
    // cru na expressão `or=(...)` e um `+` decodificado como espaço viraria timestamp
    // inválido — o filtro pararia de cortar.
    .or(`next_run_at.gte."${agoraIso}",next_run_at.is.null`)
    .order('next_run_at', { ascending: true, nullsFirst: false })
    .order('id', { ascending: true })
    .limit(FUTUROS_MAX + 1);

  if (error) return null;
  return podarJanela(data, FUTUROS_MAX);
}

/**
 * Os lembretes VIVOS: os vencidos recentes primeiro, depois o que ainda vem.
 *
 * As duas janelas usam o MESMO `agoraIso` de propósito — instantes diferentes deixariam
 * uma fresta entre `< agora` e `>= agora` por onde um lembrete sumiria (ou apareceria
 * duas vezes) exatamente no minuto do vencimento, que é o pior minuto possível.
 */
async function lerAtivos(userId: string): Promise<{ linhas: LinhaLembrete[]; truncado: boolean } | null> {
  const agoraIso = new Date().toISOString();
  const [vencidos, futuros] = await Promise.all([lerVencidos(userId, agoraIso), lerFuturos(userId, agoraIso)]);
  if (!vencidos || !futuros) return null;

  return {
    linhas: [...vencidos.linhas, ...futuros.linhas],
    // Truncar em QUALQUER das janelas é truncar a lista. A tela diz isso em uma frase;
    // qual dos dois lados cortou não muda o que ela pede ao paciente (cancelar o que
    // não usa mais).
    truncado: vencidos.truncado || futuros.truncado,
  };
}

/**
 * A expressão keyset `(created_at, id) < cursor` no dialeto do PostgREST.
 *
 * O PostgREST não tem comparação de tupla, então vira "mais antigo OU (mesmo instante E
 * id menor)". Aspas DUPLAS de propósito: o timestamp vem como
 * `2026-08-10T13:45:00.123456+00:00` e a string entra crua na expressão `or=(...)`; sem
 * as aspas, o `+` decodificado como espaço viraria timestamp inválido e o filtro pararia
 * de cortar, repetindo página.
 *
 * Está numa função porque o histórico é lido de DUAS populações (ver `lerHistorico`) e
 * as duas precisam da mesma fronteira. Duas cópias da mesma expressão divergiriam, e
 * cursores diferentes nas duas consultas repetem ou pulam linha na virada de página.
 */
function filtroKeyset(cursor: { createdAt: string; id: string }): string {
  const at = `"${cursor.createdAt}"`;
  return `created_at.lt.${at},and(created_at.eq.${at},id.lt."${cursor.id}")`;
}

/**
 * A ordem do acervo: `created_at desc, id desc` — a MESMA das duas consultas.
 *
 * O desempate por instante usa o número (o que o Postgres ordena) e, em caso de empate
 * na milésima, cai na string crua — `created_at` tem MICROssegundos no Postgres e
 * `Date.parse` os descarta. Sem esse segundo degrau, duas linhas do mesmo milissegundo
 * sairiam daqui numa ordem e do banco em outra, e o cursor pularia uma delas.
 */
export function maisNovoPrimeiro(a: LinhaLembrete, b: LinhaLembrete): number {
  const ta = instanteDe(a.created_at);
  const tb = instanteDe(b.created_at);
  // Sem `created_at` vai pro FIM, como o `nullsFirst: false` das duas consultas.
  if (ta === null && tb !== null) return 1;
  if (tb === null && ta !== null) return -1;
  if (ta !== null && tb !== null && ta !== tb) return tb - ta;
  const sa = String(a.created_at ?? '');
  const sb = String(b.created_at ?? '');
  if (sa !== sb) return sa < sb ? 1 : -1;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

/** Uma página crua de encerrados de verdade (`acknowledged` / `cancelled`). */
async function lerEncerrados(
  userId: string,
  teto: number,
  cursor: { createdAt: string; id: string } | null,
): Promise<LinhaLembrete[] | null> {
  let q = db
    .from('reminders')
    .select(REMINDER_COLUMNS)
    .eq('user_id', userId)
    .in('status', STATUS_ENCERRADOS as unknown as string[])
    // `nullsFirst: false` também no DESC: o default do Postgres para DESC é NULLS
    // FIRST, e uma linha sem `created_at` fixaria o topo do histórico para sempre —
    // com cursor nulo, a paginação nunca sairia dela.
    .order('created_at', { ascending: false, nullsFirst: false })
    .order('id', { ascending: false })
    .limit(teto + 1);

  if (cursor) q = q.or(filtroKeyset(cursor));

  const { data, error } = await q;
  if (error) return null;
  return (data ?? []) as unknown as LinhaLembrete[];
}

/**
 * Quanto a janela dos confirmados-por-fora lê a mais do que aproveita.
 *
 * A condição final (`confirmadoForaDoApp`) compara DUAS COLUNAS e por isso roda em JS,
 * depois da consulta — então uma parte das linhas lidas é descartada. Ler 3× é o que
 * evita página curta. Página curta aqui não PERDE linha (a próxima varre de novo a
 * partir da última emitida), só custa um toque a mais em "ver mais".
 */
const SOBRA_CONFIRMADOS = 3;

/**
 * As linhas que o paciente confirmou PELO WHATSAPP e que status nenhum denuncia.
 *
 * `handleLogMedicationTaken` (tool-executor) e o backstop do inbound-user gravam SÓ
 * `last_confirmed_at` e deixam o `status` em 'sent' — que é ATIVO. `podarJanela` tira
 * essas linhas da lista viva (senão a tela cobraria uma dose que o sistema já
 * registrou), e sem esta consulta elas não estariam em lugar NENHUM do app: nem na
 * lista, nem no acervo, enquanto a seção "Já resolvidos" promete por escrito que "quando
 * você confirmar ou cancelar um lembrete, ele fica registrado aqui". Com 26 pacientes
 * vivendo no WhatsApp, esse é hoje o caminho de confirmação mais usado.
 *
 * Isto é PALIATIVO, e o conserto definitivo continua sendo o do docblock de
 * `confirmadoForaDoApp`: os dois caminhos gravarem `status:'acknowledged'` junto do
 * carimbo quando `rrule is null`. No dia em que isso acontecer, estas linhas passam a
 * vir pela consulta de cima e esta aqui devolve vazio sozinha — nada quebra, e nada
 * aparece duas vezes (as duas populações são disjuntas por status).
 */
async function lerConfirmadosPorFora(
  userId: string,
  teto: number,
  cursor: { createdAt: string; id: string } | null,
): Promise<{ linhas: LinhaLembrete[]; truncado: boolean; ultimaLida: LinhaLembrete | null } | null> {
  const pedido = (teto + 1) * SOBRA_CONFIRMADOS;
  let q = db
    .from('reminders')
    .select(REMINDER_COLUMNS)
    .eq('user_id', userId)
    .in('status', STATUS_ATIVOS as unknown as string[])
    // Recorrente NUNCA entra: o carimbo dele é da ocorrência anterior e o lembrete
    // segue vivo. Mandar um remédio de TODO DIA pro acervo é o pior desfecho da tela.
    .is('rrule', null)
    .not('last_confirmed_at', 'is', null)
    .order('created_at', { ascending: false, nullsFirst: false })
    .order('id', { ascending: false })
    .limit(pedido);

  if (cursor) q = q.or(filtroKeyset(cursor));

  const { data, error } = await q;
  if (error) return null;

  const brutas = (data ?? []) as unknown as LinhaLembrete[];
  return {
    linhas: brutas.filter(confirmadoForaDoApp),
    truncado: brutas.length >= pedido,
    ultimaLida: brutas[brutas.length - 1] ?? null,
  };
}

/**
 * Uma página do histórico, do mais recente ao mais antigo, por cursor keyset.
 *
 * Keyset e não OFFSET pelo motivo de sempre: `OFFSET 500` varre 500 linhas pra jogar
 * fora, e o custo cresce justamente pro paciente de dois anos de uso. Aqui a página
 * 1 e a página 40 custam o mesmo.
 *
 * ## Duas populações, uma página
 *
 * O acervo não é "status encerrado": é **o que o paciente já resolveu**. Isso inclui o
 * que ele confirmou pelo WhatsApp, que continua com status ativo (ver
 * `lerConfirmadosPorFora`). As duas consultas usam a MESMA fronteira de cursor e a MESMA
 * ordem, então a fusão é um merge de duas listas já ordenadas — e o corte em `teto` sai
 * correto porque cada lado leu mais do que a página comporta.
 *
 * A linha perdida é impossível por construção: o cursor da próxima página é a ÚLTIMA
 * LINHA EMITIDA, e as duas consultas recomeçam a varredura a partir dele. Tudo que ficou
 * abaixo do corte de qualquer um dos lados é reconsiderado na página seguinte.
 */
async function lerHistorico(
  userId: string,
  teto: number,
  cursor: { createdAt: string; id: string } | null,
): Promise<{ linhas: LinhaLembrete[]; proximoCursor: string | null } | null> {
  const [encerrados, confirmados] = await Promise.all([
    lerEncerrados(userId, teto, cursor),
    lerConfirmadosPorFora(userId, teto, cursor),
  ]);
  if (!encerrados || !confirmados) return null;

  const todas = [...encerrados, ...confirmados.linhas].sort(maisNovoPrimeiro);
  const pagina = todas.slice(0, teto);

  // `confirmados.truncado` também abre a próxima página: a poda em JS pode ter esvaziado
  // uma leitura cheia, e aí `todas.length` não denuncia que ainda há linha embaixo.
  const temMais = todas.length > teto || confirmados.truncado;

  // A âncora da próxima página é a última linha EMITIDA. Quando a página saiu vazia mas
  // ainda há o que varrer (leitura cheia, tudo podado), a âncora é a última linha LIDA —
  // ela não vai pra tela, mas marca até onde este lado já foi.
  const ancora = pagina[pagina.length - 1] ?? confirmados.ultimaLida;

  // Sem `created_at` na âncora não há de onde continuar. Devolver cursor inventado
  // repetiria a página; dizer "acabou" é a única resposta honesta.
  const proximoCursor =
    temMais && ancora?.created_at
      ? encodeCursor({ createdAt: ancora.created_at, id: ancora.id })
      : null;

  return { linhas: pagina, proximoCursor };
}

export async function appRemindersRoutes(app: FastifyInstance): Promise<void> {
  /**
   * A lista. O overview também traz lembretes, mas a tela de Lembretes recarrega
   * sozinha (voltou do background, confirmou uma dose) — e puxar as 14 consultas do
   * prontuário inteiro pra atualizar uma lista seria desperdício numa rede móvel.
   */
  app.get('/reminders', { preHandler: requirePatient }, async (req, reply) => {
    const parsed = ListaQuery.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_query' });

    // 🤝 Lembretes de quem ele cuida, quando `?subject=` vem preenchido.
    const sujeito = await resolverSujeitoDaRequisicao(req, reply, 'ver');
    if (!sujeito) return;
    const userId = sujeito.userId;
    const { scope } = parsed.data;

    if (scope === 'history') {
      const cursor = parsed.data.cursor ? decodeCursor(parsed.data.cursor) : null;
      // Cursor presente mas ilegível é ERRO, não "começa do zero": voltar pro topo em
      // silêncio faria o app repetir o histórico no meio da rolagem.
      if (parsed.data.cursor && !cursor) return reply.code(400).send({ error: 'invalid_cursor' });

      const r = await lerHistorico(userId, parsed.data.limit ?? HISTORICO_PAGINA, cursor);
      if (!r) return reply.code(500).send({ error: 'query_failed' });
      return reply.send({ scope: 'history', reminders: r.linhas, nextCursor: r.proximoCursor });
    }

    if (scope === 'active') {
      // As duas em paralelo: a lista viva e o TAMANHO do acervo. O acervo em si só é
      // pedido quando o paciente abre a seção.
      const [ativos, encerrados] = await Promise.all([lerAtivos(userId), contarEncerrados(userId)]);
      if (!ativos) return reply.code(500).send({ error: 'query_failed' });
      /**
       * `limite` NÃO viaja mais, de propósito.
       *
       * Ele valia `VENCIDOS_MAX + FUTUROS_MAX` (60) e a tela imprimia esse número na
       * frase de truncamento — mas as duas janelas cortam de forma INDEPENDENTE e
       * `truncado` fica true se QUALQUER uma cortou. 20 vencidos + 3 futuros viram 18
       * linhas na resposta, e a tela dizia "estes são os 60 mais próximos". Número que
       * não descreve nada do que está desenhado é pior que número nenhum: o único que a
       * tela pode afirmar é o tamanho da lista que ela recebeu.
       */
      return reply.send({
        scope: 'active',
        reminders: ativos.linhas,
        truncado: ativos.truncado,
        historico: encerrados,
      });
    }

    const ativos = await lerAtivos(userId);
    if (!ativos) return reply.code(500).send({ error: 'query_failed' });

    /**
     * Modo legado — o binário que já está no aparelho, que manda a requisição sem
     * `scope` e lê uma lista só. Devolve vivos + primeira página do histórico: a
     * ordem interna não importa pra ele (a tela reagrupa e reordena), o que importa
     * é que os vivos estão TODOS aqui, e não competindo por vaga com o cemitério.
     */
    const hist = await lerHistorico(userId, HISTORICO_LEGADO, null);
    return reply.send({
      scope: 'legacy',
      reminders: [...ativos.linhas, ...(hist?.linhas ?? [])],
      truncado: ativos.truncado,
      nextCursor: hist?.proximoCursor ?? null,
    });
  });

  /**
   * Criar lembrete PELO APP.
   *
   * Antes desta rota, a aba chamada "Lembretes" era o único lugar do app onde não se
   * podia criar um: o estado vazio mandava o paciente digitar no chat *"me lembra do
   * losartana todo dia às 8"*. Pra quem tem 55 anos, formular a frase certa — nome do
   * remédio, periodicidade e horário numa tacada — é MAIS difícil que preencher três
   * campos, e quando a LLM entende errado o erro é silencioso.
   *
   * O horário é interpretado em BRASÍLIA porque é `nextOccurrence` quem resolve o
   * primeiro disparo, e ele lê BYHOUR/BYMINUTE nesse fuso. Calcular com o relógio do
   * servidor (UTC no Railway) disparava 3h mais cedo — o bug já pago no tool-executor.
   */
  app.post('/reminders', { preHandler: requirePatient }, async (req, reply) => {
    const parsed = CriarSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });

    // Criar lembrete no registro do outro exige `agir`, não só `ver`.
    const sujeito = await resolverSujeitoDaRequisicao(req, reply, 'agir');
    if (!sujeito) return;
    const userId = sujeito.userId;

    // ⚠️ O teto de requisições é do ATOR (quem aperta o botão), e não do dono do registro:
    // um cuidador com três pessoas não pode ganhar três vezes mais cota, e um paciente não
    // pode ser travado pelo ritmo de quem cuida dele. O CAP de lembretes ativos, logo
    // abaixo, continua sendo do SUJEITO — é a lista dele que satura.
    const rl = await checkUserRateLimit(`app:new-reminder:${req.patient!.userId}`);
    if (!rl.allowed) {
      return reply
        .code(429)
        .send({ error: 'rate_limited', message: 'Calma! Criou muitos lembretes seguidos. Tenta de novo em alguns segundos.' });
    }

    /**
     * O teto de ativos é cobrado ANTES do insert. É o freio que impede a lista de
     * crescer sem fim pela mão do próprio paciente — e ele fala em português, porque um
     * 409 mudo faria a pessoa tocar em "Salvar" de novo.
     *
     * ## Conta o que a TELA mostra, e não o que a tabela tem
     *
     * A primeira versão era um `count exact head` por status, sem poda nenhuma. A lista
     * viva devolvida por esta mesma rota REMOVE os confirmados-por-fora — então um
     * paciente com 40 lembretes de dose única confirmados pelo WhatsApp (que ficam
     * 'sent' pra sempre) levava 409 dizendo *"você já tem 40 lembretes ativos, cancela
     * algum"* com 3 lembretes na tela. Ele não tinha como obedecer: as 40 linhas não
     * apareciam em lugar nenhum do app. Beco sem saída na única rota de escrita que o
     * app tem.
     *
     * `lerAtivos` é a MESMA leitura que a tela recebe, teto de 60 linhas curtas — duas
     * consultas por índice, não uma varredura. O número da mensagem volta a bater com o
     * que o paciente vê, e a poda passa a valer nos dois lados.
     */
    const ativos = await lerAtivos(userId);
    if (!ativos) return reply.code(500).send({ error: 'query_failed' });

    const quantosAtivos = ativos.linhas.length;
    if (quantosAtivos >= ATIVOS_POR_PACIENTE) {
      return reply.code(409).send({
        error: 'too_many_active',
        message: `Você já tem ${quantosAtivos} lembretes ativos, que é o máximo que eu consigo acompanhar bem. Cancela algum que já não usa e a gente cria esse.`,
      });
    }

    const [horaStr, minStr] = parsed.data.time.split(':');
    const hora = Number(horaStr);
    const minuto = Number(minStr);
    const regra = `FREQ=DAILY;BYHOUR=${hora};BYMINUTE=${minuto}`;

    // A MESMA função que o dispatcher e o tool-executor usam. Um cálculo próprio aqui
    // criaria um segundo entendimento de "próximo dia às 8" — e eles divergiriam.
    const primeiro = nextOccurrence(regra);
    if (!primeiro) return reply.code(400).send({ error: 'invalid_time' });

    const primeiroIso = primeiro.toISOString();
    const { data: criado, error } = await db
      .from('reminders')
      .insert({
        user_id: userId,
        type: parsed.data.type,
        title: parsed.data.title,
        body: parsed.data.body ?? null,
        // `scheduled_at` preenchido nos dois casos, como o tool-executor já faz: é o
        // que `resolveReminderFirstRun` lê como âncora do primeiro disparo.
        scheduled_at: primeiroIso,
        rrule: parsed.data.daily ? regra : null,
        next_run_at: primeiroIso,
        status: 'pending',
        // `origem` existe pra uma pergunta futura: quantos lembretes o paciente cria
        // sozinho depois que a tela passou a permitir? Sem o carimbo, a resposta seria
        // um chute.
        // Carimba quem criou quando não foi o dono: é o que permite ao paciente ver, na
        // tela dele, que aquele lembrete veio de quem cuida dele — e cobrar explicação.
        payload: sujeito.caregiverUserId
          ? { origem: 'app', criado_por_cuidador: sujeito.caregiverUserId }
          : { origem: 'app' },
      })
      .select(REMINDER_COLUMNS)
      .single();

    if (error) return reply.code(500).send({ error: 'insert_failed' });

    void writeEvent({
      eventName: 'app.reminder_created',
      userId,
      // SEM o título: nome de remédio é dado clínico e não vai pra log/evento.
      payload: { type: parsed.data.type, daily: parsed.data.daily, hour: hora, minute: minuto },
    });

    return reply.code(201).send({ ok: true, reminder: criado });
  });

  app.post<{ Params: { id: string } }>('/reminders/:id/action', async (req, reply) => {
    const parsed = ActionSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

    const userId = await resolveOwner(req, reply, parsed.data.phone);
    if (userId === null) return reply; // resolveOwner já respondeu

    const { data: reminder } = await db
      .from('reminders')
      .select('id, user_id, status, next_run_at, rrule')
      .eq('id', req.params.id)
      .maybeSingle();

    if (!reminder) return reply.code(404).send({ error: 'reminder_not_found' });
    if (reminder.user_id !== userId) return reply.code(403).send({ error: 'forbidden' });

    const nextRecurring = reminder.rrule ? nextOccurrence(reminder.rrule) : null;
    const decision = reminderActionPatch(
      {
        status: reminder.status as string,
        rrule: reminder.rrule as string | null,
        nextRecurringIso: nextRecurring?.toISOString() ?? null,
      },
      parsed.data.action,
      parsed.data.minutes,
      Date.now(),
    );
    if (decision.kind === 'reject') return reply.code(409).send({ error: 'reminder_cancelled' });

    const { error } = await db.from('reminders').update(decision.patch).eq('id', reminder.id);
    if (error) return reply.code(500).send({ error: error.message });

    void writeEvent({
      eventName: 'app.reminder_action',
      userId,
      payload: {
        reminder_id: reminder.id,
        action: parsed.data.action,
        minutes: parsed.data.minutes ?? null,
        // Qual credencial agiu: quando o web migrar (F5), este campo é o que prova que
        // ninguém mais chega por telefone antes de a rota legada ser removida.
        via: req.patient ? 'jwt' : 'legacy_token',
      },
    });

    // Devolve a linha inteira já atualizada: a tela substitui o estado otimista pelo
    // real sem um segundo round-trip, e sem ter que adivinhar o que o servidor decidiu
    // (um "feito" em lembrete recorrente volta `pending` com outra data, não `done`).
    const { data: updated } = await db
      .from('reminders')
      .select(REMINDER_COLUMNS)
      .eq('id', reminder.id)
      .single();

    return reply.send({ ok: true, reminder: updated });
  });
}
