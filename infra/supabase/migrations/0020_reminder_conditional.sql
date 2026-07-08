-- 0020 — Lembretes CONDICIONAIS (incidente Glauber 08/07): o usuário pediu por áudio
-- "creatina 9h30 + um backup ao meio-dia CASO EU NÃO CONFIRME que tomei". A Xarlote criou
-- o backup INCONDICIONAL (sempre dispara). Agora um lembrete-backup pode depender de outro
-- e só dispara se o primário NÃO foi confirmado desde o último disparo dele.
--
-- Registro da confirmação = timestamp por-lembrete. Regra do gate (no fuso do usuário):
--   pular_backup ⇔ primário confirmado HOJE (tz do user) E depois do último disparo dele
--                  (afterLastRun: last_run null OU last_confirmed >= last_run)
-- O "hoje" (não só ">= last_run") evita que uma confirmação de um dia com agenda divergente
-- (primário seg/qua/sex, backup diário) cale o backup num dia sem primário. Fail-safe:
-- qualquer null/indeterminado ⇒ dispara. O vínculo backup→primário vai no reminders.payload
-- jsonb já existente ({ condition:'if_not_confirmed', depends_on_title, depends_on_reminder_id }).
alter table reminders add column if not exists last_confirmed_at timestamptz;

comment on column reminders.last_confirmed_at is
  'Quando o usuário confirmou este lembrete pela última vez (respondeu "tomei" / botão done). Usado pelo gate de lembrete-backup condicional (só dispara se o primário não foi confirmado desde o último disparo).';
