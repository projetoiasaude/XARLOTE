-- ─────────────────────────────────────────────────────────────────────────────
-- Fase 1 observabilidade em escala: TTL no firehose (system_logs) + índices.
-- audit_log e event_log NÃO são tocados (audit = retenção legal pra sempre;
-- event_log bruto vira agregado no daily_metrics na Fase 2).
-- ─────────────────────────────────────────────────────────────────────────────

-- Índices que faltavam no system_logs (firehose):
--   1) stream de críticos: filtra só warn/error/critical por tempo
create index if not exists system_logs_level_recent_idx
  on public.system_logs (created_at desc)
  where level in ('warn', 'error', 'critical');
--   2) drill-down por usuário
create index if not exists system_logs_user_idx
  on public.system_logs (user_id, created_at desc)
  where user_id is not null;
--   3) filtro por categoria (ator)
create index if not exists system_logs_category_idx
  on public.system_logs (category, created_at desc);

-- Função de poda por nível. Mantém erros mais tempo que info.
-- Não mexe em audit_log/event_log. Idempotente, segura pra rodar todo dia.
create or replace function public.prune_system_logs()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_deleted integer := 0;
  v_count   integer;
begin
  -- debug: 7 dias (defensivo — hoje não há debug, mas se passar a haver já cobre)
  delete from public.system_logs
   where created_at < now() - interval '7 days' and level = 'debug';
  get diagnostics v_count = row_count; v_deleted := v_deleted + v_count;

  -- info: 30 dias (a maior parte do volume)
  delete from public.system_logs
   where created_at < now() - interval '30 days' and level = 'info';
  get diagnostics v_count = row_count; v_deleted := v_deleted + v_count;

  -- warn: 90 dias
  delete from public.system_logs
   where created_at < now() - interval '90 days' and level = 'warn';
  get diagnostics v_count = row_count; v_deleted := v_deleted + v_count;

  -- error/critical/desconhecido: 180 dias
  delete from public.system_logs
   where created_at < now() - interval '180 days'
     and level not in ('debug', 'info', 'warn');
  get diagnostics v_count = row_count; v_deleted := v_deleted + v_count;

  -- registra a própria poda (observabilidade da observabilidade)
  if v_deleted > 0 then
    insert into public.system_logs (level, category, message, metadata)
    values ('info', 'retention',
            'prune_system_logs removeu ' || v_deleted || ' linhas',
            jsonb_build_object('deleted', v_deleted));
  end if;

  return v_deleted;
end;
$$;

-- Função de manutenção: não exposta a clientes (segue o padrão do hardening 0008)
revoke all on function public.prune_system_logs() from public;
revoke execute on function public.prune_system_logs() from anon, authenticated;

comment on function public.prune_system_logs() is
  'Fase 1 retenção: poda system_logs por nível (info 30d, warn 90d, error 180d). Agendada via pg_cron.';
