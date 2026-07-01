/**
 * Helpers de auditoria — escrevem em `audit_log` e `event_log` via RPCs SQL.
 *
 * Use `writeAudit()` pra MUDANÇAS DE ESTADO (criar/atualizar/deletar algo).
 * Use `writeEvent()` pra OBSERVABILIDADE (latência, decisões, sinais).
 *
 * Ambos:
 *   - Nunca lançam erro (audit nunca pode quebrar o fluxo principal)
 *   - São fire-and-forget: chamada sem await é OK
 *   - Vão pro `event_log` como fallback se a RPC falhar (degradação graciosa)
 *
 * Princípio: SE FALHARMOS EM AUDITAR, AUDITAMOS QUE FALHAMOS.
 */
import { db } from './client.js';
import { redactPII } from './redact.js';

// ─────────────────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────────────────

export type AuditActorType =
  | 'xarlote'
  | 'agent_pharmacy'
  | 'agent_clinic'
  | 'system'
  | 'admin'
  | 'user'
  | 'webhook';

export type EventSeverity = 'debug' | 'info' | 'warn' | 'error' | 'critical';

export interface AuditInput {
  /** Quem realizou a ação */
  actorType: AuditActorType;
  /** Identificador opcional do ator (worker name, admin email, etc) */
  actorId?: string | null;
  /** Ação em dot-notation: dominio.evento.modificador */
  action: string;
  /** Paciente afetado — sempre populado quando aplicável */
  userId?: string | null;
  /** Tabela afetada (snake_case) */
  targetTable?: string | null;
  /** ID da row afetada */
  targetId?: string | null;
  /** Snapshot ANTES (só campos relevantes) */
  before?: Record<string, unknown> | null;
  /** Snapshot DEPOIS */
  after?: Record<string, unknown> | null;
  /** Conversa relacionada (rastreio cross-feature) */
  conversationId?: string | null;
  /** Mensagem que originou (quando aplicável) */
  messageId?: string | null;
  /** Trace ID do turno (mesma da writeLog) */
  traceId?: string | null;
  /** Task ID (assistant_tasks) */
  taskId?: string | null;
  /** Razão humana — útil pra debug */
  reason?: string | null;
  /** Metadados extras — args da tool, response code, etc */
  metadata?: Record<string, unknown> | null;
}

export interface EventInput {
  eventName: string;
  severity?: EventSeverity;
  userId?: string | null;
  conversationId?: string | null;
  traceId?: string | null;
  durationMs?: number | null;
  tokensIn?: number | null;
  tokensOut?: number | null;
  costBrl?: number | null;
  payload?: Record<string, unknown> | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// CORE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Grava uma entrada em `audit_log`. Fire-and-forget — não lança erro.
 *
 * Exemplo:
 *   await writeAudit({
 *     actorType: 'xarlote',
 *     action: 'user.onboarding.advanced',
 *     userId: user.id,
 *     before: { onboarding_status: 'profiling' },
 *     after: { onboarding_status: 'active' },
 *     traceId, conversationId,
 *   });
 */
export async function writeAudit(input: AuditInput): Promise<void> {
  // LGPD (CLAUDE.md #3): audit_log é append-only e o único caminho que preserva args
  // de tool → redige PII (telefone/CPF/endereço/lat-lng/valores clínicos) NA ESCRITA,
  // igual writeLog. Cobre TODOS os callers (incl. auditToolCall com args crus).
  const before = input.before ? redactPII(input.before) : null;
  const after = input.after ? redactPII(input.after) : null;
  const metadata = input.metadata ? redactPII(input.metadata) : null;
  try {
    const { error } = await db.rpc('write_audit', {
      p_actor_type: input.actorType,
      p_actor_id: input.actorId ?? null,
      p_action: input.action,
      p_user_id: input.userId ?? null,
      p_target_table: input.targetTable ?? null,
      p_target_id: input.targetId ?? null,
      p_before: (before ?? null) as never,
      p_after: (after ?? null) as never,
      p_conversation_id: input.conversationId ?? null,
      p_message_id: input.messageId ?? null,
      p_trace_id: input.traceId ?? null,
      p_task_id: input.taskId ?? null,
      p_reason: input.reason ?? null,
      p_metadata: (metadata ?? null) as never,
    });
    if (error) {
      // Fallback: tenta inserir DIRETO se a RPC não existir ainda
      // (durante deploys ou migrations pendentes)
      await db.from('audit_log').insert({
        actor_type: input.actorType,
        actor_id: input.actorId ?? null,
        action: input.action,
        user_id: input.userId ?? null,
        target_table: input.targetTable ?? null,
        target_id: input.targetId ?? null,
        before,
        after,
        conversation_id: input.conversationId ?? null,
        message_id: input.messageId ?? null,
        trace_id: input.traceId ?? null,
        task_id: input.taskId ?? null,
        reason: input.reason ?? null,
        metadata,
      }).then(() => undefined);
    }
  } catch (err) {
    // Auditar uma falha de auditoria — usa event_log direto (não-recursivo)
    try {
      await db.from('event_log').insert({
        event_name: 'audit.write_failed',
        severity: 'error',
        user_id: input.userId ?? null,
        trace_id: input.traceId ?? null,
        payload: { intended_action: input.action, error: String(err).slice(0, 240) },
      });
    } catch { /* ignore */ }
  }
}

/**
 * Grava um evento em `event_log`. Fire-and-forget.
 *
 * Exemplo:
 *   await writeEvent({
 *     eventName: 'llm.completion',
 *     userId, traceId,
 *     durationMs: 1200, tokensIn: 850, tokensOut: 42,
 *     costBrl: 0.0021,
 *     payload: { model: 'openai/gpt-4.1-mini', tool_calls: 1 },
 *   });
 */
export async function writeEvent(input: EventInput): Promise<void> {
  const payload = input.payload ? redactPII(input.payload) : {}; // LGPD: sem PII em event_log
  try {
    const { error } = await db.rpc('write_event', {
      p_event_name: input.eventName,
      p_severity: input.severity ?? 'info',
      p_user_id: input.userId ?? null,
      p_conversation_id: input.conversationId ?? null,
      p_trace_id: input.traceId ?? null,
      p_duration_ms: input.durationMs ?? null,
      p_tokens_in: input.tokensIn ?? null,
      p_tokens_out: input.tokensOut ?? null,
      p_cost_brl: input.costBrl ?? null,
      p_payload: payload as never,
    });
    if (error) {
      await db.from('event_log').insert({
        event_name: input.eventName,
        severity: input.severity ?? 'info',
        user_id: input.userId ?? null,
        conversation_id: input.conversationId ?? null,
        trace_id: input.traceId ?? null,
        duration_ms: input.durationMs ?? null,
        tokens_in: input.tokensIn ?? null,
        tokens_out: input.tokensOut ?? null,
        cost_brl: input.costBrl ?? null,
        payload,
      }).then(() => undefined);
    }
  } catch {
    // Silent — observabilidade nunca derruba fluxo
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// HIGH-LEVEL HELPERS — wrappers comuns que escrevem nas convenções
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Atalho pra audit de chamada de tool da Xarlote.
 * Loga tanto invocation quanto resultado.
 */
export async function auditToolCall(params: {
  toolName: string;
  userId: string;
  conversationId?: string | null;
  traceId: string;
  args: Record<string, unknown>;
  result: 'success' | 'failure';
  error?: string;
  durationMs?: number;
}): Promise<void> {
  await Promise.all([
    writeAudit({
      actorType: 'xarlote',
      action: params.result === 'success' ? 'tool.invoked' : 'tool.failed',
      userId: params.userId,
      conversationId: params.conversationId,
      traceId: params.traceId,
      metadata: {
        tool_name: params.toolName,
        args: params.args,
        ...(params.error ? { error: params.error } : {}),
      },
    }),
    writeEvent({
      eventName: `tool.${params.toolName}`,
      severity: params.result === 'success' ? 'info' : 'error',
      userId: params.userId,
      conversationId: params.conversationId,
      traceId: params.traceId,
      durationMs: params.durationMs,
      payload: { args: params.args, result: params.result, error: params.error },
    }),
  ]);
}

/**
 * Atalho pra audit de mudança de estado em users (onboarding, metadata, etc).
 */
export async function auditUserStateChange(params: {
  userId: string;
  action: string;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  actorType?: AuditActorType;
  actorId?: string;
  reason?: string;
  traceId?: string;
  conversationId?: string;
}): Promise<void> {
  await writeAudit({
    actorType: params.actorType ?? 'xarlote',
    actorId: params.actorId,
    action: params.action,
    userId: params.userId,
    targetTable: 'users',
    targetId: params.userId,
    before: params.before,
    after: params.after,
    reason: params.reason,
    traceId: params.traceId,
    conversationId: params.conversationId,
  });
}

/**
 * Atalho pra audit de operação em memory cards.
 */
export async function auditMemoryWrite(params: {
  userId: string;
  cardId: string;
  kind: string;
  text: string;
  confidence: number;
  operation: 'saved' | 'updated' | 'deleted';
  conversationId?: string;
  traceId?: string;
}): Promise<void> {
  await writeAudit({
    actorType: 'system',
    actorId: 'profile-enricher',
    action: `memory.card.${params.operation}`,
    userId: params.userId,
    targetTable: 'memory_cards_index',
    targetId: params.cardId,
    conversationId: params.conversationId,
    traceId: params.traceId,
    metadata: {
      kind: params.kind,
      text_preview: params.text.slice(0, 120),
      confidence: params.confidence,
    },
  });
}

/**
 * Atalho pra audit de mudança em order/consultation.
 */
export async function auditOrderTransition(params: {
  orderId: string;
  userId: string;
  beforeStatus: string;
  afterStatus: string;
  reason?: string;
  traceId?: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  await writeAudit({
    actorType: 'xarlote',
    action: `order.${params.afterStatus}`,
    userId: params.userId,
    targetTable: 'orders',
    targetId: params.orderId,
    before: { status: params.beforeStatus },
    after: { status: params.afterStatus },
    reason: params.reason,
    traceId: params.traceId,
    metadata: params.metadata,
  });
}
