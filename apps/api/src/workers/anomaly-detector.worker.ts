/**
 * anomaly-detector — scaneia event_log + audit_log e detecta padrões anormais
 * que merecem intervenção do fundador. Foco: produção saudável.
 *
 * Detectores V1:
 *   1. Red flag não tratado: red_flag.detected nas últimas 1h sem follow-up
 *      (mensagens outbound depois) — paciente ficou sem resposta.
 *   2. Tool failure spike: > 10 tool.failed nos últimos 10 min.
 *   3. LLM latency degradation: p95 dos últimos 30 min > 30 s.
 *   4. Conversation stuck: conversa user com última mensagem inbound há > 2h
 *      sem resposta outbound da Xarlote (provável que ficou pendurado).
 *   5. Order failed rate spike: > 30% de orders 'failed' nas últimas 24h.
 *
 * Cada detecção dispara Telegram alert (com throttle). Roda a cada 10min.
 */
import { db, writeLog, writeEvent } from '@iasaude/db';
import { sendTelegramAlert } from '../handlers/telegram-alerter.js';

const POLL_INTERVAL_MS = 10 * 60 * 1000; // 10 min

// ─── Detectores ────────────────────────────────────────────────────────────

async function detectUntreatedRedFlags(): Promise<void> {
  const cutoff = new Date(Date.now() - 1 * 3600_000).toISOString();
  try {
    const { data: flags } = await db
      .from('audit_log')
      .select('id, user_id, conversation_id, occurred_at, metadata, reason')
      .eq('action', 'red_flag.detected')
      .gte('occurred_at', cutoff)
      .limit(20);

    for (const f of flags ?? []) {
      // Verifica se houve outbound message de Xarlote DEPOIS desse flag
      const { data: msgs } = await db
        .from('messages')
        .select('id, direction, sender_role, created_at')
        .eq('conversation_id', f.conversation_id ?? '')
        .gt('created_at', f.occurred_at)
        .eq('direction', 'out')
        .limit(1);

      if ((msgs ?? []).length === 0) {
        // Sem resposta!
        const ageMin = Math.floor((Date.now() - new Date(f.occurred_at).getTime()) / 60_000);
        await sendTelegramAlert({
          title: 'Red flag SEM follow-up',
          body: `Red flag detectado há ${ageMin}min sem resposta outbound.\nUser: ${(f.user_id ?? 'anon').slice(0, 8)}\nMotivo: ${f.reason ?? 'sem motivo'}\nConv: ${f.conversation_id}`,
          severity: 'critical',
          throttleKey: `untreated_red_flag:${f.id}`,
        });
      }
    }
  } catch (err) {
    if (!String(err).includes('does not exist')) {
      await writeLog('warn', 'anomaly', `detect red flags: ${String(err).slice(0, 120)}`, {});
    }
  }
}

async function detectToolFailureSpike(): Promise<void> {
  try {
    const cutoff = new Date(Date.now() - 10 * 60_000).toISOString();
    const { count } = await db
      .from('audit_log')
      .select('id', { count: 'exact', head: true })
      .eq('action', 'tool.failed')
      .gte('occurred_at', cutoff);

    const n = count ?? 0;
    if (n >= 10) {
      await sendTelegramAlert({
        title: 'Tool failure spike',
        body: `${n} tool.failed nos últimos 10 min. Investigar.`,
        severity: 'high',
        throttleKey: 'tool_failure_spike',
      });
      await writeEvent({
        eventName: 'anomaly.tool_failure_spike',
        severity: 'warn',
        payload: { count: n, window_min: 10 },
      });
    }
  } catch {}
}

async function detectLLMLatencyDegradation(): Promise<void> {
  try {
    const cutoff = new Date(Date.now() - 30 * 60_000).toISOString();
    const { data } = await db
      .from('event_log')
      .select('duration_ms')
      .in('event_name', ['llm.completion', 'agent.completion', 'agent_clinic.completion'])
      .gte('occurred_at', cutoff)
      .not('duration_ms', 'is', null)
      .limit(500);

    const durations = (data ?? []).map((r) => r.duration_ms as number).filter((n) => n > 0).sort((a, b) => a - b);
    if (durations.length < 10) return;

    const p95Idx = Math.floor(durations.length * 0.95);
    const p95 = durations[p95Idx]!;

    if (p95 > 30_000) {
      await sendTelegramAlert({
        title: 'LLM p95 alto',
        body: `Últimos 30min: p95=${(p95 / 1000).toFixed(1)}s sobre ${durations.length} chamadas. (Esperado <10s)`,
        severity: 'high',
        throttleKey: 'llm_latency_spike',
      });
    }
  } catch {}
}

async function detectStuckConversations(): Promise<void> {
  try {
    const cutoff = new Date(Date.now() - 2 * 3600_000).toISOString();
    // Conversas user com última inbound > 2h sem outbound subsequente
    const { data: convs } = await db
      .from('conversations')
      .select('id, user_id, last_message_at')
      .eq('party_type', 'user')
      .lt('last_message_at', cutoff)
      .gte('last_message_at', new Date(Date.now() - 24 * 3600_000).toISOString())
      .limit(50);

    let stuck = 0;
    for (const c of convs ?? []) {
      const { data: lastMsg } = await db
        .from('messages')
        .select('direction, created_at')
        .eq('conversation_id', c.id)
        .order('created_at', { ascending: false })
        .limit(1)
        .single();

      if (lastMsg && lastMsg.direction === 'in') {
        stuck++;
      }
    }

    if (stuck >= 5) {
      await sendTelegramAlert({
        title: 'Conversas paradas',
        body: `${stuck} conversas user com última inbound há >2h sem resposta da Xarlote.`,
        severity: 'warn',
        throttleKey: 'stuck_conversations',
      });
    }
  } catch {}
}

async function detectOrderFailureRate(): Promise<void> {
  try {
    const cutoff = new Date(Date.now() - 24 * 3600_000).toISOString();
    const { data: orders } = await db
      .from('orders')
      .select('status')
      .gte('created_at', cutoff)
      .limit(500);

    const total = (orders ?? []).length;
    if (total < 5) return; // amostra insuficiente

    const failed = (orders ?? []).filter((o) => o.status === 'failed').length;
    const rate = failed / total;

    if (rate > 0.3) {
      await sendTelegramAlert({
        title: 'Order failure rate alto',
        body: `Nas últimas 24h: ${failed}/${total} (${(rate * 100).toFixed(0)}%) orders failed. Esperado <10%.`,
        severity: 'high',
        throttleKey: 'order_failure_rate',
      });
    }
  } catch {}
}

async function runOnce(): Promise<void> {
  try {
    await Promise.all([
      detectUntreatedRedFlags(),
      detectToolFailureSpike(),
      detectLLMLatencyDegradation(),
      detectStuckConversations(),
      detectOrderFailureRate(),
    ]);
  } catch (err) {
    await writeLog('error', 'anomaly', `worker crashed: ${String(err).slice(0, 200)}`, {});
  }
}

let interval: NodeJS.Timeout | null = null;

export function startAnomalyDetectorWorker(): void {
  if (interval) return;
  // 1ª run após 3min do boot
  setTimeout(() => {
    void runOnce();
    interval = setInterval(() => void runOnce(), POLL_INTERVAL_MS);
  }, 3 * 60 * 1000);
  void writeLog('info', 'anomaly', 'anomaly-detector worker iniciado (cada 10min)', {});
}

export function stopAnomalyDetectorWorker(): void {
  if (interval) {
    clearInterval(interval);
    interval = null;
  }
}
