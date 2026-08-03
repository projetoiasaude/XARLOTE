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
import { estimateCostUsd } from '@iasaude/llm';
import { withCronLock } from '../middleware/cron-lock.js';

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

// F1.B4: custo de LLM na última hora acima do teto (LLM_COST_HOURLY_USD_LIMIT,
// default US$ 3). Usa o mesmo estimador com desconto de cache do dashboard.
async function detectCostBudget(): Promise<void> {
  try {
    const limit = Number(process.env['LLM_COST_HOURLY_USD_LIMIT'] ?? 3);
    const cutoff = new Date(Date.now() - 60 * 60_000).toISOString();
    const { data } = await db
      .from('event_log')
      .select('tokens_in, tokens_out, payload')
      .in('event_name', ['llm.completion', 'agent.completion', 'agent_clinic.completion'])
      .gte('occurred_at', cutoff)
      .limit(50000);
    let cost = 0;
    for (const e of data ?? []) {
      const row = e as { tokens_in?: number; tokens_out?: number; payload?: Record<string, unknown> | null };
      cost += estimateCostUsd(
        String(row.payload?.['model'] ?? ''),
        Number(row.tokens_in ?? 0),
        Number(row.payload?.['cached_tokens'] ?? 0),
        Number(row.tokens_out ?? 0),
      );
    }
    if (cost > limit) {
      await sendTelegramAlert({
        title: 'Custo de LLM acima do teto',
        body: `~US$ ${cost.toFixed(2)} na última hora (teto US$ ${limit.toFixed(2)}). Checar volume/abuso.`,
        severity: 'high',
        throttleKey: 'llm_cost_budget',
      });
      await writeEvent({
        eventName: 'anomaly.llm_cost_over_budget',
        severity: 'warn',
        payload: { cost_usd: parseFloat(cost.toFixed(4)), limit_usd: limit, window_min: 60 },
      });
    }
  } catch {}
}

// F1.B4: spike de falhas de ENVIO WhatsApp nos últimos 10min — possível ban/
// rate-limit da uazapi (canal fora do nosso controle; um ban derruba o produto).
async function detectSendFailureSpike(): Promise<void> {
  try {
    const cutoff = new Date(Date.now() - 10 * 60_000).toISOString();
    const { count } = await db
      .from('system_logs')
      .select('id', { count: 'exact', head: true })
      .eq('category', 'outbound')
      .eq('level', 'error')
      .gte('created_at', cutoff);
    const n = count ?? 0;
    if (n >= 5) {
      await sendTelegramAlert({
        title: 'Falhas de envio WhatsApp (possível ban/limite)',
        body: `${n} erros de envio (outbound) nos últimos 10min. Pode ser ban/rate-limit da uazapi — checar a instância.`,
        severity: 'high',
        throttleKey: 'wa_send_failure_spike',
      });
      await writeEvent({
        eventName: 'anomaly.wa_send_failure_spike',
        severity: 'warn',
        payload: { count: n, window_min: 10 },
      });
    }
  } catch {}
}

/**
 * Detecta CONTEÚDO quebrado saindo pro usuário — os incidentes reais desta semana
 * foram de QUALIDADE de resposta (a msg literal "undefined" do caso Glauber), não
 * de infra, e nenhum detector olhava o texto. Pega interpolação quebrada no minuto,
 * não no print do usuário.
 */
async function detectBrokenOutboundContent(): Promise<void> {
  try {
    const cutoff = new Date(Date.now() - 10 * 60_000).toISOString();
    const { data, count } = await db
      .from('messages')
      .select('id, conversation_id, content', { count: 'exact' })
      .eq('direction', 'out')
      .gte('created_at', cutoff)
      // Só padrões DISTINTIVOS (ilike é substring: "%NaN%" casaria "Renan"/"banana",
      // "%null%" casaria "anular" — falso-positivo). "undefined" e "[object Object]"
      // não aparecem em texto PT-BR legítimo.
      .or('content.ilike.%undefined%,content.ilike.%[object Object]%')
      .limit(5);
    const n = count ?? 0;
    if (n > 0) {
      const sample = (data ?? [])[0]?.content?.slice(0, 120) ?? '';
      await sendTelegramAlert({
        title: '🐛 Mensagem QUEBRADA enviada a usuário',
        body: `${n} mensagem(ns) com "undefined"/"[object Object]"/"NaN"/"null" nos últimos 10min. Ex: "${sample}". Interpolação/tool quebrada — investigar já.`,
        severity: 'critical',
        throttleKey: 'broken_outbound_content',
      });
      await writeEvent({
        eventName: 'anomaly.broken_outbound_content',
        severity: 'critical',
        payload: { count: n, sample },
      });
    }
  } catch {}
}

/**
 * 💊 LEMBRETE CRÍTICO NÃO ENTREGUE (auditoria 26/07 — casos Arthur e Antônia).
 *
 * O evento `reminder.wa_window_closed` existia desde 13/07 e NUNCA teve consumidor: 50
 * lembretes morreram em 3 dias — incluindo 100% do anti-hipertensivo do Arthur (Neblock
 * 5mg) — sem UM alerta. O paciente some, a janela de 24h fecha, o template entra em
 * cooldown e o remédio simplesmente evapora, em silêncio, para sempre.
 *
 * Alerta só o que exige AÇÃO HUMANA: medicação/consulta (payload.critical) que não está
 * em re-tentativa. Água/exercício bloqueado é ruído — não acorda ninguém às 3h.
 */
/**
 * Cooldown PRÓPRIO deste alerta. O throttle do telegram-alerter é de 60s — inútil pra um
 * detector que roda a cada 10min. Sem isto, um paciente mudo com 3 remédios/dia geraria
 * alerta a cada disparo bloqueado e o canal viraria ruído.
 */
let lastUndeliveredAlertMs = 0;
const UNDELIVERED_ALERT_COOLDOWN_MS = 3 * 60 * 60_000;

async function detectUndeliveredCriticalReminders(): Promise<void> {
  try {
    if (Date.now() - lastUndeliveredAlertMs < UNDELIVERED_ALERT_COOLDOWN_MS) return;
    // Janela = o próprio intervalo do detector (10min). Com janela de 60min o mesmo evento
    // era recontado 6× e gerava 6 alertas idênticos — e `severity:'critical'` PULA o throttle
    // do telegram-alerter, então o throttleKey não segurava nada. Um paciente mudo com 3
    // remédios/dia geraria ~18 alertas/dia e o canal viraria ruído (aí ninguém vê o que importa).
    const cutoff = new Date(Date.now() - 10 * 60_000).toISOString();
    const { data, count } = await db
      .from('event_log')
      .select('user_id, payload', { count: 'exact' })
      .eq('event_name', 'reminder.wa_window_closed')
      .eq('payload->>critical', 'true')
      // `neq` DESCARTA linha com chave ausente (NULL não é ≠ 'true' em SQL) — o `or` com
      // `is.null` cobre eventos gravados antes deste campo existir.
      .or('payload->>retrying.is.null,payload->>retrying.neq.true')
      .gte('occurred_at', cutoff)
      .limit(200);
    const n = count ?? 0;
    if (n > 0) {
      const sample = data ?? [];
      const affected = new Set(sample.map((r) => String(r.user_id))).size;
      const maxSilent = Math.max(
        0,
        ...sample.map((r) => Number((r.payload as Record<string, unknown> | null)?.['silent_days']) || 0),
      );
      // `count` é o TOTAL (PostgREST ignora o limit na contagem); `sample` é o que veio.
      const affectedLabel = n > sample.length ? `${affected}+` : String(affected);
      await sendTelegramAlert({
        title: '💊 Remédio/consulta NÃO entregue (janela fechada)',
        body: `${n} lembrete(s) CRÍTICO(s) de ${affectedLabel} paciente(s) não chegaram nos últimos 10min — janela de 24h fechada e template em cooldown. Silêncio máximo: ${maxSilent}d. Esses pacientes estão sem lembrete de medicação; pode exigir contato humano.`,
        // 'high' (não 'critical') DE PROPÓSITO: é o que ativa o throttle por chave no
        // telegram-alerter. Um alerta que floda é um alerta que ninguém lê.
        severity: 'high',
        throttleKey: 'undelivered_critical_reminders',
      });
      lastUndeliveredAlertMs = Date.now();
      await writeEvent({
        eventName: 'anomaly.undelivered_critical_reminders',
        severity: 'critical',
        payload: { count: n, users_affected: affected, max_silent_days: maxSilent },
      });
    }
  } catch {}
}

/**
 * 🔴 Aviso ÚNICO que o paciente nunca recebeu, em definitivo (consulta, exame, quimio).
 *
 * O `error` que o reminder-dispatcher emite nesse caso é o desfecho mais grave daquele
 * worker — e não tinha consumidor nenhum: `detectSendFailureSpike` só conta
 * `category='outbound'`, então esse erro gritava no vazio desde sempre. Diferente do
 * bloqueio de janela (que ainda pode ser reaberto e re-tentado), aqui as 8 tentativas
 * acabaram: só um humano recupera.
 */
async function detectAbandonedOneShots(): Promise<void> {
  try {
    const cutoff = new Date(Date.now() - 10 * 60_000).toISOString();
    const { data, count } = await db
      .from('event_log')
      .select('user_id, payload', { count: 'exact' })
      .eq('event_name', 'reminder.one_shot_abandoned')
      .gte('occurred_at', cutoff)
      .limit(50);
    const n = count ?? 0;
    if (!n) return;
    const titulos = (data ?? [])
      .map((r) => String((r.payload as Record<string, unknown> | null)?.['title'] ?? '?'))
      .slice(0, 3).join(', ');
    const affected = new Set((data ?? []).map((r) => String(r.user_id))).size;
    await sendTelegramAlert({
      title: '🔴 Aviso único PERDIDO em definitivo',
      body: `${n} lembrete(s) de dose única desistiram após todas as tentativas e o paciente NUNCA recebeu (${affected} paciente(s)): ${titulos}. Não há re-tentativa — isso exige contato humano.`,
      severity: 'high',
      throttleKey: 'abandoned_one_shots',
    });
  } catch {}
}

async function runOnce(): Promise<void> {
  try {
    await Promise.all([
      detectUntreatedRedFlags(),
      detectToolFailureSpike(),
      detectUndeliveredCriticalReminders(),
      detectAbandonedOneShots(),
      detectLLMLatencyDegradation(),
      detectStuckConversations(),
      detectOrderFailureRate(),
      detectCostBudget(),
      detectSendFailureSpike(),
      detectBrokenOutboundContent(),
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
    void withCronLock('anomaly-detector', POLL_INTERVAL_MS, runOnce);
    interval = setInterval(() => void withCronLock('anomaly-detector', POLL_INTERVAL_MS, runOnce), POLL_INTERVAL_MS);
  }, 3 * 60 * 1000);
  void writeLog('info', 'anomaly', 'anomaly-detector worker iniciado (cada 10min)', {});
}

export function stopAnomalyDetectorWorker(): void {
  if (interval) {
    clearInterval(interval);
    interval = null;
  }
}
