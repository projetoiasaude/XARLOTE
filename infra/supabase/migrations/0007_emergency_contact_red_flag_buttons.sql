-- 0007 — Contato de emergência + red_flag_pending pra resposta em botões
--
-- 1. users ganha campos emergency_contact_name / phone / relation
-- 2. red_flag_pending: linha por red flag em aberto. Worker escalona em 60s
--    se status='pending'. Botão clicado vira 'responded' (ação registrada
--    em red_flag_pending.user_response + audit_log).

-- ─── Campos de contato de emergência ───────────────────────────────────────
ALTER TABLE users ADD COLUMN IF NOT EXISTS emergency_contact_name TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS emergency_contact_phone_e164 TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS emergency_contact_relation TEXT;
-- emergency_contact_relation: 'mãe', 'pai', 'cônjuge', 'filho(a)', 'irmão(ã)', 'amigo(a)', 'cuidador(a)', 'vizinho(a)'

COMMENT ON COLUMN users.emergency_contact_name IS 'Nome do contato pra acionar em emergência (red flag).';
COMMENT ON COLUMN users.emergency_contact_phone_e164 IS 'WhatsApp E.164 do contato de emergência (com +).';
COMMENT ON COLUMN users.emergency_contact_relation IS 'Relação com o paciente (mãe, pai, cônjuge, amigo, etc).';

-- ─── Estado de red flags em aberto ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS red_flag_pending (
  id UUID PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,
  symptoms_log_id UUID REFERENCES symptoms_log(id) ON DELETE SET NULL,

  category TEXT NOT NULL,            -- self_harm | suicide_ideation | chest_pain | stroke_signs | overdose | ...
  severity TEXT NOT NULL CHECK (severity IN ('high', 'critical')),
  evidence TEXT NOT NULL,
  context TEXT,

  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'responded_call_emergency', 'responded_notify_contact', 'responded_mistake', 'escalated', 'expired')),
  user_response TEXT,                -- texto do botão que o user clicou (ou NULL se escalonou)
  responded_at TIMESTAMPTZ,
  escalated_at TIMESTAMPTZ,
  emergency_contact_notified BOOLEAN NOT NULL DEFAULT false,

  expires_at TIMESTAMPTZ NOT NULL,   -- now + 60s. worker escalona se status='pending' depois disso

  trace_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS red_flag_pending_user_pending_idx
  ON red_flag_pending(user_id, created_at DESC)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS red_flag_pending_expires_idx
  ON red_flag_pending(expires_at)
  WHERE status = 'pending';

COMMENT ON TABLE red_flag_pending IS 'Red flags ativos aguardando resposta do paciente via botão. Worker escalona em 60s.';
