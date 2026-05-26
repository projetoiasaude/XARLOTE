-- 0006_daily_metrics.sql — tabela pra agregação diária de métricas
-- Alimentada pelo worker metrics-aggregator.ts. Cada row = 1 dia.

CREATE TABLE IF NOT EXISTS daily_metrics (
  id UUID PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  day DATE NOT NULL UNIQUE,

  -- Volume
  total_turns INTEGER NOT NULL DEFAULT 0,
  total_users_active INTEGER NOT NULL DEFAULT 0,
  total_messages_in INTEGER NOT NULL DEFAULT 0,
  total_messages_out INTEGER NOT NULL DEFAULT 0,

  -- LLM (durations em ms)
  llm_calls INTEGER NOT NULL DEFAULT 0,
  llm_p50_ms INTEGER,
  llm_p95_ms INTEGER,
  llm_p99_ms INTEGER,
  llm_total_tokens INTEGER NOT NULL DEFAULT 0,
  llm_total_cost_usd DECIMAL(10,4) NOT NULL DEFAULT 0,

  -- Tools
  tool_calls INTEGER NOT NULL DEFAULT 0,
  tool_failures INTEGER NOT NULL DEFAULT 0,
  tool_counts JSONB NOT NULL DEFAULT '{}'::jsonb,   -- { "start_pharmacy_order": 12, ... }

  -- Orders
  orders_created INTEGER NOT NULL DEFAULT 0,
  orders_confirmed INTEGER NOT NULL DEFAULT 0,
  orders_failed INTEGER NOT NULL DEFAULT 0,
  avg_quotes_per_order DECIMAL(5,2),

  -- Consultations
  consultations_started INTEGER NOT NULL DEFAULT 0,
  consultations_scheduled INTEGER NOT NULL DEFAULT 0,
  consultations_completed INTEGER NOT NULL DEFAULT 0,

  -- Red flags
  red_flags_detected INTEGER NOT NULL DEFAULT 0,
  red_flags_by_category JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- TTS / STT
  tts_synthesized INTEGER NOT NULL DEFAULT 0,
  tts_avg_ms INTEGER,
  stt_transcribed INTEGER NOT NULL DEFAULT 0,

  computed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS daily_metrics_day_idx ON daily_metrics(day DESC);

COMMENT ON TABLE daily_metrics IS 'Agregação diária de métricas do sistema. Alimentada pelo worker metrics-aggregator.';
