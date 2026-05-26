/**
 * skill-extractor — detecta padrões emergentes no comportamento dos pacientes
 * e cria entradas em `agent_skills` que a Xarlote consulta antes de cada turno.
 *
 * Padrões V1 (heurísticas determinísticas — sem LLM):
 *   1. PREFERRED_REMINDER_TIME: usuário escolheu mesmo horário (HH:00) em ≥3
 *      start_treatment_from_order. → skill default reminder_time.
 *   2. PREFERRED_PHARMACY: usuário selecionou mesmo supplier_id em ≥3 orders
 *      confirmados. → skill priorizar essa farmácia na lista.
 *   3. ROUTINE_MEDICATION_TIMING: log_medication_taken consistentemente no
 *      mesmo período do dia (manhã/tarde/noite, ±2h). → memory + skill.
 *   4. PREFERRED_PLAN: usuário sempre confirma "particular" ou "Unimed" em
 *      ≥2 consultations → skill default plan.
 *
 * Roda 1x/dia (4h da manhã BRT). Idempotente: skills com mesma
 * (user_id, trigger_pattern, action_pattern) recebem `occurrences += 1` +
 * `last_observed_at = now()` em vez de duplicar.
 */
import { db, writeLog, writeAudit } from '@iasaude/db';

const POLL_INTERVAL_MS = 24 * 60 * 60 * 1000; // 1 dia
const MIN_OCCURRENCES = 3;
const LOOKBACK_DAYS = 90;

interface SkillCandidate {
  userId: string;
  triggerPattern: string;
  actionPattern: string;
  context: Record<string, unknown>;
  occurrences: number;
}

async function upsertSkill(skill: SkillCandidate, traceId: string): Promise<boolean> {
  try {
    // Procura skill existente pra esse user+trigger+action
    const { data: existing } = await db
      .from('agent_skills')
      .select('id, occurrences')
      .eq('user_id', skill.userId)
      .eq('trigger_pattern', skill.triggerPattern)
      .eq('action_pattern', skill.actionPattern)
      .maybeSingle();

    if (existing?.id) {
      await db.from('agent_skills').update({
        occurrences: skill.occurrences, // total recalculado
        last_observed_at: new Date().toISOString(),
        context: skill.context as never,
      }).eq('id', existing.id);
      return false; // não é nova
    }

    if (skill.occurrences < MIN_OCCURRENCES) return false;

    const { error } = await db.from('agent_skills').insert({
      user_id: skill.userId,
      trigger_pattern: skill.triggerPattern,
      action_pattern: skill.actionPattern,
      context: skill.context as never,
      occurrences: skill.occurrences,
      last_observed_at: new Date().toISOString(),
      active: true,
    });

    if (!error) {
      await writeAudit({
        actorType: 'system',
        actorId: 'skill-extractor',
        action: 'skill.created',
        userId: skill.userId,
        targetTable: 'agent_skills',
        traceId,
        metadata: { trigger: skill.triggerPattern, action: skill.actionPattern, occurrences: skill.occurrences },
      });
      return true;
    }
  } catch (err) {
    if (!String(err).includes('does not exist')) {
      await writeLog('warn', 'skill-extractor', `upsert skill falhou: ${String(err).slice(0, 120)}`, { traceId });
    }
  }
  return false;
}

// ─── Pattern 1: preferred_reminder_time ────────────────────────────────────
async function extractPreferredReminderTime(userId: string, traceId: string): Promise<SkillCandidate | null> {
  const cutoff = new Date(Date.now() - LOOKBACK_DAYS * 86400_000).toISOString();
  const { data, error } = await db
    .from('audit_log')
    .select('metadata')
    .eq('user_id', userId)
    .eq('action', 'treatment.started')
    .gte('occurred_at', cutoff)
    .limit(50);

  if (error || !data || data.length < MIN_OCCURRENCES) return null;

  const hours: Record<string, number> = {};
  for (const r of data) {
    const md = r.metadata as Record<string, unknown> | null;
    if (!md) continue;
    const time = md['reminder_time'] as string | undefined;
    if (!time) continue;
    const hour = String(time).split(':')[0];
    if (!hour) continue;
    hours[hour] = (hours[hour] ?? 0) + 1;
  }

  const top = Object.entries(hours).sort((a, b) => b[1] - a[1])[0];
  if (!top || top[1] < MIN_OCCURRENCES) return null;

  return {
    userId,
    triggerPattern: 'iniciar_lembrete_medicamento',
    actionPattern: `propor_horario_default_${top[0]}h`,
    context: { preferred_hour: parseInt(top[0], 10), total_observations: top[1] },
    occurrences: top[1],
  };
}

// ─── Pattern 2: preferred_pharmacy ─────────────────────────────────────────
async function extractPreferredPharmacy(userId: string, traceId: string): Promise<SkillCandidate | null> {
  const cutoff = new Date(Date.now() - LOOKBACK_DAYS * 86400_000).toISOString();

  const { data: orders } = await db
    .from('orders')
    .select('selected_quote_id, status, created_at')
    .eq('user_id', userId)
    .in('status', ['confirming', 'handed_off', 'completed'])
    .gte('created_at', cutoff);

  if (!orders || orders.length < MIN_OCCURRENCES) return null;

  const supplierCounts: Record<string, { count: number; name?: string }> = {};
  for (const o of orders) {
    if (!o.selected_quote_id) continue;
    const { data: q } = await db.from('quotes').select('supplier_id, suppliers(name)').eq('id', o.selected_quote_id).single();
    const supplierId = (q as any)?.supplier_id as string | undefined;
    if (!supplierId) continue;
    const name = (q as any)?.suppliers?.name as string | undefined;
    supplierCounts[supplierId] = {
      count: (supplierCounts[supplierId]?.count ?? 0) + 1,
      name: name ?? supplierCounts[supplierId]?.name,
    };
  }

  const top = Object.entries(supplierCounts).sort((a, b) => b[1].count - a[1].count)[0];
  if (!top || top[1].count < MIN_OCCURRENCES) return null;

  return {
    userId,
    triggerPattern: 'iniciar_pedido_farmacia',
    actionPattern: `priorizar_supplier_${top[0]}`,
    context: { supplier_id: top[0], supplier_name: top[1].name, total_orders: top[1].count },
    occurrences: top[1].count,
  };
}

// ─── Pattern 3: routine_medication_timing ──────────────────────────────────
// Quando o paciente responde "tomei" no log_medication_taken consistentemente
// no mesmo período (manhã 6-11, tarde 12-17, noite 18-23), aprende a janela.
async function extractMedicationTiming(userId: string, _traceId: string): Promise<SkillCandidate | null> {
  const cutoff = new Date(Date.now() - 30 * 86400_000).toISOString();
  const { data: logs } = await db
    .from('medication_log')
    .select('responded_at, status')
    .eq('user_id', userId)
    .eq('status', 'taken')
    .gte('responded_at', cutoff);

  if (!logs || logs.length < MIN_OCCURRENCES) return null;

  const buckets = { manha: 0, tarde: 0, noite: 0 };
  for (const l of logs) {
    if (!l.responded_at) continue;
    try {
      const d = new Date(l.responded_at);
      const h = d.getHours();
      if (h >= 6 && h < 12) buckets.manha++;
      else if (h >= 12 && h < 18) buckets.tarde++;
      else if (h >= 18 && h < 24) buckets.noite++;
    } catch {}
  }

  const top = Object.entries(buckets).sort((a, b) => b[1] - a[1])[0]!;
  const total = logs.length;
  // só vira skill se >=70% das tomadas estão no mesmo período
  if (top[1] / total < 0.7 || top[1] < MIN_OCCURRENCES) return null;

  return {
    userId,
    triggerPattern: 'lembrete_medicamento',
    actionPattern: `agendar_periodo_${top[0]}`,
    context: { period: top[0], ratio: top[1] / total, sample_size: total },
    occurrences: top[1],
  };
}

// ─── Pattern 4: preferred_plan ─────────────────────────────────────────────
async function extractPreferredPlan(userId: string, _traceId: string): Promise<SkillCandidate | null> {
  const cutoff = new Date(Date.now() - LOOKBACK_DAYS * 86400_000).toISOString();
  const { data } = await db
    .from('consultations')
    .select('preferences')
    .eq('user_id', userId)
    .in('status', ['scheduled', 'completed'])
    .gte('created_at', cutoff);

  if (!data || data.length < 2) return null;

  const plans: Record<string, number> = {};
  for (const c of data) {
    const prefs = c.preferences as Record<string, unknown> | null;
    const plan = prefs?.['plan'] as string | undefined;
    if (!plan) continue;
    const key = String(plan).toLowerCase().trim();
    plans[key] = (plans[key] ?? 0) + 1;
  }

  const top = Object.entries(plans).sort((a, b) => b[1] - a[1])[0];
  if (!top || top[1] < 2) return null;

  return {
    userId,
    triggerPattern: 'marcar_consulta',
    actionPattern: `default_plano_${top[0]}`,
    context: { plan: top[0], total: top[1] },
    occurrences: top[1],
  };
}

async function runOnce(): Promise<void> {
  try {
    // Acha users ativos (com pelo menos uma row em audit_log nos últimos 30d)
    const cutoff = new Date(Date.now() - 30 * 86400_000).toISOString();
    const { data, error } = await db
      .from('audit_log')
      .select('user_id')
      .gte('occurred_at', cutoff)
      .not('user_id', 'is', null)
      .limit(2000);

    if (error) {
      if (error.message?.includes('does not exist')) return;
      await writeLog('warn', 'skill-extractor', `query audit_log: ${error.message}`, {});
      return;
    }

    const userIds = Array.from(new Set((data ?? []).map((r) => r.user_id).filter(Boolean)));
    if (userIds.length === 0) return;

    let skillsCreated = 0;
    const traceId = 'skill-extractor';

    for (const userId of userIds) {
      try {
        const candidates = await Promise.all([
          extractPreferredReminderTime(userId, traceId),
          extractPreferredPharmacy(userId, traceId),
          extractMedicationTiming(userId, traceId),
          extractPreferredPlan(userId, traceId),
        ]);

        for (const c of candidates) {
          if (!c) continue;
          const created = await upsertSkill(c, traceId);
          if (created) skillsCreated++;
        }
      } catch (err) {
        await writeLog('warn', 'skill-extractor', `user ${userId}: ${String(err).slice(0, 120)}`, {});
      }
    }

    await writeLog('info', 'skill-extractor', `skill-extractor: ${userIds.length} user(s), ${skillsCreated} skill(s) novas`, {});
  } catch (err) {
    await writeLog('error', 'skill-extractor', `worker crashed: ${String(err).slice(0, 200)}`, {});
  }
}

let interval: NodeJS.Timeout | null = null;

export function startSkillExtractorWorker(): void {
  if (interval) return;
  setTimeout(() => {
    void runOnce();
    interval = setInterval(() => void runOnce(), POLL_INTERVAL_MS);
  }, 30 * 60 * 1000); // 1ª run após 30min
  void writeLog('info', 'skill-extractor', 'skill-extractor worker iniciado (1x/dia)', {});
}

export function stopSkillExtractorWorker(): void {
  if (interval) {
    clearInterval(interval);
    interval = null;
  }
}
