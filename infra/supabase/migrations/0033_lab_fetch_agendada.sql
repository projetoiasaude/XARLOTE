-- 0033 — Busca de exames AGENDADA + acesso cifrado na linha + exame ligado ao arquivo.
-- (docs/PLANO_EXAMES_LAB.md, "v2 — 21/09/2026", caso Ciro)
--
-- O que muda e por quê:
--   1. `lab_fetches` passa a poder esperar: `scheduled_for` + status 'agendada'. Um poller no
--      worker enfileira o que venceu (mesmo desenho do reminder-dispatcher: sobrevive a deploy,
--      nada se perde se o Redis reiniciar, é consultável e cancelável).
--   2. O acesso ao portal (login/senha/protocolo/nascimento) fica CIFRADO na linha
--      (`credenciais_cifradas`, AES-256-GCM com a chave do ambiente — lib/lab-vault.ts) SÓ
--      enquanto a busca está pendente ('reconhecendo'/'agendada'/'na_fila'/'rodando'), e é
--      APAGADO ao terminar. A 0032 dizia "sem credencial no Postgres" porque só existia busca
--      imediata; uma busca daqui a 5 dias precisa que o acesso exista em algum lugar até lá —
--      e cifrado no Postgres é mais seguro que em texto no Redis. A promessa que fica de pé:
--      nunca em claro, nunca depois da busca.
--   3. 'reconhecendo': o worker abre o portal SEM digitar nada e confirma que sabe entrar;
--      só então a pessoa ouve "dia X eu entro lá". 'cancelada': a pessoa desistiu.
--   4. `user_exam_results.media_id`: o resultado aponta pro arquivo (app_media) — é o
--      "histórico de saúde" com o documento original ao lado dos números.

alter table lab_fetches
  add column if not exists scheduled_for        timestamptz,
  add column if not exists credenciais_cifradas text,
  add column if not exists portal_url           text,
  add column if not exists trace_id             text,
  add column if not exists campos               text[],
  add column if not exists reminder_id          uuid references reminders(id) on delete set null;

-- O check de status foi criado inline na 0032; o nome não é garantido — derruba pelo conteúdo.
do $$
declare r record;
begin
  for r in
    select conname from pg_constraint
     where conrelid = 'public.lab_fetches'::regclass
       and contype = 'c'
       and pg_get_constraintdef(oid) ilike '%status%'
  loop
    execute format('alter table lab_fetches drop constraint %I', r.conname);
  end loop;
end $$;
alter table lab_fetches add constraint lab_fetches_status_check
  check (status in ('reconhecendo', 'agendada', 'na_fila', 'rodando', 'concluida', 'parada', 'falhou', 'cancelada'));

-- O poller lê só isto: índice parcial, barato mesmo com milhares de linhas históricas.
create index if not exists lab_fetches_agendadas_idx on lab_fetches (scheduled_for)
  where status = 'agendada';

-- Pendentes por pessoa (pra listar no contexto do modelo e pra cancelar).
create index if not exists lab_fetches_pendentes_idx on lab_fetches (user_id)
  where status in ('reconhecendo', 'agendada', 'na_fila', 'rodando');

alter table user_exam_results
  add column if not exists media_id     uuid references app_media(id) on delete set null,
  add column if not exists lab_fetch_id uuid references lab_fetches(id) on delete set null,
  add column if not exists laboratorio  text;

comment on column lab_fetches.credenciais_cifradas is
  'AES-256-GCM (lab-vault). Só enquanto pendente; o worker apaga ao terminar. Nunca em claro.';
comment on column lab_fetches.campos is
  'Campos que o portal pediu no reconhecimento (login, senha, nascimento, cpf) — sem valores.';
