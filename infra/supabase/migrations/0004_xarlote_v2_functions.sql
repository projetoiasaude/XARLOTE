-- ════════════════════════════════════════════════════════════════════════════
-- Migration 0004 — Funções SQL + Views (Xarlote 2.0)
-- ────────────────────────────────────────────────────────────────────────────
-- Funções que a aplicação Node consome via supabase-js (.rpc()):
--   calc_adherence_score(user, days)   → score 0-1 de adesão
--   query_user_360(user)               → perfil rico pra prompt context
--   find_clinics(specialty, city, k)   → busca clínicas
--   pharmacy_history(user, months)     → histórico de farmácias usadas
--   medications_running_low(threshold) → meds que vão acabar em <X dias
--   add_or_refresh_relation(...)       → upsert em entity_relations
-- ════════════════════════════════════════════════════════════════════════════


-- ───── calc_adherence_score ─────────────────────────────────────────────────
-- Calcula score de adesão no janela X dias. Score = taken / total_response.
-- Retorna NULL se não houve nenhuma janela de adesão (sem reminders enviados).
CREATE OR REPLACE FUNCTION calc_adherence_score(
  p_user_id UUID,
  p_days INTEGER DEFAULT 30
) RETURNS DECIMAL
LANGUAGE sql
STABLE
AS $$
  WITH events AS (
    SELECT
      COUNT(*) FILTER (WHERE status = 'taken') AS taken,
      COUNT(*) FILTER (WHERE status IN ('skipped','no_response')) AS missed,
      COUNT(*) AS total
    FROM medication_log
    WHERE user_id = p_user_id
      AND scheduled_at >= now() - (p_days || ' days')::INTERVAL
  )
  SELECT
    CASE
      WHEN total = 0 THEN NULL
      ELSE ROUND(taken::DECIMAL / total::DECIMAL, 2)
    END
  FROM events;
$$;


-- ───── medications_running_low ──────────────────────────────────────────────
-- Devolve inventários que devem acabar em até `p_days_threshold` dias.
-- Usado pelo worker inventory-tracker pra acionar a Xarlote.
CREATE OR REPLACE FUNCTION medications_running_low(
  p_days_threshold INTEGER DEFAULT 7
) RETURNS TABLE (
  inventory_id UUID,
  user_id UUID,
  medication_id UUID,
  medication_name TEXT,
  dosage TEXT,
  tablets_remaining INTEGER,
  daily_consumption DECIMAL,
  days_remaining DECIMAL,
  user_phone TEXT,
  user_name TEXT
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    mi.id AS inventory_id,
    mi.user_id,
    mi.medication_id,
    um.medication_name,
    um.dosage,
    mi.tablets_remaining,
    um.daily_consumption,
    CASE
      WHEN um.daily_consumption > 0
        THEN ROUND(mi.tablets_remaining::DECIMAL / um.daily_consumption, 1)
      ELSE NULL
    END AS days_remaining,
    u.phone_e164 AS user_phone,
    COALESCE(u.preferred_name, u.full_name) AS user_name
  FROM medication_inventory mi
  JOIN user_medications um ON um.id = mi.medication_id
  JOIN users u ON u.id = mi.user_id
  WHERE mi.tablets_remaining > 0
    AND mi.reorder_offered_at IS NULL
    AND um.active = true
    AND um.daily_consumption IS NOT NULL
    AND um.daily_consumption > 0
    AND (mi.tablets_remaining::DECIMAL / um.daily_consumption) <= p_days_threshold
  ORDER BY days_remaining ASC NULLS LAST;
$$;


-- ───── find_clinics ─────────────────────────────────────────────────────────
-- Busca clínicas por especialidade e cidade, com ranking baseado em rating +
-- response_rate. Exclui blacklistadas. Limit padrão 8.
CREATE OR REPLACE FUNCTION find_clinics(
  p_specialty TEXT,
  p_city TEXT DEFAULT NULL,
  p_state CHAR(2) DEFAULT NULL,
  p_limit INTEGER DEFAULT 8
) RETURNS TABLE (
  id UUID,
  name TEXT,
  type TEXT,
  specialties TEXT[],
  address TEXT,
  city TEXT,
  state CHAR(2),
  lat DECIMAL,
  lng DECIMAL,
  whatsapp_e164 TEXT,
  accepts_plans TEXT[],
  rating DECIMAL,
  response_rate DECIMAL,
  rank_score DECIMAL
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    c.id, c.name, c.type, c.specialties,
    c.address, c.city, c.state, c.lat, c.lng,
    c.whatsapp_e164, c.accepts_plans, c.rating, c.response_rate,
    -- score combinado: rating + response_rate (cada 0-1) — empate por last_contacted
    (COALESCE(c.rating, 3.0) / 5.0 * 0.6
      + COALESCE(c.response_rate, 0.5) * 0.4)::DECIMAL AS rank_score
  FROM clinics c
  WHERE c.blacklist_reason IS NULL
    AND p_specialty = ANY(c.specialties)
    AND (p_city IS NULL OR c.city ILIKE p_city)
    AND (p_state IS NULL OR c.state = p_state)
    AND c.whatsapp_e164 IS NOT NULL   -- precisa de canal pra cotar
  ORDER BY rank_score DESC NULLS LAST, c.last_contacted_at DESC NULLS LAST
  LIMIT p_limit;
$$;


-- ───── pharmacy_history ─────────────────────────────────────────────────────
-- Histórico de farmácias que o user já usou — útil pro pharmacy-recommender.
CREATE OR REPLACE FUNCTION pharmacy_history(
  p_user_id UUID,
  p_months INTEGER DEFAULT 12
) RETURNS TABLE (
  supplier_id UUID,
  supplier_name TEXT,
  total_orders INTEGER,
  total_amount_brl DECIMAL,
  last_order_at TIMESTAMPTZ,
  avg_rating DECIMAL
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    s.id AS supplier_id,
    s.name AS supplier_name,
    COUNT(DISTINCT o.id)::INTEGER AS total_orders,
    SUM(q.subtotal)::DECIMAL AS total_amount_brl,
    MAX(o.created_at) AS last_order_at,
    AVG(NULLIF(fe.sentiment, 0)::DECIMAL)::DECIMAL AS avg_rating
  FROM orders o
  JOIN quotes q ON q.id = o.selected_quote_id
  JOIN suppliers s ON s.id = q.supplier_id
  LEFT JOIN feedback_events fe ON fe.target_type = 'supplier' AND fe.target_id = s.id AND fe.user_id = p_user_id
  WHERE o.user_id = p_user_id
    AND o.status IN ('confirming','handed_off','completed')
    AND o.created_at >= now() - (p_months || ' months')::INTERVAL
  GROUP BY s.id, s.name
  ORDER BY total_orders DESC, last_order_at DESC;
$$;


-- ───── add_or_refresh_relation ──────────────────────────────────────────────
-- Upsert em entity_relations: cria se não existe, refresh se existe.
-- Usado pelo knowledge-graph-builder worker.
CREATE OR REPLACE FUNCTION add_or_refresh_relation(
  p_user_id UUID,
  p_subject_type TEXT, p_subject_id UUID,
  p_relation TEXT,
  p_object_type TEXT, p_object_id UUID,
  p_confidence DECIMAL DEFAULT 1.0,
  p_evidence_message_id UUID DEFAULT NULL,
  p_metadata JSONB DEFAULT '{}'::jsonb
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_existing_id UUID;
BEGIN
  -- Tenta achar relação ativa duplicata
  SELECT id INTO v_existing_id
  FROM entity_relations
  WHERE user_id = p_user_id
    AND subject_type = p_subject_type AND subject_id = p_subject_id
    AND relation = p_relation
    AND object_type = p_object_type AND object_id = p_object_id
    AND active = true
  LIMIT 1;

  IF v_existing_id IS NOT NULL THEN
    UPDATE entity_relations
    SET confidence = GREATEST(confidence, p_confidence),
        evidence_message_id = COALESCE(p_evidence_message_id, evidence_message_id),
        metadata = metadata || p_metadata
    WHERE id = v_existing_id;
    RETURN v_existing_id;
  END IF;

  INSERT INTO entity_relations(
    user_id, subject_type, subject_id, relation, object_type, object_id,
    confidence, evidence_message_id, metadata
  ) VALUES (
    p_user_id, p_subject_type, p_subject_id, p_relation, p_object_type, p_object_id,
    p_confidence, p_evidence_message_id, p_metadata
  ) RETURNING id INTO v_existing_id;

  RETURN v_existing_id;
END $$;


-- ───── query_user_360 ───────────────────────────────────────────────────────
-- DEVOLVE perfil completo do paciente em UM JSON.
-- Reduz N queries do system prompt pra UMA — performance crítica em prod.
CREATE OR REPLACE FUNCTION query_user_360(p_user_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_result JSONB;
BEGIN
  SELECT jsonb_build_object(
    'user', to_jsonb(u.*) - 'metadata',
    'preferences', u.communication_prefs,

    'conditions', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', c.id, 'name', c.name, 'severity', c.severity,
        'since', c.since, 'source', c.source
      ) ORDER BY c.created_at DESC)
      FROM user_health_conditions c
      WHERE c.user_id = p_user_id AND c.active = true
    ), '[]'::jsonb),

    'allergies', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', a.id, 'substance', a.substance, 'severity', a.severity,
        'reaction', a.reaction, 'source', a.source
      ) ORDER BY a.created_at DESC)
      FROM user_allergies a
      WHERE a.user_id = p_user_id
    ), '[]'::jsonb),

    'active_treatments', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', t.id, 'name', t.name, 'status', t.status,
        'started_at', t.started_at,
        'medications', COALESCE((
          SELECT jsonb_agg(jsonb_build_object(
            'id', um.id, 'name', um.medication_name, 'dosage', um.dosage,
            'frequency', um.frequency, 'daily_consumption', um.daily_consumption,
            'tablets_remaining', (
              SELECT mi.tablets_remaining
              FROM medication_inventory mi
              WHERE mi.medication_id = um.id AND mi.tablets_remaining > 0
              ORDER BY mi.purchased_at DESC LIMIT 1
            ),
            'days_remaining', (
              SELECT ROUND(mi.tablets_remaining::DECIMAL / NULLIF(um.daily_consumption, 0), 1)
              FROM medication_inventory mi
              WHERE mi.medication_id = um.id AND mi.tablets_remaining > 0
              ORDER BY mi.purchased_at DESC LIMIT 1
            ),
            'last_taken_at', um.last_taken_at
          ) ORDER BY um.created_at DESC)
          FROM user_medications um
          WHERE um.treatment_id = t.id AND um.active = true
        ), '[]'::jsonb)
      ) ORDER BY t.started_at DESC)
      FROM treatments t
      WHERE t.user_id = p_user_id AND t.status = 'active'
    ), '[]'::jsonb),

    'addresses', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', a.id, 'label', a.label, 'street', a.street,
        'neighborhood', a.neighborhood, 'city', a.city, 'state', a.state,
        'is_default', a.is_default, 'usage_count', a.usage_count,
        'last_used_at', a.last_used_at, 'notes', a.notes
      ) ORDER BY a.is_default DESC, a.usage_count DESC)
      FROM user_addresses a
      WHERE a.user_id = p_user_id
    ), '[]'::jsonb),

    'recent_symptoms', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'name', s.name, 'intensity', s.intensity,
        'duration_hours', s.duration_hours, 'context', s.context,
        'created_at', s.created_at
      ) ORDER BY s.created_at DESC)
      FROM symptoms_log s
      WHERE s.user_id = p_user_id
        AND s.created_at >= now() - INTERVAL '30 days'
      LIMIT 10
    ), '[]'::jsonb),

    'upcoming_consultations', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', c.id, 'specialty', c.specialty, 'scheduled_at', c.scheduled_at,
        'modality', c.modality, 'clinic_name', cl.name,
        'prescriber_name', pr.name
      ) ORDER BY c.scheduled_at ASC)
      FROM consultations c
      LEFT JOIN clinics cl ON cl.id = c.scheduled_clinic_id
      LEFT JOIN prescribers pr ON pr.id = c.scheduled_prescriber_id
      WHERE c.user_id = p_user_id
        AND c.status = 'scheduled'
        AND c.scheduled_at >= now()
    ), '[]'::jsonb),

    'favorite_pharmacies', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', supplier_id, 'name', supplier_name, 'orders', total_orders,
        'last_order_at', last_order_at
      ))
      FROM (SELECT * FROM pharmacy_history(p_user_id, 12) LIMIT 3) ph
    ), '[]'::jsonb),

    'active_order_id', (
      SELECT o.id FROM orders o
      WHERE o.user_id = p_user_id
        AND o.status IN ('drafting','quoting','quoted','confirming')
      ORDER BY o.created_at DESC LIMIT 1
    ),

    'adherence_score_30d', calc_adherence_score(p_user_id, 30),

    'skills', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'trigger', sk.trigger_pattern, 'action', sk.action_pattern,
        'context', sk.context, 'occurrences', sk.occurrences
      ))
      FROM agent_skills sk
      WHERE (sk.user_id = p_user_id OR sk.user_id IS NULL)
        AND sk.active = true
      LIMIT 10
    ), '[]'::jsonb)
  ) INTO v_result
  FROM users u
  WHERE u.id = p_user_id;

  RETURN v_result;
END $$;


COMMENT ON FUNCTION query_user_360 IS 'Perfil rico do paciente em um único query — usado pelo system prompt da Xarlote';
COMMENT ON FUNCTION calc_adherence_score IS 'Score 0-1 de adesão medicamentosa nos últimos N dias';
COMMENT ON FUNCTION medications_running_low IS 'Lista medicamentos que vão acabar em <N dias (usado pelo inventory-tracker)';
COMMENT ON FUNCTION find_clinics IS 'Busca clínicas por especialidade+cidade com ranking';
COMMENT ON FUNCTION pharmacy_history IS 'Top farmácias do user nos últimos N meses';
COMMENT ON FUNCTION add_or_refresh_relation IS 'Upsert idempotente em entity_relations';
