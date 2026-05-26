-- 0005_clinic_conversations.sql — Permite conversations com party_type='clinic'
--
-- ATENÇÃO: o `ALTER TYPE ... ADD VALUE` exige commit antes do uso do novo
-- valor (PG 12+). Por isso essa migration tem 2 BLOCOS — primeiro ADD VALUE,
-- depois o resto. Se a CLI do Supabase rodar tudo numa transação, o IF NOT
-- EXISTS evita falha em re-run.

-- ─── 1. Adiciona 'clinic' ao enum conversation_party_t ───────────────────────
ALTER TYPE conversation_party_t ADD VALUE IF NOT EXISTS 'clinic';

-- (As próximas alterações precisam de uma transação separada — abaixo está em
-- DO block que só roda DEPOIS do commit do enum acima.)

DO $$
BEGIN
  -- ─── 2. Adiciona clinic_id à conversations ─────────────────────────────────
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'conversations' AND column_name = 'clinic_id'
  ) THEN
    ALTER TABLE conversations ADD COLUMN clinic_id UUID;
  END IF;

  -- FK pra clinics (só se a tabela clinics existir — migration 0003 deve ter rodado)
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'clinics') THEN
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.table_constraints
      WHERE table_name = 'conversations' AND constraint_name = 'conversations_clinic_id_fkey'
    ) THEN
      ALTER TABLE conversations
        ADD CONSTRAINT conversations_clinic_id_fkey
        FOREIGN KEY (clinic_id) REFERENCES clinics(id) ON DELETE SET NULL;
    END IF;
  END IF;
END $$;

-- 3. Índice pra busca rápida por clinic_id
CREATE INDEX IF NOT EXISTS conversations_clinic_idx
  ON conversations(clinic_id) WHERE clinic_id IS NOT NULL;

COMMENT ON COLUMN conversations.clinic_id IS
  'Apenas quando party_type=''clinic''. Espelho de supplier_id pro fluxo de consulta médica.';
