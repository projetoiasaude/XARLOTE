/**
 * metrics-aggregator — agrega event_log + audit_log + orders + consultations
 * em uma row por dia em `daily_metrics`. Usado pelo dashboard /metrics.
 *
 * Estratégia:
 *   - Roda a cada 1h
 *   - Computa métricas dos últimos 2 dias (today + ontem) — upsert por day
 *   - Idempotente: re-executa não duplica, só atualiza
 *
 * Métricas:
 *   - Volume (turns, users ativos, msgs in/out)
 *   - LLM (count, p50/p95/p99, tokens, custo)
 *   - Tools (count, failures, breakdown por tool)
 *   - Orders (criados, confirmados, failed, qtd média de quotes)
 *   - Consultations (iniciadas, agendadas, completadas)
 *   - Red flags (count + breakdown por categoria)
 *   - TTS/STT
 */
import { db, writeLog } from '@iasaude/db';

const POLL_INTERVAL_MS = 60 * 60 * 1000; // 1h

interface DailyMetrics {
  day: string;
  total_turns: number;
  total_users_active: number;
  total_messages_in: number;
  total_messages_out: number;
  llm_calls: number;
  llm_p50_ms: number | null;
  llm_p95_ms: number | null;
  llm_p99_ms: number | null;
  llm_total_tokens: number;
  llm_total_cost_usd: number;
  tool_calls: number;
  tool_failures: number;
  tool_counts: Record<string, number>;
  orders_created: number;
  orders_confirmed: number;
  orders_failed: number;
  avg_quotes_per_order: number | null;
  consultations_started: number;
  consultations_scheduled: number;
  consultations_completed: number;
  red_flags_detected: number;
  red_flags_by_category: Record<string, number>;
  tts_synthesized: number;
  tts_avg_ms: number | null;
  stt_transcribed: number;
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[idx] ?? null;
}

async function computeDay(day: string): Promise<DailyMetrics> {
  const startISO = `${day}T00:00:00Z`;
  const endISO = `${day}T23:59:59Z`;

  const metrics: DailyMetrics = {
    day,
    total_turns: 0,
    total_users_active: 0,
    total_messages_in: 0,
    total_messages_out: 0,
    llm_calls: 0,
    llm_p50_ms: null,
    llm_p95_ms: null,
    llm_p99_ms: null,
    llm_total_tokens: 0,
    llm_total_cost_usd: 0,
    tool_calls: 0,
    tool_failures: 0,
    tool_counts: {},
    orders_created: 0,
    orders_confirmed: 0,
    orders_failed: 0,
    avg_quotes_per_order: null,
    consultations_started: 0,
    consultations_scheduled: 0,
    consultations_completed: 0,
    red_flags_detected: 0,
    red_flags_by_category: {},
    tts_synthesized: 0,
    tts_avg_ms: null,
    stt_transcribed: 0,
  };

  // Messages
  try {
    const { data: msgs } = await db
      .from('messages')
      .select('direction, sender_role, conversation_id')
      .gte('created_at', startISO)
      .lte('created_at', endISO)
      .limit(50000);

    const inbound = (msgs ?? []).filter((m) => m.direction === 'in');
    const outbound = (msgs ?? []).filter((m) => m.direction === 'out');
    metrics.total_messages_in = inbound.length;
    metrics.total_messages_out = outbound.length;

    // Turns ≈ inbound user msgs
    const userIn = inbound.filter((m) => m.sender_role === 'user');
    metrics.total_turns = userIn.length;

    // Users ativos: distinct convs com inbound
    const convs = new Set(userIn.map((m) => m.conversation_id));
    metrics.total_users_active = convs.size;
  } catch {}

  // LLM completion events
  try {
    const { data: llmEvents } = await db
      .from('event_log')
      .select('duration_ms, payload')
      .in('event_name', ['llm.completion', 'agent.completion', 'agent_clinic.completion'])
      .gte('occurred_at', startISO)
      .lte('occurred_at', endISO)
      .limit(50000);

    const durations = (llmEvents ?? [])
      .map((e) => e.duration_ms as number)
      .filter((n) => typeof n === 'number' && n > 0)
      .sort((a, b) => a - b);

    metrics.llm_calls = (llmEvents ?? []).length;
    metrics.llm_p50_ms = percentile(durations, 0.5);
    metrics.llm_p95_ms = percentile(durations, 0.95);
    metrics.llm_p99_ms = percentile(durations, 0.99);

    let tokens = 0;
    let cost = 0;
    for (const e of llmEvents ?? []) {
      const p = e.payload as Record<string, unknown> | null;
      if (p) {
        tokens += Number(p['total_tokens'] ?? 0);
        cost += Number(p['cost_usd'] ?? 0);
      }
    }
    metrics.llm_total_tokens = tokens;
    metrics.llm_total_cost_usd = parseFloat(cost.toFixed(4));
  } catch {}

  // Tool calls
  try {
    const { data: tools } = await db
      .from('audit_log')
      .select('action, metadata')
      .in('action', ['tool.success', 'tool.failed'])
      .gte('occurred_at', startISO)
      .lte('occurred_at', endISO)
      .limit(50000);

    metrics.tool_calls = (tools ?? []).length;
    metrics.tool_failures = (tools ?? []).filter((t) => t.action === 'tool.failed').length;

    const counts: Record<string, number> = {};
    for (const t of tools ?? []) {
      const md = t.metadata as Record<string, unknown> | null;
      const name = md?.['tool_name'] as string | undefined;
      if (name) counts[name] = (counts[name] ?? 0) + 1;
    }
    metrics.tool_counts = counts;
  } catch {}

  // Orders
  try {
    const { data: orders } = await db
      .from('orders')
      .select('id, status, selected_quote_id')
      .gte('created_at', startISO)
      .lte('created_at', endISO);

    metrics.orders_created = (orders ?? []).length;
    metrics.orders_confirmed = (orders ?? []).filter((o) => ['confirming', 'handed_off', 'completed'].includes(o.status)).length;
    metrics.orders_failed = (orders ?? []).filter((o) => o.status === 'failed').length;

    if (metrics.orders_created > 0) {
      const orderIds = (orders ?? []).map((o) => o.id);
      const { count: totalQuotes } = await db
        .from('quotes')
        .select('id', { count: 'exact', head: true })
        .in('order_id', orderIds);
      metrics.avg_quotes_per_order = parseFloat(((totalQuotes ?? 0) / metrics.orders_created).toFixed(2));
    }
  } catch {}

  // Consultations
  try {
    const { data: cons } = await db
      .from('consultations')
      .select('status, created_at, completed_at, scheduled_at')
      .gte('created_at', startISO)
      .lte('created_at', endISO);

    metrics.consultations_started = (cons ?? []).length;
    metrics.consultations_scheduled = (cons ?? []).filter((c) => ['scheduled', 'completed'].includes(c.status)).length;
    metrics.consultations_completed = (cons ?? []).filter((c) => c.status === 'completed').length;
  } catch {}

  // Red flags
  try {
    const { data: flags } = await db
      .from('audit_log')
      .select('metadata')
      .eq('action', 'red_flag.detected')
      .gte('occurred_at', startISO)
      .lte('occurred_at', endISO);

    metrics.red_flags_detected = (flags ?? []).length;
    const byCat: Record<string, number> = {};
    for (const f of flags ?? []) {
      const md = f.metadata as Record<string, unknown> | null;
      const cat = (md?.['category'] as string) ?? 'unknown';
      byCat[cat] = (byCat[cat] ?? 0) + 1;
    }
    metrics.red_flags_by_category = byCat;
  } catch {}

  // TTS / STT
  try {
    const { data: tts } = await db
      .from('event_log')
      .select('duration_ms')
      .eq('event_name', 'tts.synthesized')
      .gte('occurred_at', startISO)
      .lte('occurred_at', endISO);
    metrics.tts_synthesized = (tts ?? []).length;
    const ttsDurations = (tts ?? []).map((t) => t.duration_ms as number).filter((n) => n > 0);
    metrics.tts_avg_ms = ttsDurations.length > 0
      ? Math.round(ttsDurations.reduce((a, b) => a + b, 0) / ttsDurations.length)
      : null;

    const { count: sttCount } = await db
      .from('event_log')
      .select('id', { count: 'exact', head: true })
      .in('event_name', ['stt.transcribed', 'audio.transcribed'])
      .gte('occurred_at', startISO)
      .lte('occurred_at', endISO);
    metrics.stt_transcribed = sttCount ?? 0;
  } catch {}

  return metrics;
}

async function upsertMetrics(m: DailyMetrics): Promise<void> {
  try {
    await db.from('daily_metrics').upsert({
      day: m.day,
      total_turns: m.total_turns,
      total_users_active: m.total_users_active,
      total_messages_in: m.total_messages_in,
      total_messages_out: m.total_messages_out,
      llm_calls: m.llm_calls,
      llm_p50_ms: m.llm_p50_ms,
      llm_p95_ms: m.llm_p95_ms,
      llm_p99_ms: m.llm_p99_ms,
      llm_total_tokens: m.llm_total_tokens,
      llm_total_cost_usd: m.llm_total_cost_usd,
      tool_calls: m.tool_calls,
      tool_failures: m.tool_failures,
      tool_counts: m.tool_counts as never,
      orders_created: m.orders_created,
      orders_confirmed: m.orders_confirmed,
      orders_failed: m.orders_failed,
      avg_quotes_per_order: m.avg_quotes_per_order,
      consultations_started: m.consultations_started,
      consultations_scheduled: m.consultations_scheduled,
      consultations_completed: m.consultations_completed,
      red_flags_detected: m.red_flags_detected,
      red_flags_by_category: m.red_flags_by_category as never,
      tts_synthesized: m.tts_synthesized,
      tts_avg_ms: m.tts_avg_ms,
      stt_transcribed: m.stt_transcribed,
      computed_at: new Date().toISOString(),
    }, { onConflict: 'day' });
  } catch (err) {
    if (!String(err).includes('does not exist')) {
      await writeLog('warn', 'metrics', `upsert falhou: ${String(err).slice(0, 200)}`, {});
    }
  }
}

async function runOnce(): Promise<void> {
  try {
    const todayDate = new Date();
    const today = todayDate.toISOString().slice(0, 10);
    const yesterday = new Date(todayDate.getTime() - 86400_000).toISOString().slice(0, 10);

    for (const day of [yesterday, today]) {
      const m = await computeDay(day);
      await upsertMetrics(m);
    }

    await writeLog('info', 'metrics', 'metrics-aggregator: dia hoje + ontem agregado', {});
  } catch (err) {
    await writeLog('error', 'metrics', `worker crashed: ${String(err).slice(0, 200)}`, {});
  }
}

let interval: NodeJS.Timeout | null = null;

export function startMetricsAggregatorWorker(): void {
  if (interval) return;
  setTimeout(() => {
    void runOnce();
    interval = setInterval(() => void runOnce(), POLL_INTERVAL_MS);
  }, 5 * 60 * 1000); // 1ª run após 5min
  void writeLog('info', 'metrics', 'metrics-aggregator worker iniciado (cada 1h)', {});
}

export function stopMetricsAggregatorWorker(): void {
  if (interval) {
    clearInterval(interval);
    interval = null;
  }
}
