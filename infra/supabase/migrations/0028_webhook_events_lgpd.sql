-- 0028 — webhook_events: retenção + purga dirigida por titular (LGPD)
--
-- ## O problema
--
-- `webhook_events` guarda o payload CRU de cada webhook do WhatsApp — e payload cru leva
-- telefone, nome de perfil e, quando é mensagem de texto, o conteúdo. A tabela não tem
-- retenção nenhuma: nasceu em abril e nunca perdeu uma linha. Em 12/08/2026 estava com
-- 3.942 linhas e 12 MB, das quais **2.660 (67%) tinham mais de 30 dias** e nenhum uso.
--
-- São dois defeitos no mesmo lugar:
--
--   · **LGPD.** O apagamento a pedido do titular (`handlers/forget-me.ts`) não conseguia
--     tocar esta tabela: ela não tem `user_id`, e a única linkagem possível é o número
--     dentro do JSON — busca de texto em `jsonb`, que o PostgREST não expressa. Era o
--     buraco documentado que ficou aberto por falta de uma função SQL.
--
--   · **Escala.** 12 MB com 26 pacientes. Na ordem de 2.600 pacientes seriam >1 GB de
--     payload cru com PII, crescendo para sempre, sem ninguém pedindo. O custo de
--     consertar agora é uma migration; depois é uma migration numa tabela grande.
--
-- ## A decisão: 14 dias
--
-- Para que a tabela existe: (1) dedup por `external_event_id` — um provedor reentrega em
-- minutos, nunca em semanas; (2) finalizar o parser de ENTRADA do zpro contra payload
-- real, que é depuração de dias. Nenhum dos dois usos passa de duas semanas. Guardar
-- além disso é acumular PII sem finalidade, o que a LGPD chama de excesso (art. 6º, III).
--
-- A retenção é o que torna a purga dirigida VIÁVEL: com a janela limitada, o
-- `raw::text like` varre centenas de linhas, não milhões. É por isso que as duas coisas
-- vêm juntas nesta migration, e não em duas.

-- ── Índice para a poda ────────────────────────────────────────────────────────
-- A tabela só tinha índice na PK e na chave de dedup. Sem isto a poda diária faria seq
-- scan — barato hoje, caro exatamente quando passar a importar.
create index if not exists webhook_events_received_idx
  on public.webhook_events (received_at);

-- ── Poda por idade ────────────────────────────────────────────────────────────
-- Mesma forma de `prune_system_logs` (0011): devolve a contagem e registra em
-- system_logs só quando removeu algo, para não poluir o log com "removi 0" diário.
create or replace function public.prune_webhook_events()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_deleted integer;
begin
  delete from public.webhook_events
   where received_at < now() - interval '14 days';
  get diagnostics v_deleted = row_count;

  if v_deleted > 0 then
    insert into public.system_logs (level, source, message, context)
    values ('info', 'lgpd',
            'prune_webhook_events removeu ' || v_deleted || ' payloads crus',
            jsonb_build_object('deleted', v_deleted, 'retention_days', 14));
  end if;

  return v_deleted;
end;
$$;

comment on function public.prune_webhook_events() is
  'Poda payloads crus de webhook com mais de 14 dias. Payload cru contém PII (telefone, '
  'nome de perfil, conteúdo da mensagem) e só tem uso operacional de curto prazo: dedup '
  'por external_event_id e depuração do parser de entrada. Guardar além disso é acúmulo '
  'sem finalidade (LGPD art. 6º, III).';

-- ── Purga dirigida a um titular ───────────────────────────────────────────────
-- Recebe TODAS as variantes de dígitos do telefone (com e sem o 9º dígito) numa chamada,
-- em vez de uma chamada por variante: a purga acontece dentro de um pedido de exclusão,
-- e cada ida ao banco é uma janela em que a operação pode falhar pela metade.
--
-- `raw::text` e não um operador de jsonb: o número aparece em profundidades e chaves
-- diferentes conforme o provedor (zpro e uazapi têm shapes distintos, e o de ENTRADA do
-- zpro é não-documentado). Procurar no texto inteiro é o único jeito de não depender de
-- um shape que a gente não controla — e a retenção de 14 dias é o que mantém isso barato.
create or replace function public.purge_webhook_events_for_phone(p_digits text[])
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_deleted integer;
  v_valid   text[];
begin
  -- Barra entrada curta: um `like '%55%'` apagaria o webhook de todo mundo. Telefone BR
  -- em E.164 tem 12 ou 13 dígitos; 10 é o piso defensivo para números estrangeiros.
  select array_agg(d) into v_valid
    from unnest(coalesce(p_digits, array[]::text[])) as d
   where d ~ '^[0-9]{10,15}$';

  if v_valid is null or array_length(v_valid, 1) = 0 then
    raise exception 'purge_webhook_events_for_phone: nenhum dígito válido em %', p_digits;
  end if;

  delete from public.webhook_events w
   where exists (
     select 1 from unnest(v_valid) as d
      where w.raw::text like '%' || d || '%'
   );
  get diagnostics v_deleted = row_count;

  return v_deleted;
end;
$$;

comment on function public.purge_webhook_events_for_phone(text[]) is
  'Apaga os payloads crus de webhook que mencionam o telefone do titular. Chamada pelo '
  'fluxo de apagamento LGPD (handlers/forget-me.ts), que não consegue alcançar esta '
  'tabela por PostgREST: ela não tem user_id e a linkagem é o número dentro do jsonb. '
  'Exige 10-15 dígitos por variante — entrada curta apagaria dado de terceiros.';

-- Só o service role executa (é o backend que apaga). `anon`/`authenticated` não têm
-- nada a fazer aqui, e uma função com security definer aberta ao anon seria um buraco
-- maior do que o que ela fecha.
revoke all on function public.prune_webhook_events() from public, anon, authenticated;
revoke all on function public.purge_webhook_events_for_phone(text[]) from public, anon, authenticated;

-- ── A poda NÃO está agendada, e o motivo importa ──────────────────────────────
--
-- Eu agendei, e desagendei no mesmo dia. A premissa era que `webhook_events` fosse uma
-- SEGUNDA CÓPIA do que já está em `messages`. O fundador questionou ("não é histórico das
-- pessoas?") e a checagem provou que ele estava certo: comparando por TEXTO, 187
-- mensagens de entrada não tinham linha em `messages` — 94 delas de 4 pacientes
-- cadastrados, da era do uazapi (abr–mai), quando o leitor de entrada falhava.
-- 185 seriam apagadas na primeira execução.
--
-- A migration 0029 recuperou as 94 que tinham dono identificável. Restam ~93 sem
-- telefone no payload ou de números que nunca viraram paciente.
--
-- `prune_webhook_events()` continua existindo e NÃO roda sozinha. Antes de agendá-la,
-- duas condições: (1) provar que não há mais mensagem cuja única cópia esteja aqui, e
-- (2) decisão explícita do fundador sobre o prazo. A função de purga por titular
-- (`purge_webhook_events_for_phone`) é outra coisa e SEGUE ativa — ela só roda quando
-- alguém pede o apagamento da própria conta, e aí apagar é o objetivo.
--
-- Para agendar, quando for o caso:
--   select cron.schedule('prune-webhook-events', '20 3 * * *',
--                        $$select public.prune_webhook_events();$$);
