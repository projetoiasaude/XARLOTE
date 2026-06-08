/**
 * knowledge-graph-builder — popula `entity_relations` a partir das tabelas
 * estruturadas (user_medications, user_health_conditions, orders, consultations,
 * symptoms_log, treatments, user_allergies). Cada relação fica disponível
 * pra prompt context, retrieval e análise.
 *
 * Roda a cada 6h. Pra cada user com atividade recente (≥1 row criada nas
 * últimas 24h em qualquer tabela), reconstrói as relações principais.
 *
 * Idempotente: usa RPC `add_or_refresh_relation` que faz upsert por chave
 * (user, subject, relation, object).
 *
 * Falha silenciosa: se RPC não existe ou tabelas faltam, loga e continua.
 */
import { db, writeLog, writeAudit } from '@iasaude/db';
import { withCronLock } from '../middleware/cron-lock.js';

const POLL_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6h
const LOOKBACK_HOURS = 48; // janela de scan: rows criadas nas últimas 48h

async function refreshUserGraph(userId: string, traceId: string): Promise<number> {
  let relations = 0;

  // ─── user --takes--> medication (ativas) ───────────────────────────────
  try {
    const { data: meds } = await db
      .from('user_medications')
      .select('id, medication_name, treatment_id, active, source')
      .eq('user_id', userId)
      .eq('active', true);

    for (const m of meds ?? []) {
      const confidence = m.source === 'self_reported' ? 1.0 : m.source === 'enriched' ? 0.85 : 0.7;
      const { error } = await db.rpc('add_or_refresh_relation', {
        p_user_id: userId,
        p_subject_type: 'user',
        p_subject_id: userId,
        p_relation: 'takes',
        p_object_type: 'medication',
        p_object_id: m.id,
        p_confidence: confidence,
        p_metadata: { medication_name: m.medication_name, treatment_id: m.treatment_id } as never,
      });
      if (!error) relations++;
    }
  } catch (err) {
    if (!String(err).includes('does not exist')) {
      await writeLog('warn', 'kg-builder', `meds relations: ${String(err).slice(0, 120)}`, { traceId });
    }
  }

  // ─── user --has_condition--> condition ────────────────────────────────
  try {
    const { data: conds } = await db
      .from('user_health_conditions')
      .select('id, name, active, source')
      .eq('user_id', userId)
      .eq('active', true);

    for (const c of conds ?? []) {
      const confidence = c.source === 'self_reported' ? 1.0 : 0.75;
      await db.rpc('add_or_refresh_relation', {
        p_user_id: userId,
        p_subject_type: 'user',
        p_subject_id: userId,
        p_relation: 'has_condition',
        p_object_type: 'condition',
        p_object_id: c.id,
        p_confidence: confidence,
        p_metadata: { name: c.name } as never,
      });
      relations++;
    }
  } catch {}

  // ─── user --allergic_to--> allergy ────────────────────────────────────
  try {
    const { data: alls } = await db
      .from('user_allergies')
      .select('id, substance, severity, source')
      .eq('user_id', userId);

    for (const a of alls ?? []) {
      const confidence = a.source === 'self_reported' ? 1.0 : 0.7;
      await db.rpc('add_or_refresh_relation', {
        p_user_id: userId,
        p_subject_type: 'user',
        p_subject_id: userId,
        p_relation: 'allergic_to',
        p_object_type: 'allergy',
        p_object_id: a.id,
        p_confidence: confidence,
        p_metadata: { substance: a.substance, severity: a.severity } as never,
      });
      relations++;
    }
  } catch {}

  // ─── treatment --treats--> condition ──────────────────────────────────
  try {
    const { data: treatments } = await db
      .from('treatments')
      .select('id, name, condition_id, status')
      .eq('user_id', userId)
      .eq('status', 'active');

    for (const t of treatments ?? []) {
      if (!t.condition_id) continue;
      await db.rpc('add_or_refresh_relation', {
        p_user_id: userId,
        p_subject_type: 'treatment',
        p_subject_id: t.id,
        p_relation: 'treats',
        p_object_type: 'condition',
        p_object_id: t.condition_id,
        p_confidence: 0.9,
        p_metadata: { treatment_name: t.name } as never,
      });
      relations++;
    }
  } catch {}

  // ─── user --bought_at--> supplier (orders confirmados nos últimos 90d) ──
  try {
    const cutoff = new Date(Date.now() - 90 * 86400_000).toISOString();
    const { data: orders } = await db
      .from('orders')
      .select('id, selected_quote_id, status, created_at')
      .eq('user_id', userId)
      .in('status', ['confirming', 'handed_off', 'completed'])
      .gte('created_at', cutoff);

    for (const o of orders ?? []) {
      if (!o.selected_quote_id) continue;
      const { data: q } = await db
        .from('quotes')
        .select('supplier_id')
        .eq('id', o.selected_quote_id)
        .single();
      if (!q?.supplier_id) continue;

      await db.rpc('add_or_refresh_relation', {
        p_user_id: userId,
        p_subject_type: 'user',
        p_subject_id: userId,
        p_relation: 'bought_at',
        p_object_type: 'supplier',
        p_object_id: q.supplier_id,
        p_confidence: 1.0,
        p_metadata: { order_id: o.id, at: o.created_at } as never,
      });
      relations++;
    }
  } catch {}

  // ─── user --consulted_at--> clinic / --consulted_with--> prescriber ──
  try {
    const cutoff = new Date(Date.now() - 365 * 86400_000).toISOString();
    const { data: consultations } = await db
      .from('consultations')
      .select('id, scheduled_clinic_id, scheduled_prescriber_id, status, scheduled_at')
      .eq('user_id', userId)
      .in('status', ['scheduled', 'completed'])
      .gte('scheduled_at', cutoff);

    for (const c of consultations ?? []) {
      if (c.scheduled_clinic_id) {
        await db.rpc('add_or_refresh_relation', {
          p_user_id: userId,
          p_subject_type: 'user',
          p_subject_id: userId,
          p_relation: 'consulted_at',
          p_object_type: 'clinic',
          p_object_id: c.scheduled_clinic_id,
          p_confidence: 1.0,
          p_metadata: { consultation_id: c.id, at: c.scheduled_at } as never,
        });
        relations++;
      }
      if (c.scheduled_prescriber_id) {
        await db.rpc('add_or_refresh_relation', {
          p_user_id: userId,
          p_subject_type: 'user',
          p_subject_id: userId,
          p_relation: 'consulted_with',
          p_object_type: 'prescriber',
          p_object_id: c.scheduled_prescriber_id,
          p_confidence: 1.0,
          p_metadata: { consultation_id: c.id, at: c.scheduled_at } as never,
        });
        relations++;
      }
    }
  } catch {}

  // ─── user --reported--> symptom (últimos 30d, intensity≥4) ────────────
  try {
    const cutoff = new Date(Date.now() - 30 * 86400_000).toISOString();
    const { data: syms } = await db
      .from('symptoms_log')
      .select('id, name, intensity, red_flag_triggered')
      .eq('user_id', userId)
      .gte('created_at', cutoff)
      .gte('intensity', 4);

    for (const s of syms ?? []) {
      await db.rpc('add_or_refresh_relation', {
        p_user_id: userId,
        p_subject_type: 'user',
        p_subject_id: userId,
        p_relation: 'reported',
        p_object_type: 'symptom',
        p_object_id: s.id,
        p_confidence: 0.95,
        p_metadata: { name: s.name, intensity: s.intensity, red_flag: s.red_flag_triggered } as never,
      });
      relations++;
    }
  } catch {}

  return relations;
}

async function runOnce(): Promise<void> {
  try {
    const cutoff = new Date(Date.now() - LOOKBACK_HOURS * 3600 * 1000).toISOString();

    // Acha users com atividade recente em qualquer tabela
    const sets: Set<string> = new Set();

    for (const table of ['user_medications', 'user_health_conditions', 'orders', 'consultations', 'symptoms_log', 'treatments']) {
      try {
        const { data } = await db.from(table).select('user_id').gte('created_at', cutoff).limit(500);
        (data ?? []).forEach((r: any) => r.user_id && sets.add(r.user_id));
      } catch {}
    }

    if (sets.size === 0) return;

    let total = 0;
    for (const userId of sets) {
      try {
        const n = await refreshUserGraph(userId, 'kg-builder');
        total += n;
      } catch (err) {
        await writeLog('warn', 'kg-builder', `user ${userId}: ${String(err).slice(0, 120)}`, {});
      }
    }

    await writeLog('info', 'kg-builder', `kg-builder: ${sets.size} user(s), ${total} relação(ões) atualizada(s)`, {});

    if (total > 0) {
      await writeAudit({
        actorType: 'system',
        actorId: 'kg-builder',
        action: 'knowledge_graph.refreshed',
        metadata: { users: sets.size, relations: total },
      });
    }
  } catch (err) {
    await writeLog('error', 'kg-builder', `worker crashed: ${String(err).slice(0, 200)}`, {});
  }
}

let interval: NodeJS.Timeout | null = null;

export function startKnowledgeGraphBuilderWorker(): void {
  if (interval) return;
  setTimeout(() => {
    void withCronLock('knowledge-graph-builder', POLL_INTERVAL_MS, runOnce);
    interval = setInterval(() => void withCronLock('knowledge-graph-builder', POLL_INTERVAL_MS, runOnce), POLL_INTERVAL_MS);
  }, 20 * 60 * 1000); // 1ª run após 20min
  void writeLog('info', 'kg-builder', 'knowledge-graph-builder worker iniciado (cada 6h)', {});
}

export function stopKnowledgeGraphBuilderWorker(): void {
  if (interval) {
    clearInterval(interval);
    interval = null;
  }
}
