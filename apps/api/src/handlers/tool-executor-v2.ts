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
import { db, writeAudit, writeLog } from '@iasaude/db';
import { sendOutbound } from './outbound.js';

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
  urgency: 'rotina' | '72h' | '24h' | 'urgente';
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
  // 1. Busca order pra extrair items + supplier
  const { data: order, error: orderErr } = await db
    .from('orders')
    .select('id, status, items, selected_quote_id, user_id')
    .eq('id', args.order_id)
    .single();

  if (orderErr || !order || order.user_id !== ctx.userId) {
    await writeLog('warn', 'tool', `start_treatment_from_order: order ${args.order_id} não encontrado ou de outro user`, { traceId: ctx.traceId });
    return;
  }
  if (order.status !== 'confirming' && order.status !== 'handed_off' && order.status !== 'completed') {
    await writeLog('warn', 'tool', `start_treatment_from_order: order status=${order.status}, ainda não confirmado`, { traceId: ctx.traceId });
    return;
  }

  const items = (order.items as Array<{ name: string; dosage?: string; quantity?: number }> | null) ?? [];
  if (items.length === 0) {
    await writeLog('warn', 'tool', `start_treatment_from_order: order sem items`, { traceId: ctx.traceId });
    return;
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
    return;
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

    // Cria reminder diário (RRULE DAILY)
    const parts = args.reminder_time.split(':').map((s) => parseInt(s, 10));
    const hour = parts[0];
    const minute = parts[1] ?? 0;
    if (typeof hour === 'number' && !Number.isNaN(hour) && hour >= 0 && hour < 24) {
      const nextRunAt = new Date();
      nextRunAt.setHours(hour, minute, 0, 0);
      if (nextRunAt <= new Date()) nextRunAt.setDate(nextRunAt.getDate() + 1);

      await db.from('reminders').insert({
        user_id: ctx.userId,
        type: 'medication',
        title: `Hora do ${item.name}${item.dosage ? ` ${item.dosage}` : ''}`,
        body: `Lembre de tomar ${args.daily_consumption} cp. Já tomou?`,
        scheduled_at: nextRunAt.toISOString(),
        rrule: `FREQ=DAILY;BYHOUR=${hour};BYMINUTE=${minute}`,
        next_run_at: nextRunAt.toISOString(),
        status: 'pending',
        medication_id: medId,
      });
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
  // Acha a medicação por nome (fuzzy)
  const { data: med } = await db
    .from('user_medications')
    .select('id, treatment_id, medication_name, daily_consumption')
    .eq('user_id', ctx.userId)
    .ilike('medication_name', `%${args.medication_name}%`)
    .eq('active', true)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!med?.id) {
    await writeLog('warn', 'tool', `log_medication_taken: medicamento "${args.medication_name}" não encontrado pra user ${ctx.userId}`, { traceId: ctx.traceId });
    return;
  }

  await db.from('medication_log').insert({
    user_id: ctx.userId,
    medication_id: med.id,
    treatment_id: med.treatment_id,
    status: args.status,
    scheduled_at: new Date().toISOString(),
    responded_at: new Date().toISOString(),
    notes: args.notes,
  });

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
    return;
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
  // Acha endereço pelo label (case-insensitive)
  const { data: addr } = await db
    .from('user_addresses')
    .select('id, label, is_default')
    .eq('user_id', ctx.userId)
    .ilike('label', args.address_label)
    .limit(1)
    .maybeSingle();

  if (!addr?.id) {
    await writeLog('warn', 'tool', `set_default_address: label "${args.address_label}" não encontrado`, { traceId: ctx.traceId });
    return;
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
// CONSULTATION TOOLS (esqueleto — fluxo de cotação fica pra próxima sessão)
// ─────────────────────────────────────────────────────────────────────────────

export async function handleStartConsultationSearch(args: StartConsultationArgs, ctx: BaseToolCtx): Promise<void> {
  // Cria a consultation em status='drafting'. Worker clinic-discoverer popula
  // clínicas via Places API e dispara agent-clinic em paralelo (próxima sprint).
  const { data: c, error } = await db.from('consultations').insert({
    user_id: ctx.userId,
    conversation_id: ctx.conversationId,
    status: 'drafting',
    specialty: args.specialty,
    urgency: args.urgency,
    modality: args.modality ?? 'indiferente',
    city: args.city,
    preferences: { ...args.preferences, plan: args.plan } as never,
  }).select('id').single();

  if (error || !c) {
    await writeLog('error', 'tool', `start_consultation_search: falha ao criar consultation: ${error?.message}`, { traceId: ctx.traceId });
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
    metadata: {
      specialty: args.specialty,
      urgency: args.urgency,
      modality: args.modality,
      city: args.city,
      plan: args.plan,
    },
  });

  // Por enquanto, devolve ao user uma mensagem de "em andamento". A integração
  // com clínicas (agent-clinic) vem na próxima sprint.
  await sendOutbound(ctx.conversationId, ctx.phoneE164,
    `Beleza! Vou buscar opções de ${args.specialty} pra você. Esse fluxo está sendo finalizado, te aviso assim que tiver as cotações. 💙`,
    ctx.traceId);
}

export async function handleConfirmConsultation(args: { consultation_id: string; quote_id: string }, ctx: BaseToolCtx): Promise<void> {
  const { data: before } = await db.from('consultations').select('status').eq('id', args.consultation_id).single();
  await db.from('consultations').update({
    status: 'confirming',
    selected_quote_id: args.quote_id,
  }).eq('id', args.consultation_id);

  await writeAudit({
    actorType: 'xarlote',
    action: 'consultation.quote_selected',
    userId: ctx.userId,
    targetTable: 'consultations',
    targetId: args.consultation_id,
    before: before ? { status: before.status } : undefined,
    after: { status: 'confirming', selected_quote_id: args.quote_id },
    conversationId: ctx.conversationId,
    traceId: ctx.traceId,
  });
}

export async function handleCancelConsultation(args: { consultation_id: string; reason: string }, ctx: BaseToolCtx): Promise<void> {
  const { data: before } = await db.from('consultations').select('status').eq('id', args.consultation_id).single();
  await db.from('consultations').update({
    status: 'cancelled',
    cancelled_reason: args.reason,
  }).eq('id', args.consultation_id);

  await writeAudit({
    actorType: 'xarlote',
    action: 'consultation.cancelled',
    userId: ctx.userId,
    targetTable: 'consultations',
    targetId: args.consultation_id,
    before: before ? { status: before.status } : undefined,
    after: { status: 'cancelled' },
    reason: args.reason,
    conversationId: ctx.conversationId,
    traceId: ctx.traceId,
  });
}
