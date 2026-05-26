-- ════════════════════════════════════════════════════════════════════════════
-- Migration 0003 — Schema Xarlote 2.0
-- ────────────────────────────────────────────────────────────────────────────
-- Adiciona tudo necessário pra:
--   - Tratamentos longitudinais (treatments + inventory + medication_log)
--   - Marcação de consulta médica (prescribers + clinics + consultations + quotes)
--   - Sintomas reportados pelo paciente (symptoms_log)
--   - Knowledge graph (entity_relations)
--   - Skills aprendidas (agent_skills)
--   - Feedback explícito do user (feedback_events)
--   - Expansões em users / user_addresses / user_medications
--
-- Todas as alterações são ADITIVAS — não derruba dados existentes.
-- Defaults sensatos pra colunas novas em tabelas existentes.
-- ════════════════════════════════════════════════════════════════════════════


-- ═══════════════════════ EXPANSÕES EM TABELAS EXISTENTES ══════════════════

-- users — preferências de comunicação, perfil profissional, score de adesão
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS communication_prefs JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS professional_profile JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS primary_doctor_id UUID,
  ADD COLUMN IF NOT EXISTS health_summary TEXT,
  ADD COLUMN IF NOT EXISTS last_active_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS adherence_score_30d DECIMAL(3,2),
  ADD COLUMN IF NOT EXISTS preferred_language TEXT NOT NULL DEFAULT 'pt-BR',
  ADD COLUMN IF NOT EXISTS reminder_max_per_day INTEGER NOT NULL DEFAULT 6;

COMMENT ON COLUMN users.communication_prefs IS '{ audio_replies, quiet_hours: [22,7], reminder_emoji_ok, language_simple }';
COMMENT ON COLUMN users.professional_profile IS '{ occupation, workplace_address_id, shift_pattern }';
COMMENT ON COLUMN users.health_summary IS 'Síntese gerada pelo enricher pra prompt context (~200 chars). NÃO é dado clínico oficial.';
COMMENT ON COLUMN users.adherence_score_30d IS '0.00-1.00, calculado pelo adherence-scorer worker';


-- user_addresses — usar rotulação de fato (casa/trabalho), tracking de uso, notas
ALTER TABLE user_addresses
  ADD COLUMN IF NOT EXISTS usage_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS is_default BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS notes TEXT;

-- Apenas 1 endereço default por usuário (constraint parcial)
CREATE UNIQUE INDEX IF NOT EXISTS user_addresses_one_default_per_user_idx
  ON user_addresses(user_id) WHERE is_default = true;

COMMENT ON COLUMN user_addresses.usage_count IS 'Incrementado a cada order/consultation que usa esse endereço';
COMMENT ON COLUMN user_addresses.notes IS 'Instruções extra: "deixar com porteiro", "tocar campainha 2x"';


-- user_medications — link com treatment + inventário + prescritor + flags
ALTER TABLE user_medications
  ADD COLUMN IF NOT EXISTS treatment_id UUID,
  ADD COLUMN IF NOT EXISTS tablets_per_box INTEGER,
  ADD COLUMN IF NOT EXISTS daily_consumption DECIMAL(5,2),
  ADD COLUMN IF NOT EXISTS start_date DATE,
  ADD COLUMN IF NOT EXISTS expected_end_date DATE,
  ADD COLUMN IF NOT EXISTS prescriber_id UUID,
  ADD COLUMN IF NOT EXISTS last_taken_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS needs_prescription BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS controlled_class TEXT;
  -- controlled_class: 'tarja_vermelha' | 'tarja_preta' | null

COMMENT ON COLUMN user_medications.daily_consumption IS 'Comprimidos/dia (ex: 1.0, 0.5 pra meio comprimido)';
COMMENT ON COLUMN user_medications.controlled_class IS 'NULL=OTC, tarja_vermelha=receita comum, tarja_preta=receita especial';


-- ═══════════════════════ NOVAS TABELAS ════════════════════════════════════

-- ────── treatments — regime clínico ─────────────────────────────────────────
-- Agrupa medicações que pertencem a um mesmo "plano" do paciente.
-- Ex: "Tratamento de hipertensão" → Losartana + Hidroclorotiazida
CREATE TABLE IF NOT EXISTS treatments (
  id UUID PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  condition_id UUID REFERENCES user_health_conditions(id) ON DELETE SET NULL,
  status TEXT NOT NULL CHECK (status IN ('active','paused','completed','interrupted')),
  started_at DATE NOT NULL DEFAULT CURRENT_DATE,
  ended_at DATE,
  interruption_reason TEXT,
  prescriber_id UUID,
  prescription_id UUID REFERENCES prescriptions(id) ON DELETE SET NULL,
  notes TEXT,
  -- Procedência (importante: dado clínico)
  source TEXT NOT NULL DEFAULT 'inferred' CHECK (source IN ('inferred','self_reported','prescription_ocr','agent_admin')),
  confidence DECIMAL(3,2) NOT NULL DEFAULT 0.8,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS treatments_user_active_idx ON treatments(user_id, status) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS treatments_condition_idx ON treatments(condition_id) WHERE condition_id IS NOT NULL;

CREATE TRIGGER treatments_updated_at_trigger
  BEFORE UPDATE ON treatments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ────── medication_inventory — caixas físicas que o user tem ──────────────
CREATE TABLE IF NOT EXISTS medication_inventory (
  id UUID PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  medication_id UUID NOT NULL REFERENCES user_medications(id) ON DELETE CASCADE,
  treatment_id UUID REFERENCES treatments(id) ON DELETE SET NULL,
  source_order_id UUID REFERENCES orders(id) ON DELETE SET NULL,
  box_count INTEGER NOT NULL CHECK (box_count > 0),
  tablets_per_box INTEGER NOT NULL CHECK (tablets_per_box > 0),
  tablets_remaining INTEGER NOT NULL CHECK (tablets_remaining >= 0),
  purchased_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expected_depletion_at DATE,        -- calculado: remaining / daily_consumption
  reorder_offered_at TIMESTAMPTZ,    -- pra não reoferecer
  reorder_accepted BOOLEAN,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS medication_inventory_user_idx ON medication_inventory(user_id);
CREATE INDEX IF NOT EXISTS medication_inventory_running_low_idx
  ON medication_inventory(user_id, expected_depletion_at)
  WHERE tablets_remaining > 0 AND reorder_offered_at IS NULL;

CREATE TRIGGER medication_inventory_updated_at_trigger
  BEFORE UPDATE ON medication_inventory
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ────── medication_log — adesão (cada tomada/pulo) ────────────────────────
CREATE TABLE IF NOT EXISTS medication_log (
  id UUID PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  medication_id UUID NOT NULL REFERENCES user_medications(id) ON DELETE CASCADE,
  treatment_id UUID REFERENCES treatments(id) ON DELETE SET NULL,
  reminder_id UUID REFERENCES reminders(id) ON DELETE SET NULL,
  status TEXT NOT NULL CHECK (status IN ('taken','skipped','snoozed','no_response')),
  scheduled_at TIMESTAMPTZ NOT NULL,
  responded_at TIMESTAMPTZ,
  response_text TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS medication_log_user_recent_idx ON medication_log(user_id, scheduled_at DESC);
CREATE INDEX IF NOT EXISTS medication_log_treatment_idx ON medication_log(treatment_id, scheduled_at DESC)
  WHERE treatment_id IS NOT NULL;


-- ────── prescribers — médicos que prescreveram ────────────────────────────
CREATE TABLE IF NOT EXISTS prescribers (
  id UUID PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,  -- NULL = global, populado = especifico do user
  name TEXT NOT NULL,
  crm TEXT,                            -- ex: "123456" (número)
  crm_state CHAR(2),                   -- "SP", "GO", "RJ"
  specialty TEXT,                      -- "cardiologia", "endocrinologia"
  clinic_id UUID,                      -- FK adicionada após criar tabela clinics
  phone_e164 TEXT,
  whatsapp_e164 TEXT,
  whatsapp_verified_at TIMESTAMPTZ,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS prescribers_user_idx ON prescribers(user_id) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS prescribers_specialty_idx ON prescribers(specialty);
CREATE UNIQUE INDEX IF NOT EXISTS prescribers_crm_unique ON prescribers(crm, crm_state)
  WHERE crm IS NOT NULL AND crm_state IS NOT NULL;

CREATE TRIGGER prescribers_updated_at_trigger
  BEFORE UPDATE ON prescribers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ────── clinics — diretório de clínicas/médicos ───────────────────────────
CREATE TABLE IF NOT EXISTS clinics (
  id UUID PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('clinic','hospital','lab','solo_doctor','telemedicine')),
  specialties TEXT[] NOT NULL DEFAULT '{}',
  google_place_id TEXT UNIQUE,
  address TEXT,
  city TEXT,
  state CHAR(2),
  neighborhood TEXT,
  lat DECIMAL(10,7),
  lng DECIMAL(10,7),
  phone_e164 TEXT,
  whatsapp_e164 TEXT,
  whatsapp_verified_at TIMESTAMPTZ,
  accepts_plans TEXT[] NOT NULL DEFAULT '{}',
  rating DECIMAL(2,1),
  total_consultations INTEGER NOT NULL DEFAULT 0,
  last_contacted_at TIMESTAMPTZ,
  response_rate DECIMAL(3,2),
  blacklist_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS clinics_city_idx ON clinics(city) WHERE blacklist_reason IS NULL;
CREATE INDEX IF NOT EXISTS clinics_specialty_gin_idx ON clinics USING GIN(specialties);
CREATE INDEX IF NOT EXISTS clinics_active_idx ON clinics(blacklist_reason) WHERE blacklist_reason IS NULL;

CREATE TRIGGER clinics_updated_at_trigger
  BEFORE UPDATE ON clinics
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- FK pendente: prescribers.clinic_id → clinics.id
ALTER TABLE prescribers
  ADD CONSTRAINT prescribers_clinic_fkey FOREIGN KEY (clinic_id) REFERENCES clinics(id) ON DELETE SET NULL;


-- ────── consultations — espelho de orders pra consulta médica ─────────────
CREATE TABLE IF NOT EXISTS consultations (
  id UUID PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,
  status TEXT NOT NULL CHECK (status IN (
    'drafting','searching','quoting','quoted','confirming','scheduled','completed','cancelled','failed'
  )),
  specialty TEXT NOT NULL,
  urgency TEXT NOT NULL CHECK (urgency IN ('rotina','72h','24h','urgente')),
  modality TEXT CHECK (modality IN ('presencial','telemedicina','indiferente')),
  city TEXT,
  preferences JSONB NOT NULL DEFAULT '{}'::jsonb,
                                        -- { plano: "Unimed", genero_medico: "feminino",
                                        --   horario_pref: "manhã", evitar_clinicas: [...] }
  selected_quote_id UUID,
  scheduled_at TIMESTAMPTZ,
  scheduled_clinic_id UUID REFERENCES clinics(id) ON DELETE SET NULL,
  scheduled_prescriber_id UUID REFERENCES prescribers(id) ON DELETE SET NULL,
  scheduled_address_id UUID REFERENCES user_addresses(id) ON DELETE SET NULL,
  user_rating INTEGER CHECK (user_rating BETWEEN 1 AND 5),
  user_feedback TEXT,
  completed_at TIMESTAMPTZ,
  cancelled_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS consultations_user_status_idx ON consultations(user_id, status);
CREATE INDEX IF NOT EXISTS consultations_upcoming_idx ON consultations(user_id, scheduled_at)
  WHERE status = 'scheduled';

CREATE TRIGGER consultations_updated_at_trigger
  BEFORE UPDATE ON consultations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ────── consultation_quotes — ofertas de clínicas ─────────────────────────
CREATE TABLE IF NOT EXISTS consultation_quotes (
  id UUID PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  consultation_id UUID NOT NULL REFERENCES consultations(id) ON DELETE CASCADE,
  clinic_id UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  prescriber_id UUID REFERENCES prescribers(id) ON DELETE SET NULL,
  conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','offered','unavailable','timeout','withdrawn','selected','rejected')),
  proposed_datetime TIMESTAMPTZ,
  alternative_datetimes TIMESTAMPTZ[],
  price_brl DECIMAL(10,2),
  plan_accepted TEXT,
  payment_methods TEXT[],
  modality TEXT CHECK (modality IN ('presencial','telemedicina')),
  notes TEXT,
  responded_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS consultation_quotes_consultation_idx ON consultation_quotes(consultation_id);

-- FK: consultations.selected_quote_id → consultation_quotes.id
ALTER TABLE consultations
  ADD CONSTRAINT consultations_selected_quote_fkey
  FOREIGN KEY (selected_quote_id) REFERENCES consultation_quotes(id) ON DELETE SET NULL;


-- ────── symptoms_log — queixas reportadas pelo paciente ──────────────────
CREATE TABLE IF NOT EXISTS symptoms_log (
  id UUID PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,
  message_id UUID REFERENCES messages(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  intensity SMALLINT CHECK (intensity BETWEEN 1 AND 10),
  duration_hours DECIMAL(6,2),
  context TEXT,                                -- "depois do almoço", "ao acordar"
  related_condition_id UUID REFERENCES user_health_conditions(id) ON DELETE SET NULL,
  red_flag_triggered BOOLEAN NOT NULL DEFAULT false,
  red_flag_reason TEXT,
  notes TEXT,
  source TEXT NOT NULL DEFAULT 'inferred' CHECK (source IN ('inferred','self_reported')),
  confidence DECIMAL(3,2) NOT NULL DEFAULT 0.7,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS symptoms_log_user_recent_idx ON symptoms_log(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS symptoms_log_red_flag_idx ON symptoms_log(red_flag_triggered, created_at DESC)
  WHERE red_flag_triggered = true;


-- ────── entity_relations — knowledge graph ────────────────────────────────
-- subject --relation--> object
-- ex: user(X) --takes--> medication(Losartana) {active: true, since: 2026-01-01}
-- ex: medication(Losartana) --treats--> condition(hipertensão)
-- ex: order(O123) --fulfilled_by--> supplier(Drogasil-Setor-Bueno)
CREATE TABLE IF NOT EXISTS entity_relations (
  id UUID PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  subject_type TEXT NOT NULL,    -- 'user','medication','condition','prescriber','order','supplier','symptom','clinic','consultation','treatment'
  subject_id UUID NOT NULL,

  relation TEXT NOT NULL,        -- 'takes','treats','prescribed_by','fulfilled_by','reported','with','at','works_at','contained','bought_at','related_to'

  object_type TEXT NOT NULL,
  object_id UUID NOT NULL,

  active BOOLEAN NOT NULL DEFAULT true,
  confidence DECIMAL(3,2) NOT NULL DEFAULT 1.0,
  since DATE,
  until DATE,
  evidence_message_id UUID REFERENCES messages(id) ON DELETE SET NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS entity_relations_subject_idx ON entity_relations(user_id, subject_type, subject_id);
CREATE INDEX IF NOT EXISTS entity_relations_object_idx ON entity_relations(user_id, object_type, object_id);
CREATE INDEX IF NOT EXISTS entity_relations_relation_active_idx ON entity_relations(user_id, relation) WHERE active = true;
CREATE UNIQUE INDEX IF NOT EXISTS entity_relations_dedup_idx
  ON entity_relations(user_id, subject_type, subject_id, relation, object_type, object_id)
  WHERE active = true;


-- ────── agent_skills — procedural memory (Hermes "growing agent") ────────
CREATE TABLE IF NOT EXISTS agent_skills (
  id UUID PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,  -- NULL = global skill
  trigger_pattern TEXT NOT NULL,    -- "user pede medicamento M1"
  action_pattern TEXT NOT NULL,     -- "também oferece M2 junto"
  context JSONB NOT NULL DEFAULT '{}'::jsonb,  -- detalhes (medicamentos, horários, etc)
  occurrences INTEGER NOT NULL DEFAULT 0,
  last_observed_at TIMESTAMPTZ,
  last_fired_at TIMESTAMPTZ,        -- última vez que a Xarlote efetivamente usou
  active BOOLEAN NOT NULL DEFAULT true,
  disabled_by TEXT,                 -- 'admin' | 'user_feedback' | 'auto_decay'
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS agent_skills_user_active_idx ON agent_skills(user_id, active);
CREATE INDEX IF NOT EXISTS agent_skills_global_active_idx ON agent_skills(active)
  WHERE user_id IS NULL AND active = true;

CREATE TRIGGER agent_skills_updated_at_trigger
  BEFORE UPDATE ON agent_skills
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ────── feedback_events — feedback do user (explícito ou implícito) ──────
CREATE TABLE IF NOT EXISTS feedback_events (
  id UUID PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL,    -- 'order','consultation','reminder','supplier','clinic','prescriber','xarlote_message'
  target_id UUID NOT NULL,
  sentiment SMALLINT NOT NULL CHECK (sentiment IN (-1, 0, 1)),  -- 👎 / neutro / 👍
  notes TEXT,
  source TEXT NOT NULL DEFAULT 'inferred' CHECK (source IN ('inferred','self_reported','admin')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS feedback_events_target_idx ON feedback_events(target_type, target_id);
CREATE INDEX IF NOT EXISTS feedback_events_user_idx ON feedback_events(user_id, created_at DESC);


-- FK pendente: user_medications.treatment_id → treatments.id
ALTER TABLE user_medications
  ADD CONSTRAINT user_medications_treatment_fkey
  FOREIGN KEY (treatment_id) REFERENCES treatments(id) ON DELETE SET NULL;

ALTER TABLE user_medications
  ADD CONSTRAINT user_medications_prescriber_fkey
  FOREIGN KEY (prescriber_id) REFERENCES prescribers(id) ON DELETE SET NULL;

-- FK: users.primary_doctor_id → prescribers.id
ALTER TABLE users
  ADD CONSTRAINT users_primary_doctor_fkey
  FOREIGN KEY (primary_doctor_id) REFERENCES prescribers(id) ON DELETE SET NULL;


-- ═══════════════════════ RLS pra novas tabelas ═════════════════════════════
ALTER TABLE treatments ENABLE ROW LEVEL SECURITY;
ALTER TABLE medication_inventory ENABLE ROW LEVEL SECURITY;
ALTER TABLE medication_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE prescribers ENABLE ROW LEVEL SECURITY;
ALTER TABLE clinics ENABLE ROW LEVEL SECURITY;
ALTER TABLE consultations ENABLE ROW LEVEL SECURITY;
ALTER TABLE consultation_quotes ENABLE ROW LEVEL SECURITY;
ALTER TABLE symptoms_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE entity_relations ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_skills ENABLE ROW LEVEL SECURITY;
ALTER TABLE feedback_events ENABLE ROW LEVEL SECURITY;

-- Staff read-only nas tabelas sensíveis
DO $$ BEGIN
  FOR t IN SELECT unnest(ARRAY['treatments','medication_inventory','medication_log',
                                'prescribers','clinics','consultations','consultation_quotes',
                                'symptoms_log','entity_relations','agent_skills','feedback_events']) LOOP
    EXECUTE format('DROP POLICY IF EXISTS "staff_read" ON %I', t);
    EXECUTE format('CREATE POLICY "staff_read" ON %I FOR SELECT USING (EXISTS (SELECT 1 FROM staff_users WHERE staff_users.id = auth.uid()))', t);
  END LOOP;
END $$;


-- ═══════════════════════ Realtime ═══════════════════════════════════════════
ALTER PUBLICATION supabase_realtime ADD TABLE consultations;
ALTER PUBLICATION supabase_realtime ADD TABLE consultation_quotes;
ALTER PUBLICATION supabase_realtime ADD TABLE treatments;
ALTER PUBLICATION supabase_realtime ADD TABLE medication_log;
