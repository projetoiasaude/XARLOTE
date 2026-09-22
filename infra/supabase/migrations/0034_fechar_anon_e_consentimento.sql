-- 0034 — Fecha a leitura anônima, torna o bucket de mídia privado e solta a FK que
--        quebrava o apagamento LGPD.
--
-- Contexto: auditoria de 22/09/2026 (docs/auditoria-2026-09-22/), P0-2 e P0-3.
--
-- ⚠️ ORDEM DE APLICAÇÃO. As partes 1 e 2 tiram o acesso que o `/app` do WEB usava.
-- Aplicar DEPOIS de publicar:
--   • o bloqueio do `/app` no `apps/web/middleware.ts` (rewrite → /app-encerrado), e
--   • o desligamento das rotas legadas da API (`LEGACY_APP_ROUTES` ausente em produção).
-- Aplicar antes disso deixaria o web do paciente quebrado em vez de fechado.
--
-- A parte 3 é independente e pode ir a qualquer momento.
--
-- ⚠️ EFEITO COLATERAL CONHECIDO: o `/simulator` do dashboard e a aba de atividade do
-- `/app` web escutam o realtime do Supabase com a chave ANÔNIMA. Sem as policies, esses
-- painéis param de receber evento em tempo real (o simulador já responde 404 na API em
-- produção; a tela do `/app` está sendo fechada). Nenhum paciente perde função.
--
-- Reversão: as policies anônimas estão no fim do arquivo, comentadas, exatamente como
-- existiam. Ninguém deveria precisar — mas um rollback às cegas é pior que um documentado.

-- ─── 1. Nenhuma tabela é legível pela chave ANÔNIMA ──────────────────────────
--
-- As policies `anon_read_*` (`using (true)`) foram criadas à mão, nunca entraram em
-- migration, e continuavam vivas: com a anon key que está no bundle público do web,
-- qualquer pessoa lia `users` (telefone, CPF, nascimento, contato de emergência),
-- `messages` (todas), `orders` (endereço e lat/lng) e `quotes` (chave Pix) — e ainda
-- assinava o realtime de `messages`.
--
-- O `do $$` varre por PAPEL em vez de listar nomes: o que precisa sumir é "qualquer
-- policy que dê acesso ao anon", não sete nomes que alguém pode ter mudado.
do $$
declare r record;
begin
  for r in
    select policyname, tablename
    from pg_policies
    where schemaname = 'public' and roles @> '{anon}'
  loop
    execute format('drop policy if exists %I on public.%I', r.policyname, r.tablename);
    raise notice 'policy anônima removida: % em %', r.policyname, r.tablename;
  end loop;
end $$;

-- Cinto e suspensório: sem GRANT, uma policy nova criada por engano não basta pra abrir.
revoke all on all tables in schema public from anon;
revoke all on all sequences in schema public from anon;
alter default privileges in schema public revoke all on tables from anon;

-- ─── 2. Bucket de mídia do WhatsApp deixa de ser público ─────────────────────
--
-- `xarlote-media` guarda foto de receita, laudo e PDF que o paciente manda. Foi criado
-- à mão como `public` e nunca apareceu em migration nenhuma — uma URL adivinhável de
-- laudo, sem assinatura e sem expiração. O código já serve tudo por URL assinada de 10
-- minutos (`handlers/media-host.ts`), então nada quebra ao fechar.
--
-- `xarlote-audio` fica público DE PROPÓSITO nesta migration: o zpro só envia áudio por
-- URL pública e o arquivo é a fala da própria Xarlote. A poda por idade é item separado.
update storage.buckets set public = false where id = 'xarlote-media';

-- ─── 3. A prova do consentimento não pode travar o apagamento ────────────────
--
-- `consent_events.evidence_message_id` aponta pra mensagem em que a pessoa autorizou
-- algo (ex.: a busca no portal do laboratório) e a FK era `ON DELETE NO ACTION`. Como
-- `consent_events` é PRESERVADO de propósito (é a prova de conformidade), o apagamento
-- LGPD batia na FK ao deletar as mensagens e parava no meio: o titular ficava
-- meio-apagado, com telefone e mensagens intactos. Acontecia com qualquer paciente que
-- já tivesse usado a frente de exames.
--
-- `set null` preserva a prova (evidence_text e policy_version continuam na linha) e
-- deixa o apagamento seguir. Derrubamos a constraint pelo CONTEÚDO, não pelo nome:
-- drop por nome passa em silêncio quando o nome mudou (incidente 21/08).
do $$
declare r record;
begin
  for r in
    select conname
    from pg_constraint
    where conrelid = 'public.consent_events'::regclass
      and contype = 'f'
      and pg_get_constraintdef(oid) ilike '%evidence_message_id%'
  loop
    execute format('alter table public.consent_events drop constraint %I', r.conname);
  end loop;
end $$;

alter table public.consent_events
  add constraint consent_events_evidence_message_id_fkey
  foreign key (evidence_message_id) references public.messages(id) on delete set null;

-- ─── ACEITAÇÃO (rodar depois de aplicar) ─────────────────────────────────────
--   select count(*) from pg_policies where schemaname='public' and roles @> '{anon}';
--     → 0
--   select id, public from storage.buckets where id in ('xarlote-media','xarlote-audio');
--     → xarlote-media = false
--   select confdeltype from pg_constraint
--    where conrelid='public.consent_events'::regclass and conname='consent_events_evidence_message_id_fkey';
--     → 'n'  (SET NULL)
--
-- ─── REVERSÃO (se e só se o `/app` do web precisar voltar ao ar) ──────────────
--   create policy anon_read_users on public.users for select to anon using (true);
--   create policy anon_read_messages on public.messages for select to anon using (true);
--   create policy anon_read_conversations on public.conversations for select to anon using (true);
--   create policy anon_read_orders on public.orders for select to anon using (true);
--   create policy anon_read_quotes on public.quotes for select to anon using (true);
--   create policy anon_read_suppliers on public.suppliers for select to anon using (true);
--   create policy anon_read_system_logs on public.system_logs for select to anon using (true);
--   grant select on all tables in schema public to anon;
--   update storage.buckets set public = true where id = 'xarlote-media';
