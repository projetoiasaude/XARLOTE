-- 0013 — Loop agêntico resolutivo (Fase 4): estado de clarificação.
--
-- Quando o estabelecimento (farmácia/clínica) faz uma pergunta que exige um dado
-- do paciente (ex.: "é plano ou particular?"), a Xarlote leva ao cliente no
-- WhatsApp dele, recebe a resposta e devolve ao estabelecimento — fechando o
-- ciclo sozinha. A cotação fica `clarification_status='awaiting_user'` e a
-- consolidação PAUSA enquanto há clarificação pendente (com auto-release por tempo
-- via o rescue de pedidos órfãos, pra nunca travar pra sempre).

alter table quotes
  add column if not exists clarification_status text,        -- null | 'awaiting_user' | 'answered'
  add column if not exists clarification_question text,
  add column if not exists clarification_asked_at timestamptz,
  add column if not exists clarification_answer text,
  add column if not exists clarification_answered_at timestamptz;

alter table consultation_quotes
  add column if not exists clarification_status text,
  add column if not exists clarification_question text,
  add column if not exists clarification_asked_at timestamptz,
  add column if not exists clarification_answer text,
  add column if not exists clarification_answered_at timestamptz;

-- achar rápido cotações aguardando o cliente (gate da consolidação / lookup no inbound)
create index if not exists quotes_awaiting_clarif_idx
  on quotes (order_id) where clarification_status = 'awaiting_user';
create index if not exists consultation_quotes_awaiting_clarif_idx
  on consultation_quotes (consultation_id) where clarification_status = 'awaiting_user';
