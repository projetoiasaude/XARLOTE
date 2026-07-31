/**
 * RESOLUÇÃO DE ENTIDADE + FALHA QUE VOLTA AO MODELO.
 *
 * Camada 2 e 3 do conserto da família de ids alucinados (a camada 1 é não pedir ao modelo
 * o que ele não pode saber — ver `message_id` removido de xarlote-tools.ts).
 *
 * ## Camada 2 — resolver, nunca confiar
 * Cada resolvedor carrega as entidades DO PACIENTE (`user_id` sempre no WHERE) e deixa a
 * decisão pura de `resolveEntityRef` escolher. Consequência de segurança: um uuid válido de
 * OUTRO paciente não tem como ser usado, porque nunca entra na lista de candidatos.
 * `consultation_quotes` e `quotes` não têm `user_id` — são escopadas pelo pai já resolvido.
 *
 * ## Camada 3 — falha nunca vira sucesso
 * O padrão antigo era `if (!row) return;`: o handler desistia em silêncio, `handleToolCall`
 * carimbava a task como `success` e o modelo — que só vê o resultado — anunciava ao paciente
 * o que NÃO aconteceu ("Pronto, cancelei a consulta", 30/07 18:52, com a consulta intacta).
 * `ToolFailure` fecha esse buraco: o catch do executor devolve `{ok:false, error}` ao modelo
 * com uma frase escrita PRA ELE LER, sempre dizendo explicitamente que nada foi alterado.
 */
import { db, writeLog } from '@iasaude/db';
import { resolveEntityRef, loneNumberRef, type EntityCandidate } from '@iasaude/shared';

/**
 * Falha ESPERADA de tool (referência inválida, ambígua ou inexistente) — não é bug.
 * `modelMessage` é o texto que volta pro modelo; escreva-o como instrução, não como stack.
 */
export class ToolFailure extends Error {
  readonly modelMessage: string;
  constructor(modelMessage: string) {
    super(modelMessage);
    this.name = 'ToolFailure';
    this.modelMessage = modelMessage;
  }
}

/** Consultas "vivas" — as que uma tool pode confirmar/cancelar. */
export const LIVE_CONSULTATION_STATUSES = ['searching', 'quoting', 'quoted', 'confirming', 'scheduled'] as const;

interface ConsultationRow {
  id: string;
  status: string;
  specialty: string | null;
  preferences: Record<string, unknown> | null;
  scheduled_at: string | null;
}

function describeConsultation(c: ConsultationRow): string {
  const doctor = (c.preferences as Record<string, unknown> | null)?.['requested_doctor'] as string | undefined;
  const esp = c.specialty && c.specialty !== 'consulta' ? c.specialty : null;
  return `${doctor ? `com ${doctor}` : ''}${doctor && esp ? ' ' : ''}${esp ? `(${esp})` : ''}`.trim() || 'sem médico/especialidade definidos';
}

/**
 * Resolve a consulta a que o modelo se referiu. Lança ToolFailure quando não dá pra ter
 * CERTEZA — de propósito: agir na consulta errada é pior que não agir.
 */
export async function resolveConsultationForUser(
  raw: unknown,
  userId: string,
  opts: { action: string; statuses?: readonly string[]; traceId?: string; failedWithinMs?: number },
): Promise<ConsultationRow> {
  const statuses = opts.statuses ?? LIVE_CONSULTATION_STATUSES;
  const { data } = await db
    .from('consultations')
    .select('id, status, specialty, preferences, scheduled_at, created_at')
    .eq('user_id', userId)
    .in('status', statuses as unknown as string[])
    .order('created_at', { ascending: false })
    .limit(10);
  // Consulta `failed` só conta dentro da janela em que o prompt a mostra como RETOMÁVEL
  // (24h). Sem o recorte, um id alucinado podia resolver numa consulta morta há meses e a
  // Xarlote responderia "cancelei" sobre algo que o paciente nem lembra.
  const cutoff = Date.now() - (opts.failedWithinMs ?? 24 * 60 * 60_000);
  const rows = ((data ?? []) as Array<ConsultationRow & { created_at?: string }>)
    .filter((r) => r.status !== 'failed' || new Date(r.created_at ?? 0).getTime() >= cutoff);

  const candidates: EntityCandidate[] = rows.map((r) => ({
    id: r.id,
    labels: [r.specialty, (r.preferences as Record<string, unknown> | null)?.['requested_doctor'] as string | undefined],
  }));
  const decision = resolveEntityRef(raw, candidates);

  if (decision.kind === 'none') {
    throw new ToolFailure(
      decision.reason === 'no-candidates'
        ? `NADA FOI ${opts.action.toUpperCase()}: o paciente não tem nenhuma consulta em andamento no sistema. Se ele marcou por fora e quer só ser lembrado, use create_reminder. Não afirme que alterou uma consulta.`
        : `NADA FOI ${opts.action.toUpperCase()}: não existe consulta sua que corresponda a "${String(raw).slice(0, 60)}". As consultas em andamento são: ${rows.map((r) => describeConsultation(r)).join(' | ')}. Se o paciente marcou essa por fora, use create_reminder em vez de confirmar/cancelar consulta.`,
    );
  }
  if (decision.kind === 'ambiguous') {
    const opts2 = rows.filter((r) => decision.ids.includes(r.id)).map((r) => describeConsultation(r));
    throw new ToolFailure(
      `NADA FOI ${opts.action.toUpperCase()}: há mais de uma consulta possível (${opts2.join(' | ')}) e não dá pra saber qual é. PERGUNTE ao paciente qual delas antes de tentar de novo.`,
    );
  }

  const row = rows.find((r) => r.id === decision.id)!;
  if (decision.kind === 'rescued') {
    await writeLog('warn', 'consultation', `id de consulta inválido do modelo ("${String(raw).slice(0, 40)}") — resolvido por ${decision.why} para a consulta ${describeConsultation(row)}`, { traceId: opts.traceId });
  }
  return row;
}

interface QuoteRow {
  id: string;
  clinic_id: string | null;
  prescriber_id: string | null;
  proposed_datetime: string | null;
  alternative_datetimes: string[] | null;
  modality: string | null;
  price_brl: number | null;
  plan_accepted: string | null;
  conversation_id: string | null;
  clinics?: { name?: string } | null;
}

/**
 * Rótulos de uma cotação: número da OPÇÃO + data em vários formatos + clínica.
 *
 * O número importa mais do que parece: o bloco de contexto do paciente NUNCA expõe uuid de
 * cotação, então o modelo só pode se referir a uma opção pelo que ele mesmo escreveu na
 * conversa ("1️⃣ … 2️⃣ …"). Sem o ordinal, "opção 1" não casaria com nada.
 */
function quoteLabels(q: QuoteRow, optionNumber?: number): Array<string | null | undefined> {
  const out: Array<string | null | undefined> = [q.clinics?.name];
  if (optionNumber) out.push(String(optionNumber));
  const push = (iso: string | null | undefined) => {
    if (!iso) return;
    const d = new Date(iso);
    if (isNaN(d.getTime())) return;
    const br = d.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    out.push(br, br.split(',')[0], br.split(',')[1]?.trim());
  };
  push(q.proposed_datetime);
  for (const alt of q.alternative_datetimes ?? []) push(alt);
  return out;
}

/**
 * Resolve a cotação DENTRO de uma consulta já resolvida (escopo = o pai, não o user).
 *
 * ⚠️ Só entram cotações CONFIRMÁVEIS: com horário proposto e ainda vivas. Sem esse filtro o
 * resgate "só tem uma" pegaria uma cotação MORTA — em produção existem 8 com
 * `proposed_datetime` nulo (`unavailable`/`timeout`, ex.: "vaga só daqui a 2 anos") — e a
 * clínica receberia de verdade "pode marcar pra o horário combinado?" sem horário nenhum.
 * Confirmar a opção errada é pior que não confirmar.
 */
export async function resolveConsultationQuote(
  raw: unknown,
  consultationId: string,
  opts: { action: string; traceId?: string; preferences?: Record<string, unknown> | null },
): Promise<QuoteRow> {
  const { data } = await db
    .from('consultation_quotes')
    .select('id, clinic_id, prescriber_id, proposed_datetime, alternative_datetimes, modality, price_brl, plan_accepted, conversation_id, clinics(name)')
    .eq('consultation_id', consultationId)
    .not('proposed_datetime', 'is', null)
    // `selected` ENTRA: `rescueStuckConfirming` devolve a consulta de `confirming` pra
    // `quoted` depois de 12h sem retorno da clínica e diz ao paciente "liberei de novo as
    // opções" — mas a escolhida continua `selected` e as irmãs já viraram `rejected`. Sem
    // ela na lista, NENHUMA opção seria confirmável e a Xarlote contradiria a própria
    // mensagem de resgate. Reconfirmar a consulta ainda ativa é barrado antes disto, pelo
    // status da CONSULTA (ver a guarda de idempotência no handler).
    .in('status', ['pending', 'offered', 'selected'])
    .order('created_at', { ascending: true })
    .limit(10);
  const rows = (data ?? []) as unknown as QuoteRow[];

  // Número da opção como foi APRESENTADO ao paciente (o resumo consolidado é a fonte);
  // sem ele, a ordem de criação, que é a mesma usada na hora de listar.
  // O número da opção vem do resumo consolidado — que é EXATAMENTE o que foi apresentado ao
  // paciente (top-3). Uma cotação fora do resumo NÃO recebe número: ela nunca foi mostrada,
  // então numerá-la por ordem de criação criaria um "1" que colide com o "1" que ele viu.
  const summary = opts.preferences?.['_consolidated_summary'] as { options?: Array<{ quote_id?: string; option?: number }> } | undefined;
  const optionOf = new Map<string, number>();
  for (const o of summary?.options ?? []) if (o.quote_id && o.option) optionOf.set(o.quote_id, o.option);
  if (!optionOf.size) rows.forEach((r, i) => optionOf.set(r.id, i + 1)); // sem resumo: ordem de criação

  const horarios = rows
    .map((r) => `${optionOf.get(r.id) ? `${optionOf.get(r.id)}) ` : ''}${r.proposed_datetime ? new Date(r.proposed_datetime).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '?'}`)
    .join(' | ');

  // "quero a 2" → o NÚMERO DA OPÇÃO tem precedência sobre qualquer outro número do rótulo.
  // Sem esta regra, `2` também casa com o mês `02` de "15/02/2026" (os zeros à esquerda são
  // normalizados pra que "9h30" case com "09:30") e a escolha virava "não entendi qual".
  const lone = loneNumberRef(raw);
  if (lone !== null) {
    const porNumero = rows.filter((r) => optionOf.get(r.id) === lone);
    if (porNumero.length === 1) {
      await writeLog('warn', 'consultation', `quote_id inválido do modelo ("${String(raw).slice(0, 40)}") — resolvido pelo número da opção`, { traceId: opts.traceId });
      return porNumero[0]!;
    }
  }

  const decision = resolveEntityRef(raw, rows.map((r) => ({ id: r.id, labels: quoteLabels(r, optionOf.get(r.id)) })));
  if (decision.kind === 'none') {
    throw new ToolFailure(
      decision.reason === 'no-candidates'
        ? `NADA FOI ${opts.action.toUpperCase()}: essa consulta não tem NENHUMA opção de horário confirmável (a clínica ainda não passou horário, ou a vaga oferecida caiu). NÃO diga que confirmou — pergunte à clínica com message_supplier ou avise o paciente que ainda não há horário.`
        : `NADA FOI ${opts.action.toUpperCase()}: nenhuma opção corresponde a "${String(raw).slice(0, 60)}". As opções REAIS são: ${horarios}. Se o paciente escolheu uma delas, chame de novo com o horário exato; se ele quer outra data, pergunte à clínica com message_supplier.`,
    );
  }
  if (decision.kind === 'ambiguous') {
    // A lista vai junto: sem ela o modelo recebe a recusa sem nada com que reformular
    // — e o paciente ouve "qual horário?" depois de já ter dito qual.
    throw new ToolFailure(
      `NADA FOI ${opts.action.toUpperCase()}: não deu pra saber qual opção o paciente escolheu. As opções são: ${horarios}. Se a mensagem dele identifica uma delas, chame de novo com o horário exato; senão PERGUNTE a ele.`,
    );
  }
  const row = rows.find((r) => r.id === decision.id)!;
  if (decision.kind === 'rescued') {
    await writeLog('warn', 'consultation', `quote_id inválido do modelo ("${String(raw).slice(0, 40)}") — resolvido por ${decision.why}`, { traceId: opts.traceId });
  }
  return row;
}

interface OrderRow {
  id: string;
  status: string;
  selected_quote_id: string | null;
  updated_at?: string | null;
  /** Como chegamos até ele: `only-one` = por eliminação, sem o modelo ter identificado nada. */
  resolvedBy?: 'exact' | 'label' | 'only-one';
}

/** Resolve o pedido de farmácia do paciente (mesma disciplina da consulta). */
export async function resolveOrderForUser(
  raw: unknown,
  userId: string,
  opts: { action: string; traceId?: string; statuses?: readonly string[]; excludeIds?: Set<string> },
): Promise<OrderRow> {
  let q = db
    .from('orders')
    .select('id, status, selected_quote_id, items, updated_at')
    .eq('user_id', userId);
  q = opts.statuses
    ? q.in('status', opts.statuses as unknown as string[])
    : q.not('status', 'in', '(cancelled,completed)');
  const { data } = await q.order('created_at', { ascending: false }).limit(10);
  // `excludeIds` = pedidos criados NESTE turno. Blindagem HIGH-1: na sequência
  // start_pharmacy_order → cancel_order, o pedido recém-criado não pode ser candidato.
  const rows = ((data ?? []) as Array<OrderRow & { items?: Array<{ name?: string }> | null }>)
    .filter((r) => !opts.excludeIds?.has(r.id));

  const decision = resolveEntityRef(raw, rows.map((r) => ({
    id: r.id,
    labels: (r.items ?? []).map((i) => i?.name),
  })));
  if (decision.kind === 'none') {
    throw new ToolFailure(
      decision.reason === 'no-candidates'
        ? `NADA FOI ${opts.action.toUpperCase()}: o paciente não tem nenhum pedido de farmácia em aberto (nenhum elegível agora). NÃO diga que cancelou/alterou um pedido — se ele quer começar um novo, use start_pharmacy_order.`
        : `NADA FOI ${opts.action.toUpperCase()}: não encontrei um pedido de farmácia do paciente que corresponda a "${String(raw).slice(0, 60)}". Os itens em aberto são: ${rows.flatMap((r) => (r.items ?? []).map((i) => i?.name)).filter(Boolean).join(', ') || '(nenhum)'}. Verifique o PEDIDO ATIVO no seu contexto antes de tentar de novo.`,
    );
  }
  if (decision.kind === 'ambiguous') {
    throw new ToolFailure(
      `NADA FOI ${opts.action.toUpperCase()}: o paciente tem mais de um pedido em aberto e não dá pra saber qual. PERGUNTE a ele qual pedido antes de agir.`,
    );
  }
  const row = rows.find((r) => r.id === decision.id)!;
  if (decision.kind === 'rescued') {
    await writeLog('warn', 'order', `order_id inválido do modelo ("${String(raw).slice(0, 40)}") — resolvido por ${decision.why}`, { traceId: opts.traceId });
  }
  return { ...row, resolvedBy: decision.kind === 'exact' ? 'exact' : decision.why };
}

/**
 * A mensagem com a MÍDIA que o modelo quer processar (receita/exame).
 *
 * O modelo NUNCA soube o uuid de uma mensagem — pedir isso produziu 12 falhas de insert em
 * um único dia ("message_id", "message_0", "1", "chatcmpl-…" gravados numa coluna uuid).
 * Aqui não se pergunta: usa-se a mensagem do turno se ela tem mídia, senão a mídia mais
 * recente da conversa (o paciente manda a foto e pede "analisa" no turno seguinte).
 */
export async function resolveMediaMessageId(
  conversationId: string,
  inboundMessageId: string | null | undefined,
  opts: { hasInboundMedia: boolean; withinMinutes?: number },
): Promise<string | null> {
  if (opts.hasInboundMedia && inboundMessageId) return inboundMessageId;
  const since = new Date(Date.now() - (opts.withinMinutes ?? 120) * 60_000).toISOString();
  const { data } = await db
    .from('messages')
    .select('id')
    .eq('conversation_id', conversationId)
    .eq('direction', 'in')
    .not('media_mime', 'is', null)
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data?.id as string | undefined) ?? inboundMessageId ?? null;
}
