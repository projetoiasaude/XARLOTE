/**
 * A tela de Lembretes decidida por funções puras: em que bloco cada lembrete cai, que
 * ações ele aceita, e — o mais importante — o que o servidor VAI responder.
 *
 * ## O eco otimista aqui não é um chute
 *
 * `reminderActionPatch` foi extraída pra `@iasaude/shared` na F0 justamente pra que o
 * app possa aplicar a MESMA decisão do servidor antes da resposta chegar. É o que
 * evita o defeito clássico do otimismo: mostrar "concluído" num lembrete recorrente e,
 * um segundo depois, ele voltar pra "pendente às 7h de amanhã" — porque foi isso que o
 * servidor decidiu. Com a função compartilhada, a tela mostra de imediato o resultado
 * CERTO, e a resposta só confirma.
 *
 * O único ingrediente que o app não tem de graça é a próxima ocorrência do `rrule` —
 * e `nextOccurrence` também vem de shared, então nem esse falta.
 */
import { nextOccurrence, reminderActionPatch, type ReminderAppAction } from '@iasaude/shared';
import { brHora, brQuando, diaBrt, diffDiasBrt, msDe } from '@/lib/br-format';
import type { ReminderRow } from '@/features/health/overview';

export type BlocoLembrete = 'atrasado' | 'hoje' | 'amanha' | 'semana' | 'depois' | 'encerrado';

export const ROTULO_BLOCO: Record<BlocoLembrete, string> = {
  atrasado: 'Passou da hora',
  hoje: 'Hoje',
  amanha: 'Amanhã',
  semana: 'Nos próximos dias',
  depois: 'Mais pra frente',
  encerrado: 'Já resolvidos',
};

/**
 * A PARTIÇÃO do enum `reminder_status_t` — a mesma que o servidor usa nas duas
 * consultas (`apps/api/src/routes/app/reminders.ts`).
 *
 * Ela está escrita duas vezes porque o servidor não pode importar do app e o app não
 * pode importar do servidor. Duas listas à mão sobre o mesmo enum é exatamente o tipo
 * de coisa que envelhece em silêncio: um status novo no enum, não classificado, sai das
 * duas consultas e o lembrete DESAPARECE da tela sem erro nenhum. Daí o vigilante em
 * `tests/mobile-reminders-agenda.test.ts`, que lê o enum do `schema.sql`, estas duas
 * listas e as do arquivo da rota, e quebra a suíte quando divergirem.
 */
export const STATUS_ATIVOS = ['pending', 'sent', 'snoozed'] as const;
export const STATUS_ENCERRADOS = ['acknowledged', 'cancelled'] as const;

/**
 * Fora do enum, mas já visto em dado antigo (o dashboard exibia `failed`). O CLIENTE
 * tolera e trata como encerrado; o servidor não pode listá-lo num `.in('status', …)`,
 * porque valor fora do enum faz o Postgres recusar a consulta inteira.
 */
const STATUS_LEGADOS_ENCERRADOS = ['failed'] as const;

/** Status que o paciente não age mais em cima. `acknowledged` de recorrente não cai aqui. */
function encerrado(status: string): boolean {
  return (
    (STATUS_ENCERRADOS as readonly string[]).includes(status) ||
    (STATUS_LEGADOS_ENCERRADOS as readonly string[]).includes(status)
  );
}

/**
 * Confirmado por FORA do app — o carimbo existe, o status não conta a história.
 *
 * Os dois caminhos de confirmação por WhatsApp (`handleLogMedicationTaken` no
 * tool-executor e o backstop do inbound-user) gravam SÓ `last_confirmed_at`: o `status`
 * continua 'sent'. Como 'sent' é ativo e o `next_run_at` de um lembrete de uma vez só
 * NUNCA avança (o dispatcher só carimba `sent` no claim), a linha voltava como "Passou
 * da hora" em toda abertura da tela, alimentava o cartão de alerta do topo ("Tem 3
 * lembretes que passaram da hora") e não saía mais da lista viva. A tela cobrava do
 * paciente uma dose que o próprio sistema já tinha registrado — e o dado pra saber
 * disso vinha no payload, só não era lido.
 *
 * `rrule` presente NÃO cai aqui, e essa guarda é o coração da função: num recorrente o
 * carimbo é da ocorrência ANTERIOR e o claim do dispatcher já empurrou `next_run_at` pra
 * próxima. Comparar os dois sem essa guarda esconderia um remédio de TODO DIA — o pior
 * desfecho possível desta tela.
 */
function confirmadoForaDoApp(r: ReminderRow, alvo: number | null): boolean {
  if (r.rrule) return false;
  const confirmado = msDe(r.last_confirmed_at);
  if (confirmado === null) return false;
  // Já confirmado e sem horário nenhum: não há o que cobrar. Com horário, só encerra se
  // a confirmação veio DEPOIS dele — adiar depois de confirmar (raro, mas possível pelo
  // app) empurra `next_run_at` pro futuro e reabre a linha, que é o comportamento certo.
  return alvo === null || confirmado >= alvo;
}

/**
 * Em que bloco o lembrete aparece.
 *
 * "Passou da hora" é um bloco de verdade, e não uma linha vermelha no meio de "Hoje":
 * um remédio cujo horário passou é a única coisa nessa tela que pede AÇÃO AGORA — e a
 * adesão de 44% do Arthur nasceu exatamente de doses que ninguém viu que tinham passado.
 */
export function blocoDoLembrete(r: ReminderRow, agoraMs: number): BlocoLembrete {
  if (encerrado(r.status)) return 'encerrado';

  const alvo = msDe(r.next_run_at) ?? msDe(r.scheduled_at);

  // ANTES do teste de atraso: quem já confirmou pelo WhatsApp não pode ser cobrado de
  // novo pela tela. Sem esta linha, o lembrete de uma vez só confirmado por lá ficava
  // preso em "Passou da hora" pra sempre — e é justamente esse acúmulo que o fundador
  // reclamou ("os lembretes vão se acumulando infinitamente").
  if (confirmadoForaDoApp(r, alvo)) return 'encerrado';

  // Pendente sem horário nenhum: não some da tela — vai pro fim, visível, porque um
  // lembrete que existe no banco e não aparece em lugar algum é dado perdido.
  if (alvo === null) return 'depois';

  // Horário já passou e o lembrete segue pendente → atrasado, mesmo que seja de
  // semanas atrás. Isso é de propósito: o lembrete indeliverável em loop (incidente
  // A8) ficava invisível justamente por ser antigo demais pra caber em "hoje".
  if (alvo < agoraMs) return 'atrasado';

  const dias = diffDiasBrt(alvo, agoraMs);
  if (dias === 0) return 'hoje';
  if (dias === 1) return 'amanha';
  if (dias <= 7) return 'semana';
  return 'depois';
}

export interface GrupoLembretes {
  bloco: BlocoLembrete;
  rotulo: string;
  lembretes: ReminderRow[];
}

const ORDEM_BLOCOS: BlocoLembrete[] = ['atrasado', 'hoje', 'amanha', 'semana', 'depois', 'encerrado'];

/**
 * Lembretes em blocos, cada bloco ordenado pelo horário.
 *
 * Blocos vazios NÃO entram — cabeçalho de seção sem nada embaixo faz a tela parecer
 * quebrada. Quem quer dizer "não tem nada" é o estado vazio da tela, com uma frase.
 */
export function agruparLembretes(lembretes: readonly ReminderRow[], agoraMs: number): GrupoLembretes[] {
  const porBloco = new Map<BlocoLembrete, ReminderRow[]>();
  for (const r of lembretes) {
    const b = blocoDoLembrete(r, agoraMs);
    const lista = porBloco.get(b);
    if (lista) lista.push(r);
    else porBloco.set(b, [r]);
  }

  const grupos: GrupoLembretes[] = [];
  for (const bloco of ORDEM_BLOCOS) {
    const lista = porBloco.get(bloco);
    if (!lista?.length) continue;
    lista.sort((a, b) => {
      const ma = msDe(a.next_run_at) ?? msDe(a.scheduled_at) ?? Number.MAX_SAFE_INTEGER;
      const mb = msDe(b.next_run_at) ?? msDe(b.scheduled_at) ?? Number.MAX_SAFE_INTEGER;
      // Encerrados na ordem inversa: o que acabou de ser confirmado fica no topo do
      // bloco, onde o paciente espera ver a confirmação que ele mesmo acabou de dar.
      return bloco === 'encerrado' ? mb - ma : ma - mb;
    });
    grupos.push({ bloco, rotulo: ROTULO_BLOCO[bloco], lembretes: lista });
  }
  return grupos;
}

/**
 * Os blocos que pedem AÇÃO agora, e os que só informam.
 *
 * A separação é a resposta da tela à pergunta dela ("o que está pendente?"). Atraso e
 * hoje ficam abertos, em cartão, porque é o que o paciente tem que resolver; amanhã e
 * adiante ficam recolhidos, porque saber que existem basta — e montar linha que ninguém
 * vai tocar custa quadro do mesmo jeito.
 */
export const BLOCOS_ACIONAVEIS: readonly BlocoLembrete[] = ['atrasado', 'hoje'];
export const BLOCOS_FUTUROS: readonly BlocoLembrete[] = ['amanha', 'semana', 'depois'];

export interface Agenda {
  /** Atraso e hoje, em cartão e abertos. */
  acionaveis: GrupoLembretes[];
  /** Amanhã em diante, dentro da seção recolhida. */
  futuros: GrupoLembretes[];
  /**
   * O que já está resolvido mas chegou pela lista VIVA.
   *
   * São três origens:
   *
   * 1. O eco otimista de um toque que acabou de acontecer (a rota `?scope=active` não
   *    devolve encerrado).
   * 2. O lembrete de uma vez só confirmado pelo WhatsApp, que fica com status ativo e
   *    carimbo de confirmação (ver `confirmadoForaDoApp`) — e é por causa dele que a
   *    classificação aqui é por BLOCO e não por status.
   * 3. **O que o dedo tocou nesta sessão** (`agidosAgora`), mesmo que o servidor o tenha
   *    devolvido VIVO. É o caso dominante do produto e o que motivou o parâmetro: "Já
   *    tomei" num remédio de todo dia volta `pending` com `next_run_at` de amanhã, cai
   *    no bloco 'amanha' e seria desenhado dentro da seção RECOLHIDA "Depois de hoje" —
   *    ou seja, o cartão sumiria da área visível no exato toque que pedia confirmação.
   *
   * Nos três casos a linha CONTINUA visível: tocar em "Já tomei" e ver a linha
   * DESAPARECER não é confirmação, é o paciente perguntando se registrou. O que se
   * transforma ensina; o que sai de cena faz procurar.
   */
  recemEncerrados: ReminderRow[];
  /** Quantos passaram da hora — o número do aviso do topo. */
  atrasados: number;
  /** Total dos futuros, pro contador do cabeçalho recolhido. */
  totalFuturos: number;
  /** O próximo compromisso vivo, seja atrasado ou futuro. É o herói da tela. */
  proximo: ReminderRow | null;
}

/**
 * A agenda VIVA dividida como a tela desenha.
 *
 * Recebe só lembretes ativos (o servidor manda `?scope=active`). O bloco `encerrado`
 * que `agruparLembretes` produziria fica FORA dos grupos e vai pra `recemEncerrados`:
 * o "Já resolvidos" da tela é a seção de histórico, que tem consulta própria e paginada,
 * e o mesmo dado dito duas vezes é o defeito que essa separação existe pra evitar.
 */
/** Conjunto vazio reaproveitado como default — nunca é escrito, então não vaza entre chamadas. */
const NINGUEM: ReadonlySet<string> = new Set<string>();

export function separarAgenda(
  ativos: readonly ReminderRow[],
  agoraMs: number,
  /**
   * Os ids em que o paciente agiu NESTA sessão da tela.
   *
   * Eles saem dos blocos e vão pra `recemEncerrados` sejam qual for o estado em que
   * ficaram — é o que faz o cartão se TRANSFORMAR onde o dedo estava em vez de
   * teleportar pra dentro de uma seção fechada. Tirá-los dos blocos não é detalhe: sem
   * isso o mesmo lembrete seria desenhado duas vezes na mesma tela, e o contador de
   * "Passou da hora" cobraria de novo o que acabou de ser confirmado.
   */
  agidosAgora: ReadonlySet<string> = NINGUEM,
): Agenda {
  const vivos: ReminderRow[] = [];
  const recemEncerrados: ReminderRow[] = [];
  for (const r of ativos) {
    // Pelo BLOCO, e não pelo status: o confirmado-pelo-WhatsApp tem status ATIVO e
    // mesmo assim já está encerrado. Separar por status aqui o deixaria em `vivos`, e
    // `agruparLembretes` o jogaria no bloco 'encerrado' — que fica fora de acionáveis
    // E de futuros. Ou seja: sumiria da tela inteira, sem erro nenhum.
    if (agidosAgora.has(r.id) || blocoDoLembrete(r, agoraMs) === 'encerrado') recemEncerrados.push(r);
    else vivos.push(r);
  }

  const grupos = agruparLembretes(vivos, agoraMs);
  const acionaveis = grupos.filter((g) => BLOCOS_ACIONAVEIS.includes(g.bloco));
  const futuros = grupos.filter((g) => BLOCOS_FUTUROS.includes(g.bloco));

  return {
    acionaveis,
    futuros,
    recemEncerrados,
    atrasados: grupos.find((g) => g.bloco === 'atrasado')?.lembretes.length ?? 0,
    totalFuturos: futuros.reduce((n, g) => n + g.lembretes.length, 0),
    // `agruparLembretes` já ordenou cada bloco pelo horário, e ORDEM_BLOCOS põe
    // atrasado e hoje na frente — então o primeiro do primeiro grupo é o próximo.
    proximo: (acionaveis[0] ?? futuros[0])?.lembretes[0] ?? null,
  };
}

/**
 * O próximo instante em que algum rótulo desta tela pode mudar — ou `null` se nada muda.
 *
 * ## Por que não um `setInterval` de um minuto
 *
 * `const [agora] = useState(() => Date.now())` congela o relógio na MONTAGEM, e as abas
 * do expo-router ficam montadas: a dose que vence às 8h com a tela aberta desde as 7h
 * nunca migrava pro bloco "Passou da hora" — que é justamente a resposta de produto ao
 * caso Arthur. Rótulo calculado na montagem envelhece.
 *
 * O conserto óbvio seria um intervalo de 60s, e ele estaria errado por outro motivo: num
 * app onde "em repouso, nada se mexe" é regra, um `setState` por minuto re-renderiza
 * cada cartão da lista para sempre, mesmo quando o próximo horário é daqui a seis horas.
 *
 * Então a tela agenda UM despertador, pro instante exato em que algo muda: o próximo
 * `next_run_at` que ainda está no futuro, ou a meia-noite de Brasília — que é quando
 * "hoje" vira "ontem" e "amanhã" vira "hoje". Entre um e outro, zero trabalho.
 */
export function proximoInstanteRelevante(lembretes: readonly ReminderRow[], agoraMs: number): number | null {
  // Meia-noite do PRÓXIMO dia de Brasília. O `+86400000` é seguro porque o Brasil não
  // tem mais horário de verão desde 2019 (a mesma premissa do br-format).
  const meiaNoiteHoje = msDe(`${diaBrt(agoraMs)}T00:00:00-03:00`);
  let alvo = meiaNoiteHoje === null ? null : meiaNoiteHoje + 86_400_000;

  for (const r of lembretes) {
    if (encerrado(r.status)) continue;
    const quando = msDe(r.next_run_at) ?? msDe(r.scheduled_at);
    if (quando === null || quando <= agoraMs) continue;
    if (alvo === null || quando < alvo) alvo = quando;
  }
  return alvo;
}

/** Que botões a linha mostra. Cancelado não aceita nada — é terminal no servidor. */
export function acoesDisponiveis(r: ReminderRow): ReminderAppAction[] {
  if (r.status === 'cancelled') return [];
  if (r.status === 'acknowledged' && !r.rrule) return [];
  return ['done', 'snooze', 'cancel'];
}

/**
 * O lembrete como ele VAI ficar depois da ação — a MESMA decisão do servidor.
 *
 * Volta `null` quando o servidor recusaria (cancelado é terminal): a tela então não
 * finge que fez nada. Otimismo que aplica o que o servidor vai rejeitar é pior que
 * nenhum otimismo, porque a linha pisca e volta.
 */
export function lembreteOtimista(r: ReminderRow, acao: ReminderAppAction, minutos: number | undefined, agoraMs: number): ReminderRow | null {
  const proxima = r.rrule ? nextOccurrence(r.rrule) : null;
  const decisao = reminderActionPatch(
    { status: r.status, rrule: r.rrule ?? null, nextRecurringIso: proxima?.toISOString() ?? null },
    acao,
    minutos,
    agoraMs,
  );
  if (decisao.kind === 'reject') return null;

  // O patch usa as chaves do BANCO (snake_case) — as mesmas do row, de propósito:
  // é o que permite aplicá-lo direto, sem um mapa de tradução que sairia de sincronia.
  return { ...r, ...(decisao.patch as Partial<ReminderRow>) };
}

/**
 * A frase de confirmação que a Xarlote diria — falada, não robótica.
 *
 * Recorrente confirmado NÃO diz "concluído": diz que o de hoje está feito e quando é o
 * próximo. Dizer "concluído" num remédio de todo dia sugere que acabou o tratamento.
 */
export function fraseDaAcao(r: ReminderRow, acao: ReminderAppAction, minutos: number | undefined): string {
  if (acao === 'done') return r.rrule ? 'Anotado, o de hoje está feito.' : 'Prontinho, marquei como feito.';
  if (acao === 'cancel') return 'Cancelei esse lembrete.';
  return `Te chamo de novo em ${minutos ?? 30} minutos.`;
}

export type TomLembrete = 'danger' | 'warn' | 'success' | 'accent' | 'neutral';

/** A cor do estado. Atraso é `warn`, não `danger`: a Xarlote acompanha, não repreende. */
export function tomDoBloco(bloco: BlocoLembrete): TomLembrete {
  switch (bloco) {
    case 'atrasado': return 'warn';
    case 'hoje': return 'accent';
    case 'encerrado': return 'neutral';
    default: return 'neutral';
  }
}

const ROTULO_TIPO: Record<string, string> = {
  medication: 'Remédio',
  medication_backup: 'Reforço',
  appointment: 'Consulta',
  exam: 'Exame',
  refill: 'Recomprar',
  hydration: 'Água',
  custom: 'Lembrete',
};

export function rotuloDoTipo(tipo: string | null | undefined): string {
  return ROTULO_TIPO[tipo ?? ''] ?? 'Lembrete';
}

// ─── Histórico (a seção recolhida, uma LINHA por item) ──────────────────────────

export interface LinhaHistorico {
  /** 'Confirmado' / 'Cancelado' — o que aconteceu, em uma palavra. */
  desfecho: string;
  /** O instante que a linha exibe. Confirmação quando existe; senão a última data. */
  quandoIso: string | null;
  /** `true` quando o desfecho é positivo — a linha ganha o tom de sucesso. */
  positivo: boolean;
}

/**
 * O que dizer de um lembrete encerrado.
 *
 * `last_confirmed_at` é a data que importa num "feito" — é o carimbo do momento em que
 * o paciente disse que tomou. Sem ele (cancelado nunca confirma), sobra a data agendada.
 * Nunca cai no `created_at`: dizer "cancelado" ao lado da data de CRIAÇÃO faria o
 * paciente ler que o lembrete foi cancelado meses atrás, quando o cancelamento foi hoje.
 *
 * ## O carimbo vale tanto quanto o status
 *
 * "Confirmado" não é só `acknowledged`. O que o paciente confirma pelo WhatsApp fica com
 * status ATIVO e só o carimbo (ver `confirmadoForaDoApp`), e essas linhas chegam ao
 * acervo pela consulta do servidor. Lê-las apenas pelo status as chamaria de "Encerrado"
 * ao lado do horário AGENDADO — o desfecho errado e a data errada, num item que o
 * sistema sabe que foi confirmado, e na hora em que ele foi.
 */
export function linhaHistorico(r: ReminderRow): LinhaHistorico {
  if (r.status === 'cancelled') {
    return { desfecho: 'Cancelado', quandoIso: r.next_run_at ?? r.scheduled_at ?? null, positivo: false };
  }
  if (r.status === 'acknowledged' || r.last_confirmed_at) {
    return {
      desfecho: 'Confirmado',
      quandoIso: r.last_confirmed_at ?? r.next_run_at ?? r.scheduled_at ?? null,
      positivo: true,
    };
  }
  // `failed` e qualquer coisa que apareça amanhã: nome honesto, sem inventar desfecho.
  return { desfecho: 'Encerrado', quandoIso: r.next_run_at ?? r.scheduled_at ?? null, positivo: false };
}

// ─── Criar lembrete (os três campos) ────────────────────────────────────────────

export type TipoNovoLembrete = 'medication' | 'appointment' | 'custom';

export const TIPOS_NOVO_LEMBRETE: readonly { tipo: TipoNovoLembrete; rotulo: string }[] = [
  { tipo: 'medication', rotulo: 'Remédio' },
  { tipo: 'appointment', rotulo: 'Consulta' },
  { tipo: 'custom', rotulo: 'Outro' },
];

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/**
 * `HH:MM` a partir do que o dedo digitou, ou `null` quando não dá pra confiar.
 *
 * Aceita as formas que uma pessoa realmente digita num campo numérico — `8`, `8:5`,
 * `830`, `0830`, `08:30` — porque o teclado numérico do Android não tem os dois-pontos
 * em lugar óbvio e exigir o formato exato transformaria "criar lembrete" em quebra-
 * cabeça. O que ela NUNCA faz é adivinhar: `2530` volta null e a tela diz o que aceita.
 */
export function normalizarHorario(bruto: string): string | null {
  const limpo = bruto.trim().replace(/[hH]/g, ':').replace(/[^\d:]/g, '');
  if (!limpo) return null;

  let hora: number;
  let minuto: number;

  if (limpo.includes(':')) {
    const [h, m = ''] = limpo.split(':');
    if (!h) return null;
    hora = Number(h);
    minuto = m === '' ? 0 : Number(m);
    // '8:5' é ambíguo (5 ou 50 minutos?). Uma casa só de minuto vira DEZENA, que é
    // como se lê "oito e cinco" num relógio digital: 8:50 seria "oito e cinquenta".
    if (m.length === 1) minuto = Number(m) * 10;
  } else if (limpo.length <= 2) {
    hora = Number(limpo);
    minuto = 0;
  } else if (limpo.length === 3) {
    hora = Number(limpo.slice(0, 1));
    minuto = Number(limpo.slice(1));
  } else if (limpo.length === 4) {
    hora = Number(limpo.slice(0, 2));
    minuto = Number(limpo.slice(2));
  } else {
    return null;
  }

  if (!Number.isInteger(hora) || !Number.isInteger(minuto)) return null;
  if (hora < 0 || hora > 23 || minuto < 0 || minuto > 59) return null;
  return `${pad2(hora)}:${pad2(minuto)}`;
}

/**
 * O instante do próximo `HH:MM` no fuso de Brasília — hoje se ainda não passou, amanhã
 * se passou. É a mesma decisão que o `nextOccurrence` do servidor toma com
 * `FREQ=DAILY;BYHOUR=..;BYMINUTE=..`, e existe aqui só pra tela poder DIZER, antes de
 * salvar, quando o lembrete vai tocar. Prévia que discorda do resultado é pior que
 * prévia nenhuma — por isso o cálculo é o mesmo, e não uma aproximação.
 */
export function proximaOcorrenciaBrt(hhmm: string, agoraMs: number): number | null {
  const norm = normalizarHorario(hhmm);
  if (!norm) return null;
  // O `-03:00` explícito é o que ancora o horário em Brasília em vez de no fuso do
  // aparelho — um celular configurado fora do Brasil mostraria a prévia errada.
  const alvo = Date.parse(`${diaBrt(agoraMs)}T${norm}:00-03:00`);
  if (!Number.isFinite(alvo)) return null;
  return alvo > agoraMs ? alvo : alvo + 86_400_000;
}

export interface NovoLembreteBruto {
  titulo: string;
  horario: string;
  diario: boolean;
  tipo: TipoNovoLembrete;
}

/** O corpo do `POST /app/reminders`, com os nomes do contrato da rota. */
export interface CorpoNovoLembrete {
  title: string;
  time: string;
  daily: boolean;
  type: TipoNovoLembrete;
}

export type ValidacaoNovoLembrete =
  | { ok: true; corpo: CorpoNovoLembrete }
  | { ok: false; campo: 'titulo' | 'horario'; mensagem: string };

/**
 * Valida os três campos e devolve JÁ o corpo do POST.
 *
 * Devolver o corpo (e não os campos limpos) é de propósito: se a tela montasse o JSON
 * por conta, existiriam dois entendimentos do contrato da rota e eles divergiriam na
 * primeira mudança. Aqui o contrato é dito uma vez, e é testável sem simulador.
 */
export function validarNovoLembrete(bruto: NovoLembreteBruto): ValidacaoNovoLembrete {
  const titulo = bruto.titulo.trim().replace(/\s+/g, ' ');
  if (titulo.length < 2) {
    return { ok: false, campo: 'titulo', mensagem: 'Escreve do que é o lembrete — "Losartana", por exemplo.' };
  }
  // 80 é o teto da rota. Cortar aqui em silêncio seria pior: o paciente veria o
  // título dele encurtado sem entender por quê.
  if (titulo.length > 80) {
    return { ok: false, campo: 'titulo', mensagem: 'Ficou comprido demais. Tenta em até 80 letras.' };
  }

  const horario = normalizarHorario(bruto.horario);
  if (!horario) {
    return { ok: false, campo: 'horario', mensagem: 'Que horas? Escreve como no relógio — 08:00, 14:30, 20:00.' };
  }

  return { ok: true, corpo: { title: titulo, time: horario, daily: bruto.diario, type: bruto.tipo } };
}

/**
 * A frase que a tela mostra ANTES de salvar: "Todo dia às 08:00, a partir de amanhã".
 *
 * Existe porque o campo de horário não diz se o lembrete cai hoje ou amanhã, e essa é
 * justamente a dúvida de quem cria um lembrete às 21h para as 8h.
 */
export function descreverNovoLembrete(corpo: CorpoNovoLembrete, agoraMs: number): string {
  const primeiro = proximaOcorrenciaBrt(corpo.time, agoraMs);
  if (primeiro === null) return '';
  const quando = brQuando(new Date(primeiro).toISOString(), agoraMs);
  if (!corpo.daily) return `Uma vez, ${quando}.`;
  return `Todo dia às ${brHora(new Date(primeiro).toISOString())} — o primeiro é ${quando}.`;
}
