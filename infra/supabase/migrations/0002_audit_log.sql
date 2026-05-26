-- ════════════════════════════════════════════════════════════════════════════
-- Migration 0002 — Audit Log & Event Log (Xarlote 2.0 Foundation)
-- ────────────────────────────────────────────────────────────────────────────
-- Objetivo: rastrear CADA mudança sensível no estado do paciente + cada
-- evento relevante do agente. Sem isso a gente não consegue:
--   - depurar bugs em produção ("por que o status do user mudou pra X?")
--   - auditar LGPD ("quem alterou o dado clínico do paciente Y?")
--   - melhorar cirurgicamente a Xarlote ("quais tools falham mais?")
--   - detectar comportamento anômalo (LLM começou a tomar decisão estranha)
--
-- Princípios:
--   - Append-only (nunca UPDATE, nunca DELETE — só INSERT)
--   - Idempotent: o mesmo evento pode ser registrado 2x sem corromper
--   - Estruturado: payload em JSONB consultável
--   - Particionável por data (se virar muito grande)
-- ════════════════════════════════════════════════════════════════════════════

-- ───── audit_log ─────────────────────────────────────────────────────────────
-- Registra MUDANÇAS DE ESTADO em entidades críticas.
-- Cada row é o resultado de UMA ação que alterou alguma coisa.
-- Ex: user.onboarding_status mudou de 'profiling' → 'active'.
CREATE TABLE IF NOT EXISTS audit_log (
  id BIGSERIAL PRIMARY KEY,

  -- Quando aconteceu
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Quem executou (rastreabilidade)
  actor_type TEXT NOT NULL CHECK (actor_type IN (
    'xarlote',          -- a IA tomou a decisão (via tool call)
    'agent_pharmacy',   -- agente B2B negociando com farmácia
    'agent_clinic',     -- agente B2B negociando com clínica (futuro)
    'system',           -- worker automático (enricher, inventory, etc)
    'admin',            -- humano via dashboard
    'user',             -- paciente via WhatsApp (consent, forget-me, feedback)
    'webhook'           -- evento externo (uazapi delivery report)
  )),
  actor_id TEXT,         -- 'enricher.worker' / 'admin:hiago@iadasaude.com' / null

  -- Qual ação foi tomada — semântica de domínio
  action TEXT NOT NULL,  -- ex: 'user.onboarding.advanced', 'medication.taken',
                         --      'order.confirmed', 'consent.revoked', 'memory.saved'

  -- O que foi afetado
  target_table TEXT,     -- 'users' / 'orders' / 'memory_cards_index' / null
  target_id UUID,        -- id da row alterada (ou nullable pra ações que criam)

  -- Quem é o paciente afetado (sempre populado quando aplicável — facilita query)
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,

  -- Estados antes/depois (pra reconciliação e diff)
  before JSONB,          -- snapshot antes da mudança (campos relevantes)
  after JSONB,           -- snapshot depois

  -- Contexto de rastreamento
  conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,
  message_id UUID REFERENCES messages(id) ON DELETE SET NULL,
  trace_id UUID,         -- correlaciona ações de um mesmo turno
  task_id UUID REFERENCES assistant_tasks(id) ON DELETE SET NULL,

  -- Por que (opcional mas valioso)
  reason TEXT,           -- razão humana — ex: "user requested forget-me"
  metadata JSONB         -- payload livre — args da tool, response code, etc
);

CREATE INDEX IF NOT EXISTS audit_log_user_idx ON audit_log(user_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS audit_log_action_idx ON audit_log(action, occurred_at DESC);
CREATE INDEX IF NOT EXISTS audit_log_trace_idx ON audit_log(trace_id) WHERE trace_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS audit_log_target_idx ON audit_log(target_table, target_id) WHERE target_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS audit_log_actor_idx ON audit_log(actor_type, occurred_at DESC);
CREATE INDEX IF NOT EXISTS audit_log_recent_idx ON audit_log(occurred_at DESC);

COMMENT ON TABLE audit_log IS 'Append-only ledger de mudanças de estado. Toda escrita sensível dispara um insert aqui.';
COMMENT ON COLUMN audit_log.action IS 'Dot notation: dominio.evento.modificador. Ex: user.onboarding.advanced, memory.card.saved, tool.start_pharmacy_order.invoked';


-- ───── event_log ─────────────────────────────────────────────────────────────
-- Registra EVENTOS observáveis do agente (não necessariamente mudaram estado).
-- Mais leve que audit_log — vai aqui telemetria, decisões de roteamento,
-- métricas pontuais, sinais de qualidade.
-- Ex: 'tool.call.duration_ms', 'llm.latency', 'tts.synthesized'
CREATE TABLE IF NOT EXISTS event_log (
  id BIGSERIAL PRIMARY KEY,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  event_name TEXT NOT NULL,    -- ex: 'tool.call', 'llm.completion', 'reminder.sent'
  severity TEXT NOT NULL DEFAULT 'info' CHECK (severity IN ('debug','info','warn','error','critical')),

  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,
  trace_id UUID,

  -- Métricas comuns (denormalizadas pra query rápida)
  duration_ms INTEGER,         -- pra latência de tool/LLM/TTS
  tokens_in INTEGER,
  tokens_out INTEGER,
  cost_brl DECIMAL(10,4),      -- estimativa de custo

  -- Payload bruto
  payload JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS event_log_name_idx ON event_log(event_name, occurred_at DESC);
CREATE INDEX IF NOT EXISTS event_log_user_idx ON event_log(user_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS event_log_trace_idx ON event_log(trace_id) WHERE trace_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS event_log_severity_idx ON event_log(severity, occurred_at DESC) WHERE severity IN ('warn','error','critical');

COMMENT ON TABLE event_log IS 'Eventos observáveis do agente (latência, decisões, sinais). Mais granular que audit_log.';


-- ───── Helper RPC function: write_audit ──────────────────────────────────────
-- Permite gravar audit log via supabase-js client (que só suporta CRUD).
-- Importante: a função roda com SECURITY DEFINER, então o service_role pode
-- inserir mesmo se RLS estiver ativo.
CREATE OR REPLACE FUNCTION write_audit(
  p_actor_type TEXT,
  p_action TEXT,
  p_user_id UUID DEFAULT NULL,
  p_actor_id TEXT DEFAULT NULL,
  p_target_table TEXT DEFAULT NULL,
  p_target_id UUID DEFAULT NULL,
  p_before JSONB DEFAULT NULL,
  p_after JSONB DEFAULT NULL,
  p_conversation_id UUID DEFAULT NULL,
  p_message_id UUID DEFAULT NULL,
  p_trace_id UUID DEFAULT NULL,
  p_task_id UUID DEFAULT NULL,
  p_reason TEXT DEFAULT NULL,
  p_metadata JSONB DEFAULT NULL
) RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_id BIGINT;
BEGIN
  INSERT INTO audit_log(
    actor_type, actor_id, action, target_table, target_id, user_id,
    before, after, conversation_id, message_id, trace_id, task_id, reason, metadata
  ) VALUES (
    p_actor_type, p_actor_id, p_action, p_target_table, p_target_id, p_user_id,
    p_before, p_after, p_conversation_id, p_message_id, p_trace_id, p_task_id, p_reason, p_metadata
  ) RETURNING id INTO v_id;
  RETURN v_id;
END $$;


-- ───── Helper RPC function: write_event ─────────────────────────────────────
CREATE OR REPLACE FUNCTION write_event(
  p_event_name TEXT,
  p_severity TEXT DEFAULT 'info',
  p_user_id UUID DEFAULT NULL,
  p_conversation_id UUID DEFAULT NULL,
  p_trace_id UUID DEFAULT NULL,
  p_duration_ms INTEGER DEFAULT NULL,
  p_tokens_in INTEGER DEFAULT NULL,
  p_tokens_out INTEGER DEFAULT NULL,
  p_cost_brl DECIMAL DEFAULT NULL,
  p_payload JSONB DEFAULT '{}'::jsonb
) RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_id BIGINT;
BEGIN
  INSERT INTO event_log(
    event_name, severity, user_id, conversation_id, trace_id,
    duration_ms, tokens_in, tokens_out, cost_brl, payload
  ) VALUES (
    p_event_name, p_severity, p_user_id, p_conversation_id, p_trace_id,
    p_duration_ms, p_tokens_in, p_tokens_out, p_cost_brl, p_payload
  ) RETURNING id INTO v_id;
  RETURN v_id;
END $$;


-- ───── RLS: staff pode ler tudo, ninguém pode editar/deletar via API ────────
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE event_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "staff_read_audit" ON audit_log;
CREATE POLICY "staff_read_audit" ON audit_log FOR SELECT
  USING (EXISTS (SELECT 1 FROM staff_users WHERE staff_users.id = auth.uid()));

DROP POLICY IF EXISTS "staff_read_event" ON event_log;
CREATE POLICY "staff_read_event" ON event_log FOR SELECT
  USING (EXISTS (SELECT 1 FROM staff_users WHERE staff_users.id = auth.uid()));

-- Inserts só via service_role (que bypassa RLS) ou via write_audit/write_event RPC


-- ───── Convenções de ações (referência rápida) ──────────────────────────────
-- user.onboarding.advanced            antes={status:'not_started'} depois={status:'consent_pending'}
-- user.onboarding.consent_accepted    after={lgpd_consent_at, lgpd_consent_version}
-- user.onboarding.consent_refused
-- user.metadata.updated               diff via before/after
-- user.address.added | updated | set_default
-- user.condition.added | removed | severity_changed
-- user.allergy.added | removed
-- user.medication.added | discontinued | dose_changed
-- user.forget_me.requested
-- user.forget_me.executed             metadata.tables_cleared
-- treatment.started | paused | resumed | completed | interrupted
-- medication.taken | skipped | snoozed | no_response
-- medication.inventory.decremented    metadata.tablets_consumed
-- medication.inventory.running_low    metadata.days_remaining
-- order.draft.created                 by tool start_pharmacy_order
-- order.quoted                        metadata.quote_count
-- order.confirmed                     after={selected_quote_id, total_brl}
-- order.cancelled                     reason
-- order.handed_off                    farmácia confirmou
-- consultation.search.started
-- consultation.quoted
-- consultation.scheduled
-- consultation.completed              metadata.rating
-- consultation.cancelled
-- memory.card.saved                   metadata.kind, similarity
-- memory.card.updated                 metadata.confidence_delta
-- skill.detected                      metadata.pattern, occurrences
-- skill.fired                         skill em uso na conversa
-- tool.invoked                        metadata.tool_name, args
-- tool.failed                         metadata.tool_name, error
-- llm.completion                      via event_log com tokens
-- tts.synthesized                     via event_log com duration_ms
-- stt.transcribed                     via event_log
-- red_flag.detected                   severity='critical', metadata.keywords
-- anomaly.detected                    metadata.type
-- prompts.config.updated              admin via dashboard
