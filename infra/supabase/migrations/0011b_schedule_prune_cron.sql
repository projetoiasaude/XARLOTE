-- Agenda a poda diária dentro do próprio banco (não depende do app estar de pé —
-- lição do bug do setTimeout da consulta que morria no restart).
create extension if not exists pg_cron;

-- 04:00 UTC = 01:00 BRT. Idempotente: cron.schedule faz upsert pelo nome do job.
select cron.schedule(
  'prune-system-logs',
  '0 4 * * *',
  $$select public.prune_system_logs();$$
);
