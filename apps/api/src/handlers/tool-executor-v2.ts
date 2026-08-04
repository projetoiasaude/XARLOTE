/**
 * Handlers das tools introduzidas na Xarlote 2.0:
 *   - start_treatment_from_order
 *   - log_medication_taken
 *   - update_treatment_status
 *   - log_symptom
 *   - set_default_address
 *   - start_consultation_search
 *   - confirm_consultation_selection
 *   - cancel_consultation
 *
 * Princípios:
 *   - Toda operação grava no `audit_log` (compatibilidade com graceful degrade)
 *   - Nenhum handler quebra se a tabela alvo não existir ainda
 *     (deploy intermediário enquanto migrations 0003/0004 não rodaram)
 *   - Side-effects em transação quando possível
 */
import { db, writeAudit, writeLog, writeEvent } from '@iasaude/db';
import { nextOccurrence, isOfferStillValid, pickFutureBrDateTimes, sameSlot, isAmbiguousNegation } from '@iasaude/shared';
import { sendOutbound } from './outbound.js';
import { discoverClinics } from './clinic-discovery.js';
import { initiateClinicNegotiation } from './agent-clinic.js';
import { scheduleConsultationTimeout } from './consultation-consolidation.js';
import { sendOutboundToClinic } from './outbound-agent.js';
import { ToolFailure, resolveConsultationForUser, resolveConsultationQuote, resolveOrderForUser, LIVE_CONSULTATION_STATUSES, type QuoteRow } from './entity-resolve.js';
import { reconcileAppointmentReminders } from './appointment-commit.js';

// ─────────────────────────────────────────────────────────────────────────────
// TIPOS
// ─────────────────────────────────────────────────────────────────────────────

export interface BaseToolCtx {
  userId: string;
  conversationId: string;
  phoneE164: string;
  traceId: string;
}

export interface StartTreatmentArgs {
  order_id: string;
  treatment_name: string;
  condition?: string;
  daily_consumption: number;
  reminder_time: string;       // HH:MM
  duration_days?: number;
}

export interface LogMedicationTakenArgs {
  medication_name: string;
  status: 'taken' | 'skipped' | 'snoozed';
  notes?: string;
}

export interface UpdateTreatmentStatusArgs {
  treatment_name: string;
  new_status: 'paused' | 'completed' | 'interrupted';
  reason: string;
}

export interface LogSymptomArgs {
  name: string;
  intensity?: number;
  duration_hours?: number;
  context?: string;
}

export interface StartConsultationArgs {
  specialty: string;
  /**
   * Opcional desde 04/08: `urgency` deixou de ser obrigatória na tool porque exigi-la
   * forçava uma pergunta extra antes de abrir a busca — e foi numa dessas perguntas
   * extras que a consulta do Glauber morreu. Ausente = `rotina`, o caso comum.
   */
  urgency?: 'rotina' | '72h' | '24h' | 'urgente';
  modality?: 'presencial' | 'telemedicina' | 'indiferente';
  city?: string;
  plan?: string;
  preferences?: Record<string, unknown>;
}

// ─────────────────────────────────────────────────────────────────────────────
// TREATMENT — start_treatment_from_order
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Após confirm_order_selection, registra tratamento longitudinal:
 *   1. Cria row em `treatments`
 *   2. Cria row em `medication_inventory` calculando depleção esperada
 *   3. Linka items do order a user_medications (atualiza ou cria)
 *   4. Agenda reminder diário (RRULE)
 */
export async function handleStartTreatmentFromOrder(args: StartTreatmentArgs, ctx: BaseToolCtx): Promise<void> {
  // 1. Busca o pedido — MESMA disciplina do resto: o `order_id` vem do modelo, então
  // resolve dentro dos pedidos DESTE paciente em vez de confiar no id cru (que, sendo
  // texto numa coluna uuid, devolvia null e virava `return` mudo → "comecei seu tratamento").
  const resolved = await resolveOrderForUser(args.order_id, ctx.userId, {
    action: 'iniciado', traceId: ctx.traceId,
    statuses: ['confirming', 'handed_off', 'completed'],
  });
  const { data: order } = await db
    .from('orders')
    .select('id, status, items, selected_quote_id, user_id')
    .eq('id', resolved.id)
    .single();

  if (!order) {
    throw new ToolFailure('NÃO iniciei o tratamento: não consegui carregar o pedido. Não diga que começou o acompanhamento.');
  }

  const items = (order.items as Array<{ name: string; dosage?: string; quantity?: number }> | null) ?? [];
  if (items.length === 0) {
    await writeLog('warn', 'tool', `start_treatment_from_order: order sem items`, { traceId: ctx.traceId });
    throw new ToolFailure('NÃO iniciei o tratamento: esse pedido não tem itens registrados. Não diga que começou o acompanhamento.');
  }

  // 2. Cria/recupera user_health_condition se condition foi passada
  let conditionId: string | null = null;
  if (args.condition) {
    const { data: existing } = await db
      .from('user_health_conditions')
      .select('id')
      .eq('user_id', ctx.userId)
      .ilike('name', args.condition)
      .maybeSingle();
    if (existing?.id) {
      conditionId = existing.id;
    } else {
      const { data: newCond } = await db
        .from('user_health_conditions')
        .insert({ user_id: ctx.userId, name: args.condition, source: 'inferred', active: true })
        .select('id')
        .single();
      conditionId = newCond?.id ?? null;
    }
  }

  // 3. Cria treatment
  const { data: treatment, error: treatErr } = await db
    .from('treatments')
    .insert({
      user_id: ctx.userId,
      name: args.treatment_name,
      condition_id: conditionId,
      status: 'active',
      started_at: new Date().toISOString().slice(0, 10),
      source: 'self_reported',
      confidence: 0.9,
      notes: `Origem: pedido ${args.order_id}`,
    })
    .select('id')
    .single();

  if (treatErr || !treatment) {
    await writeLog('error', 'tool', `start_treatment_from_order: falha ao criar treatment: ${treatErr?.message}`, { traceId: ctx.traceId });
    throw new ToolFailure('NÃO consegui registrar o tratamento (falha ao gravar). NÃO diga que vai acompanhar o tratamento nem que criou lembretes — nada foi criado.');
  }

  // 4. Pra cada item do pedido, cria/atualiza user_medications + inventory
  let medsCreated = 0;
  for (const item of items) {
    if (!item.name) continue;
    const quantity = item.quantity ?? 1;
    // Tablets per box: a Xarlote pode saber, mas como fallback usa um default razoável (30)
    const tabletsPerBox = 30;

    // Upsert em user_medications
    const { data: existingMed } = await db
      .from('user_medications')
      .select('id')
      .eq('user_id', ctx.userId)
      .ilike('medication_name', item.name)
      .maybeSingle();

    let medId: string;
    if (existingMed?.id) {
      medId = existingMed.id;
      await db.from('user_medications').update({
        treatment_id: treatment.id,
        dosage: item.dosage,
        daily_consumption: args.daily_consumption,
        start_date: new Date().toISOString().slice(0, 10),
        expected_end_date: args.duration_days
          ? new Date(Date.now() + args.duration_days * 86400_000).toISOString().slice(0, 10)
          : null,
        active: true,
        tablets_per_box: tabletsPerBox,
      }).eq('id', medId);
    } else {
      const { data: newMed } = await db.from('user_medications').insert({
        user_id: ctx.userId,
        treatment_id: treatment.id,
        medication_name: item.name,
        dosage: item.dosage,
        daily_consumption: args.daily_consumption,
        start_date: new Date().toISOString().slice(0, 10),
        expected_end_date: args.duration_days
          ? new Date(Date.now() + args.duration_days * 86400_000).toISOString().slice(0, 10)
          : null,
        active: true,
        tablets_per_box: tabletsPerBox,
        source: 'self_reported',
      }).select('id').single();
      if (!newMed?.id) continue;
      medId = newMed.id;
    }

    // Cria inventory
    const totalTablets = tabletsPerBox * quantity;
    const daysSupply = args.daily_consumption > 0 ? Math.floor(totalTablets / args.daily_consumption) : null;
    await db.from('medication_inventory').insert({
      user_id: ctx.userId,
      medication_id: medId,
      treatment_id: treatment.id,
      source_order_id: order.id,
      box_count: quantity,
      tablets_per_box: tabletsPerBox,
      tablets_remaining: totalTablets,
      purchased_at: new Date().toISOString(),
      expected_depletion_at: daysSupply
        ? new Date(Date.now() + daysSupply * 86400_000).toISOString().slice(0, 10)
        : null,
    });

    // Cria reminder diário (RRULE DAILY). O horário que o paciente pediu é
    // horário de Brasília — nextOccurrence interpreta BYHOUR/BYMINUTE nesse tz
    // (setHours() no relógio do servidor (UTC no Railway) disparava 3h mais cedo).
    const parts = args.reminder_time.split(':').map((s) => parseInt(s, 10));
    const hour = parts[0];
    const minute = parts[1] ?? 0;
    if (typeof hour === 'number' && !Number.isNaN(hour) && hour >= 0 && hour < 24) {
      const rrule = `FREQ=DAILY;BYHOUR=${hour};BYMINUTE=${minute}`;
      const nextRunAt = nextOccurrence(rrule);
      if (nextRunAt) {
        await db.from('reminders').insert({
          user_id: ctx.userId,
          type: 'medication',
          title: `Hora do ${item.name}${item.dosage ? ` ${item.dosage}` : ''}`,
          body: `Lembre de tomar ${args.daily_consumption} cp. Já tomou?`,
          scheduled_at: nextRunAt.toISOString(),
          rrule,
          next_run_at: nextRunAt.toISOString(),
          status: 'pending',
          medication_id: medId,
        });
      }
    }

    medsCreated++;
  }

  await writeAudit({
    actorType: 'xarlote',
    action: 'treatment.started',
    userId: ctx.userId,
    targetTable: 'treatments',
    targetId: treatment.id,
    conversationId: ctx.conversationId,
    traceId: ctx.traceId,
    reason: 'pos_order_confirmation',
    metadata: {
      treatment_name: args.treatment_name,
      condition: args.condition,
      daily_consumption: args.daily_consumption,
      reminder_time: args.reminder_time,
      duration_days: args.duration_days,
      meds_created: medsCreated,
      order_id: args.order_id,
    },
  });

  await writeLog('info', 'tool', `Tratamento iniciado: ${args.treatment_name} (${medsCreated} med(s)), reminder ${args.reminder_time}`, {
    traceId: ctx.traceId, treatmentId: treatment.id, userId: ctx.userId,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// LOG_MEDICATION_TAKEN
// ─────────────────────────────────────────────────────────────────────────────

export async function handleLogMedicationTaken(args: LogMedicationTakenArgs, ctx: BaseToolCtx): Promise<void> {
  const likeSafe = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

  // CONFIRMAÇÃO DE LEMBRETE (0020 — backup condicional): carimba last_confirmed_at no
  // lembrete cujo TÍTULO bate com o nome confirmado. Cobre medicamento E hábito (creatina,
  // água) — é por-reminder, independe de user_medications/medication_log. Só em 'taken'
  // (skipped/snoozed NÃO confirmam → o backup DEVE disparar). Best-effort.
  //   • Match EXATO (case-insensitive, sem curinga) — MESMA resolução do gate/create. Antes
  //     era substring (%nome%): vazava a confirmação pra OUTRO plano ("Creatina B12") e
  //     suprimia o backup errado = lembrete de remédio silenciado (review 08/07).
  //   • Guarda de nome vazio/curto: sem ela, likeSafe('') virava '%%' e carimbava TODOS os
  //     lembretes do usuário (blast — suprimia todos os backups dele).
  const confirmName = args.medication_name?.trim() ?? '';
  if (args.status === 'taken' && confirmName.length >= 2) {
    await db.from('reminders')
      .update({ last_confirmed_at: new Date().toISOString() })
      .eq('user_id', ctx.userId)
      .in('status', ['pending', 'sent'])
      .ilike('title', likeSafe(confirmName));
  }

  // Acha a medicação por nome (fuzzy)
  let { data: med } = await db
    .from('user_medications')
    .select('id, treatment_id, medication_name, daily_consumption')
    .eq('user_id', ctx.userId)
    .ilike('medication_name', `%${likeSafe(args.medication_name)}%`)
    .eq('active', true)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!med?.id) {
    // HONESTIDADE (caso real: "água"/"loção da barba" só existiam como REMINDER,
    // não em user_medications → no-op silencioso, mas a Xarlote dizia "vou
    // registrar" — mentira estrutural). Agora SEMPRE persiste algo:
    //   - hábito não-medicamentoso (água, exercício, sono) → evento analítico
    //   - medicamento que só existe como lembrete → cria a row inferida e loga
    const { data: rem } = await db
      .from('reminders')
      .select('id, type, title')
      .eq('user_id', ctx.userId)
      .in('status', ['pending', 'sent'])
      .ilike('title', `%${likeSafe(args.medication_name)}%`)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    const isHabit = rem?.type && rem.type !== 'medication';
    if (isHabit) {
      // Hábito (hidratação/exercício/sono/custom): registra evento — vira histórico
      // consultável sem poluir o perfil de medicamentos.
      await writeEvent({
        eventName: 'habit.logged',
        userId: ctx.userId,
        conversationId: ctx.conversationId,
        payload: { name: args.medication_name, status: args.status, reminder_type: rem.type, notes: args.notes ?? null },
      });
      await writeLog('info', 'tool', `habit.logged: "${args.medication_name}" (${args.status}) via lembrete ${rem.type}`, { traceId: ctx.traceId });
      return;
    }

    // Medicamento real que nunca entrou no perfil (ex: veio só de um lembrete):
    // cria inferido e segue o fluxo normal de log. Perfil se auto-completa.
    const { data: created, error: createErr } = await db
      .from('user_medications')
      .insert({ user_id: ctx.userId, medication_name: args.medication_name, active: true, source: 'inferred' })
      .select('id, treatment_id, medication_name, daily_consumption')
      .single();
    if (createErr || !created) {
      await writeLog('warn', 'tool', `log_medication_taken: medicamento "${args.medication_name}" não encontrado e não foi possível criar inferido (${createErr?.message ?? 'sem retorno'})`, { traceId: ctx.traceId });
      throw new ToolFailure(`NÃO consegui registrar ${args.medication_name}: esse medicamento não está no perfil e não deu pra criar. Agradeça o aviso, mas NÃO diga que "anotei"/"marquei".`);
    }
    await writeLog('info', 'tool', `log_medication_taken: "${args.medication_name}" criado como medicamento INFERIDO (só existia como lembrete)`, { traceId: ctx.traceId });
    med = created;
  }

  const { error: logErr } = await db.from('medication_log').insert({
    user_id: ctx.userId,
    medication_id: med.id,
    treatment_id: med.treatment_id,
    status: args.status,
    scheduled_at: new Date().toISOString(),
    responded_at: new Date().toISOString(),
    notes: args.notes,
  });
  if (logErr) {
    // Adesão que o usuário CONFIRMOU não pode se perder em silêncio (o
    // adherence-scorer lê essa tabela). Log honesto em vez de fingir sucesso.
    await writeLog('error', 'tool', `medication_log INSERT falhou ("${args.medication_name}"): ${logErr.message}`, { traceId: ctx.traceId, userId: ctx.userId });
    throw new ToolFailure(`NÃO consegui registrar que o paciente tomou ${args.medication_name} (falha ao gravar). Agradeça o aviso normalmente, mas NÃO afirme que "marquei"/"anotei" — o registro não existe.`);
  }

  // Se taken: decrementa inventário + update last_taken_at
  if (args.status === 'taken') {
    await db.from('user_medications').update({ last_taken_at: new Date().toISOString() }).eq('id', med.id);

    const consumption = med.daily_consumption ?? 1;
    // Decremento simples — pega inventory mais recente com remaining > 0
    const { data: inv } = await db
      .from('medication_inventory')
      .select('id, tablets_remaining')
      .eq('medication_id', med.id)
      .gt('tablets_remaining', 0)
      .order('purchased_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (inv?.id) {
      await db.from('medication_inventory').update({
        tablets_remaining: Math.max(0, inv.tablets_remaining - consumption),
      }).eq('id', inv.id);
    }
  }

  await writeAudit({
    actorType: 'xarlote',
    action: `medication.${args.status}`,
    userId: ctx.userId,
    targetTable: 'medication_log',
    targetId: med.id,
    conversationId: ctx.conversationId,
    traceId: ctx.traceId,
    metadata: { medication_name: med.medication_name, status: args.status, notes: args.notes },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// UPDATE_TREATMENT_STATUS
// ─────────────────────────────────────────────────────────────────────────────

export async function handleUpdateTreatmentStatus(args: UpdateTreatmentStatusArgs, ctx: BaseToolCtx): Promise<void> {
  // Acha tratamento por nome (do treatment ou da medicação principal)
  const { data: t } = await db
    .from('treatments')
    .select('id, name, status')
    .eq('user_id', ctx.userId)
    .eq('status', 'active')
    .ilike('name', `%${args.treatment_name}%`)
    .limit(1)
    .maybeSingle();

  let treatmentId = t?.id;
  let before = t;
  if (!treatmentId) {
    // Tenta achar via user_medications
    const { data: m } = await db
      .from('user_medications')
      .select('id, treatment_id, medication_name')
      .eq('user_id', ctx.userId)
      .ilike('medication_name', `%${args.treatment_name}%`)
      .eq('active', true)
      .limit(1)
      .maybeSingle();
    treatmentId = m?.treatment_id ?? undefined;
    if (treatmentId) {
      const { data: t2 } = await db.from('treatments').select('id, name, status').eq('id', treatmentId).single();
      before = t2;
    }
  }

  if (!treatmentId || !before) {
    await writeLog('warn', 'tool', `update_treatment_status: tratamento "${args.treatment_name}" não achado`, { traceId: ctx.traceId });
    throw new ToolFailure(`NADA FOI ALTERADO: não existe um tratamento chamado "${args.treatment_name}" no perfil do paciente. Confirme com ele qual tratamento é — e não diga que pausou/encerrou nada.`);
  }

  const update: Record<string, unknown> = { status: args.new_status };
  if (args.new_status === 'completed' || args.new_status === 'interrupted') {
    update['ended_at'] = new Date().toISOString().slice(0, 10);
  }
  if (args.new_status === 'interrupted') {
    update['interruption_reason'] = args.reason;
  }

  await db.from('treatments').update(update).eq('id', treatmentId);

  // Desativar reminders relacionados
  const { data: meds } = await db.from('user_medications').select('id').eq('treatment_id', treatmentId);
  const medIds = (meds ?? []).map((m) => m.id);
  if (medIds.length > 0) {
    await db.from('reminders')
      .update({ status: args.new_status === 'paused' ? 'snoozed' : 'cancelled' })
      .in('medication_id', medIds)
      .eq('status', 'pending');
  }

  await writeAudit({
    actorType: 'xarlote',
    action: `treatment.${args.new_status}`,
    userId: ctx.userId,
    targetTable: 'treatments',
    targetId: treatmentId,
    before: { status: before.status },
    after: { status: args.new_status },
    reason: args.reason,
    conversationId: ctx.conversationId,
    traceId: ctx.traceId,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// LOG_SYMPTOM
// ─────────────────────────────────────────────────────────────────────────────

export async function handleLogSymptom(args: LogSymptomArgs, ctx: BaseToolCtx): Promise<void> {
  // Red flag detection — palavras que disparam alerta
  const redFlags = ['dor no peito', 'falta de ar', 'desmaio', 'sangramento intenso',
                    'visão turva súbita', 'fala arrastada', 'paralisia', 'convulsão',
                    'overdose', 'suicídio', 'me matar', 'automutilação'];
  const lower = args.name.toLowerCase();
  const hitFlag = redFlags.find((rf) => lower.includes(rf));
  const isRedFlag = !!hitFlag || (args.intensity ?? 0) >= 9;

  const { data: row } = await db.from('symptoms_log').insert({
    user_id: ctx.userId,
    conversation_id: ctx.conversationId,
    name: args.name,
    intensity: args.intensity,
    duration_hours: args.duration_hours,
    context: args.context,
    red_flag_triggered: isRedFlag,
    red_flag_reason: hitFlag ?? (isRedFlag ? 'intensity_9_or_more' : null),
    source: 'self_reported',
  }).select('id').single();

  await writeAudit({
    actorType: 'xarlote',
    action: isRedFlag ? 'red_flag.detected' : 'symptom.logged',
    userId: ctx.userId,
    targetTable: 'symptoms_log',
    targetId: row?.id,
    conversationId: ctx.conversationId,
    traceId: ctx.traceId,
    metadata: {
      symptom: args.name,
      intensity: args.intensity,
      duration_hours: args.duration_hours,
      context: args.context,
      red_flag_keyword: hitFlag,
    },
  });

  if (isRedFlag) {
    await writeLog('warn', 'red_flag', `🚨 Red flag detectado: "${args.name}" (intensity=${args.intensity})`, {
      traceId: ctx.traceId, userId: ctx.userId, keyword: hitFlag,
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SET_DEFAULT_ADDRESS
// ─────────────────────────────────────────────────────────────────────────────

export async function handleSetDefaultAddress(args: { address_label: string }, ctx: BaseToolCtx): Promise<void> {
  // Acha endereço pelo label (case-insensitive). Escapa %/_ do ILIKE — senão um label
  // com wildcard casaria QUALQUER endereço (mesma lição do escapeLike de tool-executor).
  const labelPattern = (args.address_label ?? '').replace(/[\\%_]/g, (c) => `\\${c}`);
  const { data: addr } = await db
    .from('user_addresses')
    .select('id, label, is_default')
    .eq('user_id', ctx.userId)
    .ilike('label', labelPattern)
    .limit(1)
    .maybeSingle();

  if (!addr?.id) {
    await writeLog('warn', 'tool', `set_default_address: label "${args.address_label}" não encontrado`, { traceId: ctx.traceId });
    throw new ToolFailure(`NADA FOI ALTERADO: o paciente não tem endereço salvo com o nome "${args.address_label}". Pergunte qual endereço ele quer como principal — não diga que mudou.`);
  }
  if (addr.is_default) return; // já é default

  // Desmarca todos os outros (constraint partial índice garante 1 só)
  await db.from('user_addresses').update({ is_default: false }).eq('user_id', ctx.userId);
  await db.from('user_addresses').update({ is_default: true }).eq('id', addr.id);

  await writeAudit({
    actorType: 'xarlote',
    action: 'user.address.set_default',
    userId: ctx.userId,
    targetTable: 'user_addresses',
    targetId: addr.id,
    conversationId: ctx.conversationId,
    traceId: ctx.traceId,
    metadata: { label: args.address_label },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// CONSULTATION FLOW — fluxo completo de marcação de consulta médica
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Inicia a busca de consulta:
 *   1. Cria `consultations` (status='searching')
 *   2. Descobre top 5 clínicas via Places + cache (find_clinics RPC)
 *   3. Cria 1 `consultation_quotes` (pending) por clínica
 *   4. Dispara `initiateClinicNegotiation` paralelo, staggered 2s
 *   5. Agenda timer de consolidação (5min/10min)
 *
 * Idempotência: se já existe consultation ativa pro mesmo user+specialty
 *  ou status searching/quoted, retorna esse status em vez de criar nova.
 */
export async function handleStartConsultationSearch(args: StartConsultationArgs, ctx: BaseToolCtx): Promise<void> {
  const urgency = args.urgency ?? 'rotina';
  // 1. Idempotência — já tem consultation ativa?
  const { data: existing } = await db
    .from('consultations')
    .select('id, status, specialty')
    .eq('user_id', ctx.userId)
    .in('status', ['searching', 'quoting', 'quoted', 'confirming'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (existing?.id) {
    await writeLog('info', 'consultation', `start_consultation_search ignorado — já tem consulta ativa (${existing.status}, ${existing.specialty})`, { traceId: ctx.traceId });
    await sendOutbound(ctx.conversationId, ctx.phoneE164,
      `Você já tem uma busca de consulta em andamento (${existing.specialty}, status: ${existing.status}). Quer cancelar essa pra começar outra? Posso te ajudar.`,
      ctx.traceId);
    return;
  }

  // 2. Descobre lat/lng + cidade do paciente.
  //    Ordem: arg da tool → home_city do perfil → endereço default → último order.
  let lat: number | null = null;
  let lng: number | null = null;
  let city: string | null = args.city ?? null;
  let stateUf: string | null = null;

  // Lê perfil — home_city é a fonte preferida quando o paciente não disse cidade agora
  const { data: profile } = await db
    .from('users')
    .select('home_city, home_state')
    .eq('id', ctx.userId)
    .maybeSingle();
  if (!city && profile?.home_city) {
    city = profile.home_city;
    stateUf = profile.home_state ?? null;
  }

  {
    const { data: addr } = await db
      .from('user_addresses')
      .select('latitude, longitude, city, state')
      .eq('user_id', ctx.userId)
      .eq('is_default', true)
      .maybeSingle();
    if (addr) {
      lat = addr.latitude;
      lng = addr.longitude;
      city = city ?? addr.city;
      stateUf = stateUf ?? addr.state;
    }
  }
  if (lat == null || lng == null) {
    const { data: ord } = await db
      .from('orders')
      .select('delivery_lat, delivery_lng')
      .eq('user_id', ctx.userId)
      .not('delivery_lat', 'is', null)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (ord) {
      lat = ord.delivery_lat;
      lng = ord.delivery_lng;
    }
  }

  // Se o paciente informou uma cidade nova nesse pedido, salva no perfil pra
  // próxima vez a Xarlote só confirmar em vez de perguntar de novo.
  if (args.city && args.city.trim() && args.city.trim().toLowerCase() !== (profile?.home_city ?? '').toLowerCase()) {
    await db.from('users').update({
      home_city: args.city.trim(),
      ...(stateUf ? { home_state: stateUf } : {}),
    }).eq('id', ctx.userId);
    await writeAudit({
      actorType: 'xarlote',
      action: 'user.home_city.set',
      userId: ctx.userId,
      targetTable: 'users',
      targetId: ctx.userId,
      conversationId: ctx.conversationId,
      traceId: ctx.traceId,
      after: { home_city: args.city.trim() },
    });
  }

  // 3. Cria consultation status='searching'
  const { data: c, error } = await db.from('consultations').insert({
    user_id: ctx.userId,
    conversation_id: ctx.conversationId,
    status: 'searching',
    specialty: args.specialty,
    urgency,
    modality: args.modality ?? 'indiferente',
    city: city,
    preferences: { ...(args.preferences ?? {}), plan: args.plan } as never,
  }).select('id').single();

  if (error || !c) {
    await writeLog('error', 'tool', `start_consultation_search: falha ao criar consultation: ${error?.message}`, { traceId: ctx.traceId });
    await sendOutbound(ctx.conversationId, ctx.phoneE164,
      `Tive um problema técnico aqui pra iniciar a busca de ${args.specialty} 😔 Pode tentar de novo daqui a pouco?`,
      ctx.traceId);
    return;
  }

  await writeAudit({
    actorType: 'xarlote',
    action: 'consultation.search.started',
    userId: ctx.userId,
    targetTable: 'consultations',
    targetId: c.id,
    conversationId: ctx.conversationId,
    traceId: ctx.traceId,
    metadata: { specialty: args.specialty, urgency, modality: args.modality, city, plan: args.plan, lat, lng },
  });

  // 4. Notifica paciente
  await sendOutbound(ctx.conversationId, ctx.phoneE164,
    `Beleza! Vou procurar opções de ${args.specialty}${city ? ` em ${city}` : ''} agora 🔍 Pode demorar uns minutinhos — as clínicas costumam responder mais devagar que farmácia.`,
    ctx.traceId);

  // 5. Discovery (assíncrono, pra não bloquear o turno LLM)
  setImmediate(async () => {
    try {
      const candidates = await discoverClinics({
        specialty: args.specialty,
        city,
        state: stateUf,
        lat,
        lng,
        limit: 5,
        traceId: ctx.traceId,
      });

      if (candidates.length === 0) {
        await sendOutbound(ctx.conversationId, ctx.phoneE164,
          `Puxa, não consegui encontrar ${args.specialty}${city ? ` em ${city}` : ''} agora 😔 Pode ser que eu não tenha achado clínicas com contato disponível na região. Quer que eu tente em outra cidade próxima, ou prefere telemedicina?`,
          ctx.traceId);
        await db.from('consultations').update({ status: 'failed' }).eq('id', c.id);
        return;
      }

      // Cria consultation_quotes pending
      const quoteIds: string[] = [];
      for (const cand of candidates) {
        const { data: q } = await db.from('consultation_quotes').insert({
          consultation_id: c.id,
          clinic_id: cand.id,
          status: 'pending',
          modality: args.modality === 'indiferente' ? null : args.modality,
        }).select('id').single();
        if (q?.id) quoteIds.push(q.id);
      }

      await writeLog('info', 'consultation', `${quoteIds.length} cotação(ões) de consulta criadas`, {
        traceId: ctx.traceId, consultationId: c.id,
        clinics: candidates.map((p, i) => `${i + 1}. ${p.name} (${p.distance_km?.toFixed(1)}km)`),
      });

      await sendOutbound(ctx.conversationId, ctx.phoneE164,
        `Achei ${quoteIds.length} clínica${quoteIds.length > 1 ? 's' : ''} aqui e já estou entrando em contato ✨ assim que tiver respostas eu te aviso.`,
        ctx.traceId);

      // 6. Inicia negociações staggered 2s
      const patientFirstName = await getPatientFirstName(ctx.userId);
      for (let i = 0; i < quoteIds.length; i++) {
        const idx = i;
        const candidate = candidates[idx]!;
        const quoteId = quoteIds[idx]!;
        const delay = idx * 2000;
        setTimeout(() => {
          initiateClinicNegotiation({
            quoteId,
            consultationId: c.id,
            clinicId: candidate.id,
            clinicName: candidate.name,
            clinicWhatsApp: candidate.whatsapp_e164,
            ctx: {
              specialty: args.specialty,
              urgency,
              modality: args.modality ?? 'indiferente',
              patientCity: city,
              plan: args.plan ?? null,
              patientName: patientFirstName,
              preferredTime: (args.preferences as any)?.['horario_pref'] ?? null,
            },
            userConversationId: ctx.conversationId,
            userPhoneE164: ctx.phoneE164,
            traceId: ctx.traceId,
          }).catch((err) => writeLog('error', 'consultation', `Init clinic negotiation falhou: ${String(err)}`, { traceId: ctx.traceId }));
        }, delay);
      }

      // 7. Schedule consolidation timeout
      scheduleConsultationTimeout(c.id, ctx.conversationId, ctx.phoneE164, ctx.traceId);
    } catch (err) {
      await writeLog('error', 'consultation', `Discovery falhou: ${String(err).slice(0, 200)}`, { traceId: ctx.traceId });
    }
  });
}

/**
 * Confirma a consulta selecionada:
 *   - Atualiza consultation status='confirming', selected_quote_id, scheduled_at
 *   - Marca consultation_quote.status='selected', outras 'rejected'
 *   - Pede confirmação à clínica via agent-clinic (separate convo)
 *   - Cria reminders: 1 dia antes + 2h antes
 */
export async function handleConfirmConsultation(args: { consultation_id: string; quote_id?: string; requested_datetime?: string }, ctx: BaseToolCtx): Promise<void> {
  // ⚠️ Os ids vêm do MODELO e não são confiáveis (30/07: chegou `consultation_id:'Nilo
  // Machado Junior'` e `quote_id:'13/08/2026 09:00'`). Resolver ANTES de tocar em qualquer
  // coisa — e sempre dentro do que pertence a ESTE paciente. Referência insalvável lança
  // ToolFailure: o modelo lê o motivo e não anuncia uma confirmação que não houve.
  const consultation = await resolveConsultationForUser(args.consultation_id, ctx.userId, {
    action: 'confirmado', traceId: ctx.traceId,
  });
  const consultationId = consultation.id;
  const before = { status: consultation.status, specialty: consultation.specialty };
  // IDEMPOTÊNCIA (paridade com handleConfirmOrder): sem esta guarda, chamar de novo mandava
  // uma SEGUNDA mensagem real à clínica ("pode marcar pra…?") e inseria os lembretes 1d/2h
  // duplicados. Reconfirmar não é reagendar: se o paciente quer outro horário, fala-se com
  // a clínica.
  if (before.status === 'confirming' || before.status === 'scheduled') {
    throw new ToolFailure('Essa consulta JÁ está confirmada (aguardando/tendo a clínica reservado) — NÃO confirmei de novo e nenhuma mensagem nova foi enviada. Se o paciente quer OUTRO horário, fale com a clínica usando `nudge_consultation` com `message` (message_supplier é de FARMÁCIA) em vez de confirmar de novo.');
  }
  // 🔴 CONTRAPROPOSTA DO PACIENTE (auditoria 04/08 — o caminho que NÃO EXISTIA).
  // Em 03/08 o Ciro respondeu "Vou sair de viagem, não vai dar tempo. Marca dia 26 quarta
  // feira as 10h" — uma data que a clínica NUNCA tinha oferecido. Como confirmar exigia um
  // `quote_id` existente, o modelo não teve tool nenhuma pra usar: tentou `nudge_consultation`
  // vazio, depois `message_supplier` (que é de FARMÁCIA) e disse ao paciente "não achei
  // pedido em farmácias". A consulta nunca entrou em `confirming`, então quando a recepção
  // aceitou o dia 26 o detector de confirmação (teste de ESTADO) estava cego, e o
  // agendamento foi registrado à mão por um humano.
  // Negociar contraproposta é o caso NORMAL de agendamento — não uma exceção. Aqui ela
  // vira uma cotação de verdade, e todo o resto do fluxo (avisar a clínica, `confirming`,
  // lembretes, reconfirmação) funciona sem nenhum caminho paralelo.
  const q = await resolveConsultationQuoteOrCounterProposal(args, consultationId, consultation, ctx);
  const quoteId = q.id;
  // 🔒 CINTO E SUSPENSÓRIO. O resolvedor já filtra oferta vencida, mas confirmar é o passo
  // IRREVERSÍVEL: aqui as irmãs viram `rejected`, a clínica recebe mensagem real e, se ela
  // responder "confirmado", o worker de feedback pergunta "como foi sua consulta?" sobre
  // algo que nunca aconteceu e marca `completed`. Vale checar duas vezes.
  if (!isOfferStillValid(q.proposed_datetime, Date.now())) {
    throw new ToolFailure('NADA FOI CONFIRMADO: esse horário JÁ PASSOU. Não confirme data no passado — peça horários novos à clínica com `nudge_consultation` passando `message` (message_supplier é de FARMÁCIA) e explique ao paciente que a vaga anterior venceu.');
  }

  // 1. Atualiza consultation
  await db.from('consultations').update({
    status: 'confirming',
    selected_quote_id: quoteId,
    scheduled_at: q.proposed_datetime,
    scheduled_clinic_id: q.clinic_id,
    scheduled_prescriber_id: q.prescriber_id,
  }).eq('id', consultationId);

  // 2. Marca outras quotes como 'rejected'
  await db.from('consultation_quotes')
    .update({ status: 'rejected' })
    .eq('consultation_id', consultationId)
    .neq('id', quoteId)
    .eq('status', 'offered');

  // 3. Marca escolhida como 'selected'
  await db.from('consultation_quotes').update({ status: 'selected' }).eq('id', quoteId);

  await writeAudit({
    actorType: 'xarlote',
    action: 'consultation.quote_selected',
    userId: ctx.userId,
    targetTable: 'consultations',
    targetId: consultationId,
    before: { status: before.status },
    after: { status: 'confirming', selected_quote_id: quoteId },
    conversationId: ctx.conversationId,
    traceId: ctx.traceId,
    metadata: { clinic_id: q.clinic_id, scheduled_at: q.proposed_datetime },
  });

  // 4. Pede pra clínica confirmar o slot
  if (q.conversation_id) {
    const { data: conv } = await db.from('conversations').select('whatsapp_jid').eq('id', q.conversation_id).single();
    const clinicPhone = conv?.whatsapp_jid?.replace('@s.whatsapp.net', '');
    if (clinicPhone) {
      const patientFirst = await getPatientFirstName(ctx.userId);
      const dt = q.proposed_datetime ? formatBrDateTime(q.proposed_datetime) : 'o horário combinado';
      const planLine = q.plan_accepted && q.plan_accepted.toLowerCase() !== 'particular'
        ? ` Plano: ${q.plan_accepted}.`
        : ` (Particular.)`;
      const msg = `Oi! Fechei aqui${patientFirst ? ` com o ${patientFirst}` : ''} — pode marcar pra ${dt}?${planLine} Consegue reservar esse horário pra mim? Obrigada! 🙂`;
      // Reservar horário é o passo em que NÃO alcançar a clínica custa a consulta inteira:
      // o paciente ouve "fechei" e o consultório nunca soube. Assunto pro template sem PII.
      await sendOutboundToClinic(q.conversation_id, `+${clinicPhone}`, msg, ctx.traceId,
        'a reserva de um horário de consulta que preciso confirmar com vocês');
    }
  }

  // 5. Lembretes 1d/2h — agora pelo reconciliador ÚNICO (`appointment-commit`), o mesmo
  // que o lado da clínica e o worker de integridade usam. Antes era um bloco de inserts
  // solto aqui: sem idempotência (reconfirmar duplicava), sem restauração (o curinga do
  // `cancel_reminders` apagava o de 2h e nada recriava — foi o que o Ciro perdeu) e
  // divergindo do lado clínica, que não criava lembrete nenhum.
  if (q.proposed_datetime) {
    await reconcileAppointmentReminders({
      consultationId,
      userId: ctx.userId,
      specialty: before.specialty ?? null,
      scheduledIso: q.proposed_datetime,
      traceId: ctx.traceId,
    });
  }

  await writeLog('info', 'consultation', `Consulta confirmada — esperando clínica reconfirmar`, {
    traceId: ctx.traceId, consultationId: consultationId, quoteId: quoteId,
  });
}

/**
 * Resolve a cotação escolhida — e, se o paciente pediu um horário que a clínica NÃO
 * ofertou, cria a cotação que representa essa CONTRAPROPOSTA.
 *
 * Por que uma cotação de verdade, e não um caminho paralelo: tudo a jusante (avisar a
 * clínica, `confirming`, lembretes 1d/2h, detector de reconfirmação, card do paciente)
 * já funciona sobre uma cotação. Sem ela, cada uma dessas etapas precisaria de um "e se
 * for contraproposta" — seis lugares pra divergir. Com ela, zero.
 *
 * A cotação nasce marcada como proposta NOSSA (`notes`), nunca como oferta da clínica:
 * a clínica ainda vai dizer se aceita, e essa distinção é o que impede a Xarlote de
 * afirmar ao paciente que a clínica ofereceu algo que ela não ofereceu.
 */
async function resolveConsultationQuoteOrCounterProposal(
  args: { consultation_id: string; quote_id?: string; requested_datetime?: string },
  consultationId: string,
  consultation: { preferences?: Record<string, unknown> | null; specialty?: string | null },
  ctx: BaseToolCtx,
): Promise<QuoteRow> {
  // Caminho normal primeiro: o paciente escolheu uma das opções apresentadas.
  if (args.quote_id) {
    try {
      return await resolveConsultationQuote(args.quote_id, consultationId, {
        action: 'confirmado', traceId: ctx.traceId, preferences: consultation.preferences ?? null,
      });
    } catch (err) {
      // Sem `requested_datetime` não há contraproposta pra tentar: o erro original é o
      // que o modelo precisa ler (ele explica ao paciente que nada foi confirmado).
      if (!args.requested_datetime) throw err;
      await writeLog('info', 'consultation', 'quote_id não resolveu, mas há requested_datetime — tentando contraproposta', { traceId: ctx.traceId, consultationId });
    }
  }

  const pedido = (args.requested_datetime ?? '').trim();
  if (!pedido) {
    // Nenhum dos dois: cai no resolvedor pra ele lançar a ToolFailure com a lista de
    // opções reais (mensagem escrita pro modelo ler).
    return resolveConsultationQuote(args.quote_id, consultationId, {
      action: 'confirmado', traceId: ctx.traceId, preferences: consultation.preferences ?? null,
    });
  }

  // O horário vem do MODELO → nunca confiar no formato. Aceita ISO e, se não for ISO,
  // lê o português (é o que o paciente escreveu: "dia 26 quarta feira as 10h").
  const direto = Date.parse(pedido);
  const iso = Number.isFinite(direto) && /^\d{4}-\d{2}-\d{2}/.test(pedido)
    ? new Date(direto).toISOString()
    : (pickFutureBrDateTimes(pedido, Date.now())[0]?.iso ?? null);
  if (!iso) {
    throw new ToolFailure(`NADA FOI CONFIRMADO: não consegui entender "${pedido}" como data e hora. Pergunte ao paciente o dia e a hora exatos (ex.: "26/08 às 10h") e NÃO diga que confirmou.`);
  }
  if (!isOfferStillValid(iso, Date.now())) {
    throw new ToolFailure('NADA FOI CONFIRMADO: esse horário já passou. Peça ao paciente uma data futura e NÃO diga que confirmou.');
  }

  // A qual clínica propor. Uma cotação irmã dá o contexto comercial (preço, plano,
  // formas de pagamento) e a conversa por onde falar com a recepção.
  const { data: irmas } = await db
    .from('consultation_quotes')
    .select('id, clinic_id, prescriber_id, proposed_datetime, alternative_datetimes, modality, price_brl, plan_accepted, conversation_id, notes, clinics(name)')
    .eq('consultation_id', consultationId)
    .not('clinic_id', 'is', null)
    .order('created_at', { ascending: false })
    .limit(5);
  const base = (irmas ?? []).find((r) => r.conversation_id) ?? (irmas ?? [])[0] ?? null;
  if (!base?.clinic_id) {
    throw new ToolFailure('NADA FOI CONFIRMADO: essa consulta ainda não tem nenhuma clínica em negociação, então não há com quem confirmar esse horário. Use `nudge_consultation` com `message` pra falar com o consultório, ou abra uma busca nova.');
  }

  // Já existe cotação nesse MESMO horário? Reusa (idempotência: o paciente repetir
  // "marca dia 26 às 10" não pode criar duas cotações e duas mensagens à clínica).
  const igual = (irmas ?? []).find((r) => sameSlot(r.proposed_datetime as string | null, iso));
  if (igual) {
    await writeLog('info', 'consultation', 'contraproposta já tinha cotação nesse horário — reusando', { traceId: ctx.traceId, consultationId, quoteId: igual.id });
    return igual as unknown as QuoteRow;
  }

  const { data: nova, error } = await db.from('consultation_quotes').insert({
    consultation_id: consultationId,
    clinic_id: base.clinic_id,
    prescriber_id: base.prescriber_id,
    conversation_id: base.conversation_id,
    status: 'offered',
    proposed_datetime: iso,
    price_brl: base.price_brl,
    plan_accepted: base.plan_accepted,
    modality: base.modality ?? 'presencial',
    notes: [base.notes, 'horário pedido PELO PACIENTE (contraproposta) — a clínica ainda vai confirmar'].filter(Boolean).join(' · '),
  }).select('id, clinic_id, prescriber_id, proposed_datetime, alternative_datetimes, modality, price_brl, plan_accepted, conversation_id, clinics(name)').single();

  if (error || !nova) {
    await writeLog('error', 'consultation', `contraproposta: insert da cotação falhou (${error?.message.slice(0, 120)})`, { traceId: ctx.traceId, consultationId });
    throw new ToolFailure('NADA FOI CONFIRMADO: deu um problema técnico ao registrar o horário que o paciente pediu. Avise que houve uma falha e que ele pode pedir de novo — NÃO diga que confirmou.');
  }

  await writeLog('info', 'consultation', `contraproposta do paciente registrada como cotação (${iso}) — vou pedir a reserva à clínica`, {
    traceId: ctx.traceId, consultationId, quoteId: nova.id,
  });
  await writeAudit({
    actorType: 'xarlote',
    action: 'consultation_quote.counter_proposal',
    userId: ctx.userId,
    targetTable: 'consultation_quotes',
    targetId: nova.id,
    conversationId: ctx.conversationId,
    traceId: ctx.traceId,
    metadata: { proposed_datetime: iso, clinic_id: base.clinic_id, raw: pedido.slice(0, 80) },
  });
  return nova as unknown as QuoteRow;
}

/** Cancela consulta marcada/em busca. */
export async function handleCancelConsultation(
  args: { consultation_id: string; reason: string },
  ctx: BaseToolCtx & { inbound?: { text?: string | null } },
): Promise<void> {
  // 🛡️ AMBIGUIDADE NUNCA ENCERRA (auditoria 04/08 — caso Glauber). Em 02/08 ele respondeu
  // "Não precisa" à pergunta "vai usar plano ou é particular?" — quer dizer "não precisa de
  // PLANO" — e a Xarlote encerrou a busca de cardiologista. Assimetria de custo: encerrar
  // por engano custa a consulta; perguntar de novo custa uma frase. Então uma negação curta
  // e ambígua NÃO cancela: o modelo é mandado desambiguar primeiro.
  const falaDoPaciente = ctx.inbound?.text ?? '';
  if (falaDoPaciente && isAmbiguousNegation(falaDoPaciente)) {
    throw new ToolFailure(`NADA FOI CANCELADO. A última mensagem do paciente ("${falaDoPaciente.trim().slice(0, 40)}") é uma negação CURTA e AMBÍGUA: ela pode estar respondendo à SUA última pergunta (ex.: "não preciso de plano, é particular") e não desistindo da consulta. NÃO encerre nada e NÃO diga que cancelou. Pergunte de forma direta a qual das duas coisas ele se refere.`);
  }
  // 🔴 INCIDENTE 30/07 18:52 (Glauber): o modelo mandou um `consultation_id` inventado, o
  // `.single()` não achou nada, o handler fez `return` MUDO, a task foi carimbada `success`
  // e a Xarlote anunciou "Pronto, cancelei a consulta com o Dr. Marco Elísio" — com a
  // consulta VIVA. Cinco horas depois o rescue a contradisse na cara do paciente.
  // Agora: resolve dentro das consultas DELE (uuid alheio nunca entra) e, se não der pra
  // ter certeza, lança ToolFailure — o modelo lê "NADA FOI CANCELADO" e conta a verdade.
  // `failed` entra AQUI (e só aqui): o bloco de contexto mostra a consulta que não fechou
  // nas últimas 24h como RETOMÁVEL e manda usar cancel_consultation se o paciente desistir.
  // Sem ela na lista, o resolvedor diria "não há consulta em andamento" contradizendo o
  // prompt do mesmo turno — e o nudge depois REVIVERIA a consulta que ele mandou cancelar.
  const consultation = await resolveConsultationForUser(args.consultation_id, ctx.userId, {
    action: 'cancelado', traceId: ctx.traceId,
    statuses: [...LIVE_CONSULTATION_STATUSES, 'failed'],
  });
  const consultationId = consultation.id;
  const before = { status: consultation.status, scheduled_at: consultation.scheduled_at };

  // CAS: só cancela o que ainda não foi cancelado. Sem isto, dois turnos concorrentes
  // (ou tool + backstop) avisariam a clínica duas vezes do mesmo cancelamento.
  const { data: cancelled } = await db.from('consultations').update({
    status: 'cancelled',
    cancelled_reason: args.reason,
  }).eq('id', consultationId).neq('status', 'cancelled').select('id');
  if (!cancelled?.length) {
    throw new ToolFailure('Essa consulta JÁ estava cancelada — nada mudou agora. Não anuncie um cancelamento novo; se o paciente perguntou, apenas confirme que ela já não está mais de pé.');
  }

  // 🔴 Cancela os lembretes DESTA consulta.
  // O filtro era `type='consultation'` — tipo que NÃO EXISTE no enum `reminder_type_t`
  // (o lembrete de consulta é `appointment`; está anotado no próprio handler que os cria).
  // Ou seja: cancelar a consulta NUNCA cancelou lembrete nenhum, e o paciente que desmarcou
  // continuava recebendo "Consulta em 2 horas". Exatamente o inverso do bug do Ciro, e a
  // mesma classe: string de tipo que não casa com nada, falhando em silêncio.
  // O `cancel_reason` é o que diz ao reconciliador que isto foi PEDIDO — ele não recria.
  {
    const { data: alvos } = await db.from('reminders')
      .select('id, payload')
      .eq('user_id', ctx.userId)
      .eq('type', 'appointment')
      .eq('status', 'pending')
      .filter('payload->>consultation_id', 'eq', consultationId);
    for (const r of alvos ?? []) {
      const prev = (r.payload ?? {}) as Record<string, unknown>;
      await db.from('reminders')
        .update({ status: 'cancelled', payload: { ...prev, cancel_reason: 'patient_request' } })
        .eq('id', r.id);
    }
    if ((alvos ?? []).length > 0) {
      await writeLog('info', 'consultation', `${alvos!.length} lembrete(s) da consulta cancelados junto com ela`, {
        traceId: ctx.traceId, consultationId,
      });
    }
  }

  // Avisa a clínica se já tinha marcação confirmada
  if (before.status === 'confirming' || before.status === 'scheduled') {
    const { data: q } = await db.from('consultation_quotes')
      .select('conversation_id')
      .eq('consultation_id', consultationId)
      .eq('status', 'selected')
      .maybeSingle();
    if (q?.conversation_id) {
      const { data: conv } = await db.from('conversations').select('whatsapp_jid').eq('id', q.conversation_id).single();
      const clinicPhone = conv?.whatsapp_jid?.replace('@s.whatsapp.net', '');
      if (clinicPhone) {
        const msg = `Oi! Infelizmente vou precisar cancelar essa consulta que marquei 😕 Desculpa o transtorno e obrigada pela atenção!`;
        // Cancelamento que não chega deixa a clínica com um horário bloqueado à espera de
        // alguém que não vai aparecer. Vale um template pra alcançar.
        await sendOutboundToClinic(q.conversation_id, `+${clinicPhone}`, msg, ctx.traceId,
          'o cancelamento de um horário de consulta que eu tinha marcado com vocês');
      }
    }
  }

  await writeAudit({
    actorType: 'xarlote',
    action: 'consultation.cancelled',
    userId: ctx.userId,
    targetTable: 'consultations',
    targetId: consultationId,
    before: { status: before.status },
    after: { status: 'cancelled' },
    reason: args.reason,
    conversationId: ctx.conversationId,
    traceId: ctx.traceId,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// SET_EMERGENCY_CONTACT
// ─────────────────────────────────────────────────────────────────────────────

export interface SetEmergencyContactArgs {
  name: string;
  phone_e164: string;
  relation: string;
}

export async function handleSetEmergencyContact(args: SetEmergencyContactArgs, ctx: BaseToolCtx): Promise<void> {
  // Normaliza phone — garante + no início e só dígitos depois
  let phone = args.phone_e164.trim();
  if (!phone.startsWith('+')) {
    // Tenta inferir prefixo Brasil se o número tem 12-13 dígitos sem prefixo
    const digits = phone.replace(/\D/g, '');
    if (digits.length >= 10 && digits.length <= 13) {
      phone = digits.startsWith('55') ? `+${digits}` : `+55${digits}`;
    } else {
      // Silêncio aqui é o mais caro de todos: a Xarlote diria "guardei o contato da sua
      // filha" e, num red flag, não haveria quem avisar.
      await writeLog('warn', 'tool', `set_emergency_contact: phone inválido (${digits.length} dígitos)`, { traceId: ctx.traceId });
      throw new ToolFailure('NÃO guardei o contato de emergência: o telefone não parece válido. Peça o número completo com DDD ao paciente e NÃO diga que salvou.');
    }
  }

  const { data: before } = await db
    .from('users')
    .select('emergency_contact_name, emergency_contact_phone_e164, emergency_contact_relation')
    .eq('id', ctx.userId)
    .single();

  const { error } = await db.from('users').update({
    emergency_contact_name: args.name.trim().slice(0, 120),
    emergency_contact_phone_e164: phone,
    emergency_contact_relation: args.relation.trim().slice(0, 40),
  }).eq('id', ctx.userId);

  if (error) {
    const schemaPendente = error.message?.includes('column') || error.message?.includes('does not exist');
    await writeLog(schemaPendente ? 'warn' : 'error', 'tool', `set_emergency_contact: ${schemaPendente ? 'schema pendente (migration 0007)' : error.message}`, { traceId: ctx.traceId });
    throw new ToolFailure('NÃO consegui guardar o contato de emergência (falha técnica ao gravar). NÃO diga que salvou — avise o paciente que deu um problema e que ele pode tentar de novo daqui a pouco.');
  }

  await writeAudit({
    actorType: 'xarlote',
    action: 'user.emergency_contact.set',
    userId: ctx.userId,
    targetTable: 'users',
    targetId: ctx.userId,
    conversationId: ctx.conversationId,
    traceId: ctx.traceId,
    before: before ?? undefined,
    after: { emergency_contact_name: args.name, emergency_contact_phone_e164: phone, emergency_contact_relation: args.relation },
  });

  // LGPD: nome/telefone do contato NÃO vão pro log — só a relação (não identifica).
  await writeLog('info', 'tool', `Contato de emergência cadastrado (${args.relation})`, {
    traceId: ctx.traceId, userId: ctx.userId,
  });
}

// ─── Helpers ────────────────────────────────────────────────────────────────

async function getPatientFirstName(userId: string): Promise<string | null> {
  const { data: u } = await db.from('users').select('preferred_name, full_name').eq('id', userId).single();
  const name = u?.preferred_name || u?.full_name;
  if (!name) return null;
  return String(name).split(/\s+/)[0] ?? null;
}

function formatBrDateTime(iso: string): string {
  try {
    const d = new Date(iso);
    const date = d.toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: '2-digit', timeZone: 'America/Sao_Paulo' });
    const time = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' });
    return `${date} às ${time}`;
  } catch {
    return iso;
  }
}
