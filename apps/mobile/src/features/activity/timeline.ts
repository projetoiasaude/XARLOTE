/**
 * Atividade — o passo a passo do que a Xarlote está fazendo, derivado do status.
 *
 * ## O problema que esta tela resolve
 *
 * O paciente manda "preciso de losartana" e depois some do WhatsApp. Do lado dele não
 * há nada acontecendo; do nosso, a Xarlote está falando com três farmácias. O gargalo
 * de conversão documentado em 03/08 tinha uma causa mecânica (a perna do
 * estabelecimento nunca chegava), mas tinha também esta: **ninguém sabia que havia algo
 * em andamento.** Esta tela é o "estou trabalhando nisso" com etapas verificáveis.
 *
 * ## As etapas são derivadas, nunca inventadas
 *
 * Cada etapa tem um estado: `feito`, `agora`, `esperando` ou `parado`. Nenhuma delas é
 * marcada como feita por dedução otimista — "cotando" só vira `feito` quando existe uma
 * cotação de verdade na resposta. Uma barra de progresso que anda sozinha é a forma mais
 * rápida de o paciente perder confiança na única coisa que ele não pode conferir.
 */
import type { Consultation, ConsultationQuote, Order, Quote } from '@/features/health/overview';
import { brDesde, brQuando, diffDiasBrt, msDe } from '@/lib/br-format';

export type EstadoEtapa = 'feito' | 'agora' | 'esperando' | 'parado';

export interface Etapa {
  chave: string;
  rotulo: string;
  estado: EstadoEtapa;
  /** Uma linha de detalhe REAL quando existe (preço, farmácia, horário). */
  detalhe?: string;
}

export type TipoAtividade = 'order' | 'consultation';

/**
 * Como isto acabou, em UMA palavra — o que faz um encerrado caber numa linha.
 *
 * Encerrado desenhado como cartão completo (título, resumo, quatro etapas com
 * marcadores e detalhes) transforma o histórico numa parede de passos mortos entre o
 * paciente e o único item que pede ação dele. Encerrado é linha; o `desfecho` é o que
 * essa linha diz. Continua visível — esconder fracasso é o outro erro, e o mais grave.
 */
export interface Desfecho {
  rotulo: string;
  tom: 'success' | 'neutral' | 'warn';
}

/**
 * A saída que o cartão oferece — derivada aqui pra ser testável, não decidida na tela.
 *
 * `retomar` existe porque `resumo` dizia "me chama no chat" em dois estados. A frase
 * empurrava pro paciente um trabalho que o app pode fazer: montar o pedido de retomada
 * com o nome do item dentro. `responder` não manda mensagem — as cotações chegaram como
 * mensagens da Xarlote, e a escolha (endereço, forma de pagamento) é conversa; o que o
 * botão faz é levar até lá em um toque, em vez de mandar o paciente encontrar o caminho.
 */
export type AcaoDaAtividade =
  | { tipo: 'responder'; rotulo: string }
  | { tipo: 'retomar'; rotulo: string; mensagem: string }
  | null;

export interface Atividade {
  id: string;
  tipo: TipoAtividade;
  titulo: string;
  /** O que o paciente lê como "em que pé está". */
  resumo: string;
  /** true = a Xarlote está trabalhando nisso agora (mostra o ping ao vivo). */
  viva: boolean;
  criadoEm: string | null;
  /**
   * Quando isto MEXEU pela última vez — sempre um carimbo do PASSADO.
   *
   * O defeito que esta anotação existe pra impedir de voltar: a consulta agendada
   * carregava aqui o `scheduled_at`, que é FUTURO. A tela lê este campo como "atualizado
   * há…", e `brDesde` devolve 'agora' pra qualquer diferença menor que um minuto —
   * inclusive negativa, porque essa é a guarda de relógio adiantado. Resultado: a única
   * consulta agendada que existe em produção dizia "atualizado agora", permanentemente,
   * até o dia da consulta chegar. Status legítimo + tempo demais = mentira.
   */
  atualizadoEm: string | null;
  /**
   * O compromisso MARCADO, que é futuro — em campo próprio justamente pra nunca
   * disputar espaço com `atualizadoEm`. Null quando não há horário confirmado.
   */
  agendadoPara: string | null;
  etapas: Etapa[];
  /** Decisão pendente DO PACIENTE — o que ele precisa responder pra destravar. */
  esperandoVoce: boolean;
  /** Null enquanto está vivo: só o que acabou tem desfecho. */
  desfecho: Desfecho | null;
  acao: AcaoDaAtividade;
}

function moeda(v: number | null | undefined): string | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  return `R$ ${v.toFixed(2).replace('.', ',')}`;
}

/** Nome dos itens do pedido — `items` é JSONB e já veio em três formatos diferentes. */
function nomesDosItens(items: unknown): string[] {
  if (!Array.isArray(items)) return [];
  const nomes: string[] = [];
  for (const it of items) {
    if (typeof it === 'string' && it.trim()) nomes.push(it.trim());
    else if (it && typeof it === 'object') {
      const o = it as Record<string, unknown>;
      const n = o['name'] ?? o['nome'] ?? o['medication'] ?? o['product'];
      if (typeof n === 'string' && n.trim()) nomes.push(n.trim());
    }
  }
  return nomes;
}

/**
 * Status de pedido em que nada mais vai acontecer do NOSSO lado.
 *
 * `handed_off` está aqui e o motivo é uma correção: ele significa que passamos o pedido
 * pra farmácia e a conversa seguiu direto com ela — a nossa perna acabou. Sem ele na
 * lista, sete pedidos de JULHO apareciam na tela de agosto com o selo verde pulsando
 * "em andamento" e a frase "A caminho." Um mês depois. Foi visto ao vivo em 12/08.
 */
const ORDER_TERMINAL = new Set(['delivered', 'completed', 'handed_off', 'cancelled', 'failed', 'expired']);

/**
 * Depois de quantos dias sem mexida uma coisa "viva" deixa de ser anunciada como viva.
 *
 * O selo pulsante é uma AFIRMAÇÃO: "estou trabalhando nisso agora". Num pedido parado há
 * duas semanas ela é falsa mesmo que o status ainda seja legítimo — e é justamente o tipo
 * de estado zumbi que o incidente A8 (lembrete indeliverável em loop) deixou como lição.
 * O item continua visível e continua acionável; só para de mentir sobre o presente.
 */
export const DIAS_ATE_ESFRIAR = 10;

function esfriou(atualizadoEm: string | null, nowMs: number): boolean {
  const ms = msDe(atualizadoEm);
  if (ms === null) return false; // sem carimbo não se pode afirmar que esfriou
  return nowMs - ms > DIAS_ATE_ESFRIAR * 86_400_000;
}

/**
 * A cotação REPRESENTA uma resposta da farmácia?
 *
 * `quotes` guarda uma linha por farmácia consultada, e a maioria termina em `timeout`
 * (187 contra 16 respondidas, em produção): a farmácia nunca respondeu. Contar todas
 * como resposta fazia a tela dizer "10 farmácias responderam" quando duas responderam —
 * inflando a impressão de esforço com o número que menos deveria ser inflado.
 */
function respondeu(q: Quote): boolean {
  return q.status === 'quoted' || q.status === 'unavailable';
}

/** Respondeu COM preço — é o que o paciente pode escolher. */
function ofertou(q: Quote): boolean {
  return q.status === 'quoted' && typeof q.total === 'number';
}

/**
 * Um pedido de farmácia como quatro etapas.
 *
 * A etapa "escolher" existe porque é o ponto onde a bola está com o PACIENTE — e é o
 * que `esperandoVoce` sinaliza pra tela destacar. Sem isso, um pedido parado esperando
 * a escolha dele parece um pedido parado por nossa culpa.
 */
export function atividadeDePedido(o: Order, nowMs: number): Atividade {
  const cotacoes = o.quotes ?? [];
  const consultadas = cotacoes.length;
  const ofertas = cotacoes.filter(ofertou);
  const responderam = cotacoes.filter(respondeu).length;

  const escolhida = o.selected_quote_id
    ? cotacoes.find((q) => q.id === o.selected_quote_id) ?? null
    : null;
  const terminal = ORDER_TERMINAL.has(o.status);
  const frustrado = o.status === 'cancelled' || o.status === 'failed' || o.status === 'expired';
  const entregue = o.status === 'delivered' || o.status === 'completed';
  const passadoAdiante = o.status === 'handed_off';

  const atualizadoEm = o.updated_at ?? o.created_at ?? null;
  const frio = !terminal && esfriou(atualizadoEm, nowMs);

  const itens = nomesDosItens(o.items);
  const titulo = itens.length > 0 ? itens.join(', ') : 'Pedido de medicamento';

  const melhor = ofertas.length > 0
    ? [...ofertas].sort((a, b) => (a.total ?? Infinity) - (b.total ?? Infinity))[0]!
    : null;

  /**
   * O rótulo da cotação conta só quem RESPONDEU — e diz de quantas.
   *
   * "2 de 10 farmácias responderam" é menos bonito que "10 farmácias responderam" e é a
   * única das duas frases que é verdade. Quando ninguém respondeu e o pedido já morreu,
   * a etapa diz isso em vez de ficar em "consultando" pra sempre.
   */
  const rotuloCotacao =
    ofertas.length > 0
      ? `${ofertas.length} de ${consultadas} ${consultadas === 1 ? 'farmácia respondeu' : 'farmácias responderam'} com preço`
      : responderam > 0
        ? `${responderam} de ${consultadas} responderam — nenhuma tinha`
        : terminal && consultadas > 0
          ? `Nenhuma das ${consultadas} farmácias respondeu`
          : consultadas > 0
            ? `Esperando resposta de ${consultadas} farmácias`
            : 'Consultando farmácias';

  const etapas: Etapa[] = [
    { chave: 'pedido', rotulo: 'Recebi seu pedido', estado: 'feito' },
    {
      chave: 'cotando',
      rotulo: rotuloCotacao,
      estado: ofertas.length > 0 ? 'feito' : frustrado || frio ? 'parado' : 'agora',
      ...(melhor?.suppliers?.name && melhor.total != null
        ? { detalhe: `melhor preço: ${melhor.suppliers.name} — ${moeda(melhor.total)}` }
        : {}),
    },
    {
      chave: 'escolha',
      rotulo: escolhida ? 'Você escolheu' : 'Sua escolha',
      estado: escolhida ? 'feito' : frustrado ? 'parado' : 'esperando',
      ...(escolhida?.suppliers?.name
        ? { detalhe: `${escolhida.suppliers.name} — ${moeda(escolhida.total) ?? 'a combinar'}` }
        : {}),
    },
    {
      chave: 'entrega',
      rotulo: entregue ? 'Entregue' : passadoAdiante ? 'Seguiu com a farmácia' : 'Entrega',
      estado: entregue || passadoAdiante ? 'feito' : frustrado ? 'parado' : escolhida && !frio ? 'agora' : 'esperando',
      ...(escolhida?.eta_minutes && !frio && !terminal
        ? { detalhe: `chega em cerca de ${escolhida.eta_minutes} min` }
        : {}),
    },
  ];

  const esperandoVoce = ofertas.length > 0 && !escolhida && !terminal && !frio;

  return {
    id: o.id,
    tipo: 'order',
    titulo,
    resumo: frustrado
      ? 'Esse pedido não seguiu.'
      : entregue
        ? 'Entregue.'
        : passadoAdiante
          ? 'Passei pra farmácia — o combinado seguiu com eles.'
          : frio
            ? // Sem "me chama no chat": o botão de retomar faz isso, e o app não devolve
              // ao paciente um trabalho de redação que ele pode errar em silêncio.
              'Isso ficou parado.'
            : esperandoVoce
              ? 'Tem cotação esperando sua escolha.'
              : escolhida
                ? 'A caminho.'
                : 'Estou falando com as farmácias.',
    // Frio NÃO é vivo: o selo pulsante afirma "agora", e num pedido de um mês atrás
    // essa afirmação é falsa mesmo com status legítimo.
    viva: !terminal && !frio,
    criadoEm: o.created_at ?? null,
    atualizadoEm,
    // Pedido de farmácia não tem hora marcada — o `eta_minutes` é estimativa da
    // farmácia, não compromisso, e vira detalhe da etapa de entrega.
    agendadoPara: null,
    etapas,
    esperandoVoce,
    desfecho: entregue
      ? { rotulo: 'entregue', tom: 'success' }
      : passadoAdiante
        ? { rotulo: 'seguiu com a farmácia', tom: 'neutral' }
        : frustrado
          ? { rotulo: 'não seguiu', tom: 'warn' }
          : frio
            ? { rotulo: 'ficou parado', tom: 'warn' }
            : null,
    acao: esperandoVoce
      ? { tipo: 'responder', rotulo: 'Ver as opções' }
      : frio
        ? { tipo: 'retomar', rotulo: 'Ainda preciso', mensagem: `Ainda preciso de ${titulo}. Pode retomar?` }
        : null,
  };
}

const CONSULTA_TERMINAL = new Set(['completed', 'cancelled', 'failed', 'expired']);

/**
 * A proposta que virou o horário marcado — é ela que tem o nome da clínica.
 *
 * `consultations.selected_quote_id` NÃO vem no `GET /app/overview` (só `orders` traz o
 * seu); o que vem é o `status` de cada `consultation_quotes`, e `tool-executor-v2` marca
 * a escolhida como `'selected'` no mesmo passo em que grava
 * `scheduled_at = q.proposed_datetime`. A segunda tentativa usa exatamente essa
 * igualdade, pra uma linha antiga cujo status nunca foi atualizado: casar o instante é
 * fato do banco, não palpite. Sem nenhuma das duas, fica sem nome — melhor calar do que
 * dizer a clínica errada num compromisso.
 */
function propostaEscolhida(
  propostas: readonly ConsultationQuote[],
  scheduledAt: string | null | undefined,
): ConsultationQuote | null {
  const marcada = propostas.find((q) => q.status === 'selected');
  if (marcada) return marcada;
  const alvo = msDe(scheduledAt);
  if (alvo === null) return null;
  return propostas.find((q) => msDe(q.proposed_datetime) === alvo) ?? null;
}

/**
 * Quanto FALTA, em dias de calendário — a segunda leitura do mesmo carimbo.
 *
 * A etapa 'escolha' diz QUANDO é ("qua, 26/08 às 10:00"); esta diz QUANTO falta. É o
 * mesmo dado em duas funções diferentes, não o mesmo dado duas vezes: uma localiza no
 * calendário, a outra dá a urgência sem obrigar ninguém a fazer a conta.
 *
 * Data já passada devolve null de propósito: "faltam -2 dias" é a mesma classe de
 * mentira que o `atualizadoEm` no futuro. Consulta cuja hora passou e que ninguém
 * fechou fica sem contagem, não com uma contagem negativa.
 */
function faltaQuanto(iso: string | null | undefined, agoraMs: number): string | null {
  const ms = msDe(iso);
  if (ms === null) return null;
  const dias = diffDiasBrt(ms, agoraMs);
  if (dias < 0) return null;
  if (dias === 0) return 'é hoje';
  if (dias === 1) return 'é amanhã';
  return `faltam ${dias} dias`;
}

/**
 * O carimbo de "atualizado …" que se recusa a falar do futuro.
 *
 * Cinto duplo do `atualizadoEm`: `brDesde` devolve 'agora' pra qualquer diferença menor
 * que um minuto, incluindo negativa (é a guarda contra relógio adiantado), então uma
 * data futura que escorregasse pra este campo viraria "atualizado agora" para sempre.
 * Aqui um futuro DECLARADO — mais de um minuto à frente — não vira rótulo nenhum. A
 * tela absorve um rótulo vazio; ela não absorve uma afirmação falsa sobre o presente.
 */
export function desdeNoPassado(iso: string | null | undefined, agoraMs: number): string {
  const ms = msDe(iso);
  if (ms === null) return '';
  if (ms > agoraMs + 60_000) return '';
  return brDesde(iso, agoraMs);
}

/**
 * Uma consulta como quatro etapas.
 *
 * `scheduled_at` é a única prova de que existe horário marcado. A auditoria de 04/08
 * achou 17 consultas `failed` e zero `scheduled` — e a lição foi que "temos propostas"
 * nunca pode ser desenhado como "está agendado".
 */
export function atividadeDeConsulta(c: Consultation, nowMs: number): Atividade {
  const propostas = c.consultation_quotes ?? [];
  const temProposta = propostas.length > 0;
  const agendada = msDe(c.scheduled_at) !== null;
  const terminal = CONSULTA_TERMINAL.has(c.status);
  const cancelada = c.status === 'cancelled' || c.status === 'failed' || c.status === 'expired';
  // Consulta agendada NÃO esfria: o horário é no futuro, e "parado" seria mentira ao
  // contrário. Só a busca sem desfecho esfria.
  const frio = !terminal && !agendada && esfriou(c.created_at ?? null, nowMs);

  const barata = temProposta
    ? [...propostas].sort((a, b) => (a.price_brl ?? Infinity) - (b.price_brl ?? Infinity))[0]!
    : null;

  /**
   * O único fato acionável de uma consulta agendada: o dia, a hora e onde.
   *
   * A etapa dizia só "Horário confirmado", sem detalhe nenhum — um cartão que afirma
   * estar tudo certo e não diz quando. `scheduled_at` e o nome da clínica já estavam
   * nas mãos desta função; faltava dizê-los.
   */
  const escolhida = agendada ? propostaEscolhida(propostas, c.scheduled_at) : null;
  const clinica = escolhida?.clinics?.name?.trim() || null;
  const quandoMarcado = agendada ? brQuando(c.scheduled_at, nowMs) : '';
  const detalheDoHorario = quandoMarcado
    ? clinica
      ? `${quandoMarcado} · ${clinica}`
      : quandoMarcado
    : null;
  const contagem = agendada ? faltaQuanto(c.scheduled_at, nowMs) : null;

  const etapas: Etapa[] = [
    { chave: 'pedido', rotulo: 'Entendi o que você precisa', estado: 'feito', ...(c.specialty ? { detalhe: c.specialty } : {}) },
    {
      chave: 'buscando',
      rotulo: temProposta
        ? `${propostas.length} ${propostas.length === 1 ? 'clínica respondeu' : 'clínicas responderam'}`
        : terminal
          ? 'Nenhuma clínica respondeu'
          : 'Procurando clínicas',
      estado: temProposta ? 'feito' : cancelada || frio ? 'parado' : 'agora',
      ...(barata?.clinics?.name && barata.price_brl != null
        ? { detalhe: `${barata.clinics.name} — ${moeda(barata.price_brl)}` }
        : {}),
    },
    {
      chave: 'escolha',
      rotulo: agendada ? 'Horário confirmado' : 'Sua escolha de horário',
      estado: agendada ? 'feito' : cancelada ? 'parado' : 'esperando',
      ...(detalheDoHorario ? { detalhe: detalheDoHorario } : {}),
    },
    {
      chave: 'consulta',
      rotulo: c.status === 'completed' ? 'Consulta realizada' : 'A consulta',
      estado: c.status === 'completed' ? 'feito' : cancelada ? 'parado' : agendada ? 'agora' : 'esperando',
      ...(contagem && c.status !== 'completed' ? { detalhe: contagem } : {}),
    },
  ];

  const titulo = c.specialty ? `Consulta — ${c.specialty}` : 'Consulta médica';
  const esperandoVoce = temProposta && !agendada && !terminal && !frio;

  return {
    id: c.id,
    tipo: 'consultation',
    titulo,
    resumo: cancelada
      ? 'Essa busca não seguiu.'
      : agendada
        ? 'Horário marcado.'
        : frio
          ? 'Essa busca ficou parada.'
          : temProposta
            ? 'Tem horário esperando você confirmar.'
            : 'Estou procurando clínicas.',
    viva: !terminal && !frio,
    criadoEm: c.created_at ?? null,
    // `created_at`, NUNCA `scheduled_at`: este campo é fato do passado (ver o tipo).
    atualizadoEm: c.created_at ?? null,
    agendadoPara: c.scheduled_at ?? null,
    etapas,
    esperandoVoce,
    desfecho:
      c.status === 'completed'
        ? { rotulo: 'realizada', tom: 'success' }
        : cancelada
          ? { rotulo: 'não seguiu', tom: 'warn' }
          : frio
            ? { rotulo: 'ficou parada', tom: 'warn' }
            : null,
    acao: esperandoVoce
      ? { tipo: 'responder', rotulo: 'Ver os horários' }
      : frio
        ? {
            tipo: 'retomar',
            rotulo: 'Ainda quero',
            mensagem: c.specialty
              ? `Ainda quero a consulta de ${c.specialty}. Pode retomar?`
              : 'Ainda quero marcar aquela consulta. Pode retomar?',
          }
        : null,
  };
}

/**
 * A lista da tela: o que está VIVO primeiro, e dentro disso o que espera o paciente.
 *
 * Encerrados não são escondidos — ficam abaixo. Esconder um pedido que falhou é como
 * o estado vazio que não falava: o paciente conclui que nada aconteceu, quando o que
 * houve foi um fracasso que ele tem o direito de ver.
 */
export interface ResumoAtividade {
  /** A frase de estado — vai ANTES da lista, nunca depois dela. */
  frase: string;
  /** Quantos itens dependem de uma resposta do paciente. */
  precisaDeVoce: number;
  vivas: number;
  encerradas: number;
}

/**
 * O estado da tela em uma frase, calculado ANTES de desenhar qualquer cartão.
 *
 * O defeito que isto conserta: a tela mostrava a pilha de encerrados e só depois dela, no
 * rodapé, a frase "Nada em andamento no momento". Quem abria via primeiro uma tela cheia
 * de cartões e só descobria no fim que nenhum estava ativo — a informação que responde à
 * pergunta da aba chegava depois do conteúdo que a contradiz. Frase de estado é herói, e
 * herói fica no topo.
 *
 * A ordem das frases é a ordem da urgência: o que espera o PACIENTE vem primeiro, porque
 * é o único caso em que a tela precisa de algo dele.
 */
export function resumoDaAtividade(atividades: readonly Atividade[]): ResumoAtividade {
  const vivas = atividades.filter((a) => a.viva).length;
  const precisaDeVoce = atividades.filter((a) => a.esperandoVoce).length;
  const encerradas = atividades.length - vivas;

  const frase =
    precisaDeVoce > 0
      ? precisaDeVoce === 1
        ? 'Uma coisa está esperando você'
        : `${precisaDeVoce} coisas estão esperando você`
      : vivas > 0
        ? vivas === 1
          ? 'Estou cuidando de uma coisa agora'
          : `Estou cuidando de ${vivas} coisas agora`
        : 'Nada em andamento agora';

  return { frase, precisaDeVoce, vivas, encerradas };
}

export function montarAtividades(
  orders: readonly Order[],
  consultas: readonly Consultation[],
  nowMs: number,
): Atividade[] {
  const todas = [
    ...orders.map((o) => atividadeDePedido(o, nowMs)),
    ...consultas.map((c) => atividadeDeConsulta(c, nowMs)),
  ];
  return todas.sort((a, b) => {
    if (a.viva !== b.viva) return a.viva ? -1 : 1;
    if (a.viva && a.esperandoVoce !== b.esperandoVoce) return a.esperandoVoce ? -1 : 1;
    /**
     * Compromisso marcado sobe entre os vivos — e por MÉRITO, não por acidente.
     *
     * Antes ele subia porque `atualizadoEm` carregava o `scheduled_at` (futuro), o que
     * fazia a ordenação certa pelo motivo errado e o rótulo "atualizado agora" pelo
     * mesmo motivo. Agora a regra é explícita: entre dois itens vivos que não esperam
     * resposta do paciente, o que tem dia e hora vem primeiro, e entre dois marcados,
     * o mais próximo.
     */
    if (a.viva) {
      const ma = msDe(a.agendadoPara);
      const mb = msDe(b.agendadoPara);
      if ((ma === null) !== (mb === null)) return ma !== null ? -1 : 1;
      if (ma !== null && mb !== null && ma !== mb) return ma - mb;
    }
    return (msDe(b.atualizadoEm) ?? 0) - (msDe(a.atualizadoEm) ?? 0);
  });
}
