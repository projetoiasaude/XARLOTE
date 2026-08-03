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
import { nextOccurrence, isOfferStillValid } from '@iasaude/shared';
import { sendOutbound } from './outbound.js';
import { discoverClinics } from './clinic-discovery.js';
import { initiateClinicNegotiation } from './agent-clinic.js';
import { scheduleConsultationTimeout } from './consultation-consolidation.js';
import { sendOutboundToClinic } from './outbound-agent.js';
import { ToolFailure, resolveConsultationForUser, resolveConsultationQuote, resolveOrderForUser, LIVE_CONSULTATION_STATUSES } from './entity-resolve.js';

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
    urgency: args.urgency,
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
    metadata: { specialty: args.specialty, urgency: args.urgency, modality: args.modality, city, plan: args.plan, lat, lng },
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
              urgency: args.urgency,
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
export async function handleConfirmConsultation(args: { consultation_id: string; quote_id: string }, ctx: BaseToolCtx): Promise<void> {
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
  const q = await resolveConsultationQuote(args.quote_id, consultationId, {
    action: 'confirmado', traceId: ctx.traceId, preferences: consultation.preferences,
  });
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

  // 5. Cria reminders (1d antes + 2h antes) se proposed_datetime válido
  if (q.proposed_datetime) {
    const consultDate = new Date(q.proposed_datetime);
    if (!isNaN(consultDate.getTime())) {
      const oneDayBefore = new Date(consultDate.getTime() - 24 * 3600 * 1000);
      const twoHoursBefore = new Date(consultDate.getTime() - 2 * 3600 * 1000);
      const now = new Date();

      // type='appointment' (o enum reminder_type_t NÃO tem 'consultation' → o insert
      // antigo falhava em silêncio e os lembretes NUNCA eram criados).
      if (oneDayBefore > now) {
        const { error: e1 } = await db.from('reminders').insert({
          user_id: ctx.userId,
          type: 'appointment',
          title: `Consulta de ${before.specialty} amanhã`,
          body: `Sua consulta com a clínica está marcada pra amanhã às ${consultDate.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' })}.`,
          scheduled_at: oneDayBefore.toISOString(),
          next_run_at: oneDayBefore.toISOString(),
          status: 'pending',
          payload: { consultation_id: consultationId, quote_id: quoteId, kind: '1d_before' },
        });
        if (e1) await writeLog('error', 'consultation', `lembrete 1d_before falhou: ${e1.message}`, { traceId: ctx.traceId });
      }
      if (twoHoursBefore > now) {
        const { error: e2 } = await db.from('reminders').insert({
          user_id: ctx.userId,
          type: 'appointment',
          title: `Consulta em 2 horas`,
          body: `Sua consulta de ${before.specialty} é hoje em 2 horas. Não esquece! 💙`,
          scheduled_at: twoHoursBefore.toISOString(),
          next_run_at: twoHoursBefore.toISOString(),
          status: 'pending',
          payload: { consultation_id: consultationId, quote_id: quoteId, kind: '2h_before' },
        });
        if (e2) await writeLog('error', 'consultation', `lembrete 2h_before falhou: ${e2.message}`, { traceId: ctx.traceId });
      }
      // Consulta confirmada SEM nenhum lembrete criado (horário tão próximo que as duas
      // âncoras já passaram) deixava de ser registrado em qualquer lugar. Era o único sinal
      // temporal do handler, e era silencioso: o paciente "tem consulta" e nada o avisa.
      if (oneDayBefore <= now && twoHoursBefore <= now) {
        await writeLog('warn', 'consultation', `Consulta confirmada mas NENHUM lembrete criado — o horário está a menos de 2h, as duas âncoras (1d/2h) já passaram`, {
          traceId: ctx.traceId, consultationId,
        });
      }
    }
  }

  await writeLog('info', 'consultation', `Consulta confirmada — esperando clínica reconfirmar`, {
    traceId: ctx.traceId, consultationId: consultationId, quoteId: quoteId,
  });
}

/** Cancela consulta marcada/em busca. */
export async function handleCancelConsultation(args: { consultation_id: string; reason: string }, ctx: BaseToolCtx): Promise<void> {
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

  // Cancela reminders relacionados
  await db.from('reminders')
    .update({ status: 'cancelled' })
    .eq('user_id', ctx.userId)
    .eq('type', 'consultation')
    .eq('status', 'pending')
    .filter('payload->>consultation_id', 'eq', consultationId);

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
