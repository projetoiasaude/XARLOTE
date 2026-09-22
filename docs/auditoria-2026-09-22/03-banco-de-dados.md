# Banco de dados (schema, índices, RLS, integridade, LGPD no banco)

> Relatório integral do especialista (auditoria read-only de 21–22/09/2026, base `b981a3d`). Consolidação e priorização cruzada em [`00-CONSOLIDADO.md`](00-CONSOLIDADO.md).

---

# Auditoria READ-ONLY do banco — Xarlote (Supabase `niqmxiybiwrfkvdfojcq`)

**Escopo verificado:** 33 migrations + `schema.sql`, `packages/db/src/*`, `apps/api/src/lib/{messages-cursor,app-overview,app-export,lgpd-plan}.ts`, 935 call-sites `.from('…')` em `apps/api/src` (mapeados por 3 varreduras: turno do paciente, workers, forget-me/storage/web) e metadados reais de produção via MCP (`pg_policies`, `pg_stat_user_tables`, `pg_stat_user_indexes`, `pg_stat_statements`, `information_schema.columns`, `pg_constraint`, `pg_trigger`, `storage.buckets`, `cron.job`, advisors). **Nenhuma linha de tabela de paciente foi lida; nada foi escrito.**

## 1. Visão geral

O banco é pequeno (51 MB, 33 usuários, ~5k mensagens, PG 17.6, `max_connections=60`) e o esquema é, no geral, bem desenhado: `timestamptz` em tudo, `numeric` em preço, enums de verdade nas tabelas centrais, RLS ligada em 100% das tabelas, chaves de sessão/OTP/convite guardadas só por hash, índices parciais bem pensados nos pollers, keyset pagination correta no app, idempotência de webhook por `unique(provider,instance,external_event_id)` + `messages_external_idx`, e o claim de lembrete com compare-and-swap real. O problema não é a modelagem, é o que ficou **fora das migrations** e o que **falha em silêncio**.

Os achados graves: (1) **as sete policies `anon_read_*` com `using (true)` continuam vivas em produção** — com a anon key que está no bundle público de `xarlote.com.br/app`, qualquer pessoa lê `users` (telefone, CPF, nascimento, contato de emergência), `messages`, `orders` (endereço/lat-lng) e `quotes` (Pix), e assina realtime de `messages`; (2) **o forget-me quebra por FK** para qualquer paciente que já autorizou busca de exame (o consentimento aponta para uma `messages` com `ON DELETE NO ACTION`) e **apaga mensagens de terceiros em fios de clínica**; (3) o **export LGPD entrega `registro_de_acessos` e `acoes_automaticas` sempre vazios** porque seleciona colunas que não existem; (4) o bucket **`xarlote-media` (fotos de receita/exame) é público**; (5) o **compactor de conversas nunca avança** além do primeiro lote; (6) drift entre repo e produção (`query_user_360`, enum `order_status_t`, migrations 0008–0010 e 0027 inexistentes, buckets e policies criados à mão) e ausência de tipos gerados — que é exatamente o que deixou (3) passar.

Sob carga, o padrão dominante é **polling**: 77% das 4,03 M requisições PostgREST desde 10/04 são pollers de 10–30 s devolvendo 0 linhas, e o realtime consome 54% do tempo de CPU do banco. Crescimento estimado hoje: ~2–3 MB por paciente-ano, dominado por `webhook_events` (14 MB, sem poda e com a função de poda quebrada) e pelo `raw_payload` duplicado em `messages`.

## 2. Achados

### P0

**1. Policies `anon_read_*` (`using (true)`) em 7 tabelas + anon key pública = prontuário aberto** · SEGURANÇA/LGPD
- Evidência: `pg_policies` (prod) → `anon_read_users`, `anon_read_messages`, `anon_read_conversations`, `anon_read_orders`, `anon_read_quotes`, `anon_read_suppliers`, `anon_read_system_logs`, todas `roles={anon}`, `cmd=SELECT`, `qual=true`; `role_table_grants` mostra `anon` com SELECT em todas as tabelas de `public`. Chave no bundle: `apps/web/lib/supabase.ts:1-9` (`'use client'` + `NEXT_PUBLIC_SUPABASE_ANON_KEY`); `/app` é rota pública: `apps/web/middleware.ts:52,67`; leitura direta por JID vindo do cliente: `apps/web/lib/xarlote/use-chat.ts:56-80` e realtime em `messages` `:110-133`. Publicação realtime inclui `messages`, `users`… (`pg_publication_tables`). Risco reconhecido e adiado: `PROJECT_STATE.md:217`; `0024_app_auth.sql:6` ("migration 0027… após o cutover"); a 0027 não existe no repo.
- Cenário: `curl "$SUPABASE_URL/rest/v1/messages?select=*" -H "apikey: <anon do bundle>"` devolve as ~4.900 mensagens de todos os pacientes; idem `users` (CPF, nascimento, `emergency_contact_phone_e164`), `orders` (`delivery_address`, lat/lng), `quotes` (`pix_key`). Um websocket com a anon key recebe cada mensagem nova em tempo real.
- Correção (idempotente; aplicar **depois** de trocar `use-chat.ts` para `GET /app/messages` + `routes/app/stream.ts`, que já existem):
  ```sql
  -- 0034_drop_anon_read.sql
  do $$ declare r record; begin
    for r in select policyname, tablename from pg_policies
              where schemaname='public' and roles @> '{anon}' loop
      execute format('drop policy if exists %I on public.%I', r.policyname, r.tablename);
    end loop; end $$;
  revoke all on all tables in schema public from anon;
  alter default privileges in schema public revoke all on tables from anon;
  -- aceitação: select count(*) from pg_policies where schemaname='public' and roles @> '{anon}'; -- = 0
  ```
- Esforço: migration trivial; cutover do `/app` web (2 arquivos) médio. Confiança: **alta**.

### P1

**2. Forget-me falha por FK para quem autorizou busca de exame** · BUG / LGPD
- Evidência: `apps/api/src/handlers/tool-executor.ts:3141-3144` grava `consent_events.evidence_message_id = ctx.inboundMsg.id`; FK em prod: `consent_events_evidence_message_id_fkey … REFERENCES messages(id)` com `ON DELETE NO ACTION` (`pg_constraint`; origem `schema.sql:350`); o apagamento faz `messages.delete().in('conversation_id', …)` e **lança** em erro (`apps/api/src/handlers/forget-me.ts:213-214`); `consent_events` é `preservar` (`lib/lgpd-plan.ts:163-169`), então a linha nunca sai.
- Cenário: o primeiro paciente real da frente de exames pede "CONFIRMO APAGAR". Passos 1–2 apagam tabelas clínicas; passo 3 falha com 23503; o job (`attempts: 5`) morre; fios de fornecedor, memória, conversas, purga de webhook, storage e anonimização (passos 4–8) nunca rodam. Fica um paciente meio-apagado, com telefone e mensagens intactos, e o `user.forget_me.incomplete` nem é gravado (o throw é antes). `verify-forget-me.ts` não cria consentimento com `evidence_message_id`, por isso nunca pegou.
- Correção:
  ```sql
  do $$ declare r record; begin
    for r in select conname from pg_constraint where conrelid='public.consent_events'::regclass
             and contype='f' and pg_get_constraintdef(oid) ilike '%evidence_message_id%' loop
      execute format('alter table public.consent_events drop constraint %I', r.conname); end loop; end $$;
  alter table public.consent_events add constraint consent_events_evidence_message_id_fkey
    foreign key (evidence_message_id) references public.messages(id) on delete set null;
  ```
  (a prova do consentimento continua em `evidence_text`/`policy_version`). Esforço: baixo. Confiança: **alta**.

**3. Forget-me apaga mensagens de OUTROS pacientes em fios de clínica** · BUG / LGPD (terceiros)
- Evidência: `forget-me.ts:229-237` conta "outros pacientes" só por `quotes.conversation_id → orders.user_id`; fios de clínica são ligados por `consultation_quotes` (coletados em `:142-148`), que não têm `quotes` → `outrosPacientes = 0` → `destinoDoFio(0) = 'apagar_mensagens'` (`lgpd-plan.ts:314-317`) → `delete().eq('conversation_id', fio)` (`:243`).
- Cenário: clínica X atendeu 3 pacientes no mesmo número; um deles pede apagamento → o histórico da clínica com os outros 2 some.
- Correção: no passo 4, contar também `consultation_quotes.consultation_id → consultations.user_id` para o fio; adicionar teste com 2 titulares em `consultation_quotes`. Esforço: baixo. Confiança: **alta**.

**4. Forget-me não é retomável e engole falhas de Storage** · RISCO / LGPD
- Evidência: falha do RPC `purge_webhook_events_for_phone` só é anotada (`forget-me.ts:296-304`), o fluxo segue e **anonimiza `users`** (`:322-333`, `phone_e164 = deleted-<id>`) antes de lançar (`:372-375`); no retry, `brPhoneVariants` não tem mais telefone. `storage.remove` ignora `error` (`:311-319`, `if (!error)`), e os paths de arquivo vêm de linhas (`app_media`, `messages`, `app_exports`) apagadas nos passos 2–3 (`:150-163`) — a remoção só acontece no passo 7. Sem transação/RPC: ~40 chamadas PostgREST sequenciais.
- Correção: (a) persistir no job as variantes do telefone e os paths de storage antes do passo 2; (b) remover arquivos ANTES de apagar as linhas que os referenciam, e tratar erro de Storage como "sobra" (retry); (c) anonimizar `users` só depois de tudo o que depende do telefone. Esforço: médio. Confiança: alta.

**5. Export LGPD devolve `registro_de_acessos` e `acoes_automaticas` sempre vazios** · BUG / LGPD
- Evidência: `apps/api/src/lib/app-export.ts:147` seleciona/ordena `created_at` em `audit_log`, que só tem `occurred_at` (`information_schema` prod; `0002:22-64`); `:151` seleciona `created_at` em `assistant_tasks`, que tem `started_at/completed_at` (`schema.sql:223-235`). O PostgREST devolve erro de coluna e `safe()` (`:52-59`) converte em `null` → `[]`. O próprio código avisa desse modo de falha em `app-overview.ts:93-98`.
- Correção: `occurred_at` / `started_at`; e o item 19 (tipos gerados) para não repetir. Esforço: trivial. Confiança: **alta**.

**6. Bucket `xarlote-media` é PÚBLICO (fotos de receita/exame); `xarlote-audio` público com conteúdo clínico, sem poda e invisível ao forget-me** · SEGURANÇA/LGPD
- Evidência: `storage.buckets` (prod): `xarlote-media public=true` (40 objetos, 12 MB, `image/*|application/pdf`), `xarlote-audio public=true` (29 objetos); nenhuma policy em `storage.objects`. O código já assume privado e pede a migration: `apps/api/src/handlers/media-host.ts:29-34`. Áudio: `audio-host.ts:3-4` diz "sem PII", mas o arquivo é a resposta falada da Xarlote (`outbound.ts:199-212`, `transcript: text`), servido por `getPublicUrl` sem expiração (`:32`), path nunca gravado em `messages` → o forget-me não o encontra (`forget-me.ts:39` só cobre 3 buckets) e não há poda.
- Correção: `update storage.buckets set public = false where id = 'xarlote-media';` (signed URLs já são usadas em todos os leitores). Para o áudio: gravar `media_storage_path` na linha de `messages` do áudio e podar por idade (cron: `delete from storage.objects where bucket_id='xarlote-audio' and created_at < now()-interval '7 days'`), já que o zpro só precisa da URL no momento do envio. Esforço: baixo. Confiança: **alta**.

**7. Compactor de conversas nunca avança do primeiro lote (e custa 50 `COUNT(*)`/hora)** · BUG
- Evidência: `apps/api/src/workers/conversation-compactor.worker.ts:67-72` lê sempre as **30 mais antigas** (`order created_at asc limit 30`), filtra `raw_payload.compacted_at` em memória (`:75-79`) e `continue` se `< 10`; `KEEP_RECENT = 20` (`:20`) nunca é usado; cada candidata custa um `count: 'exact'` (`:58-61`). `pg_stat_statements`: 53.845 chamadas do COUNT e 16.808 do select com `raw_payload` — trabalho repetido a cada hora sem efeito. A marcação é um RMW por mensagem em `raw_payload` (`:119-121`).
- Correção: coluna própria e índice parcial:
  ```sql
  alter table public.messages add column if not exists compacted_at timestamptz;
  create index concurrently if not exists messages_uncompacted_idx
    on public.messages (conversation_id, created_at) where compacted_at is null;
  ```
  e a query passa a `.is('compacted_at', null)` excluindo as 20 mais novas; substituir o COUNT por `select count(*) filter (where compacted_at is null)` agregado por conversa (uma query). Esforço: baixo. Confiança: **alta**.

**8. Lost update em JSONB entre API e workers (`users.metadata`, `conversations.memory_cards`, `consultations.preferences`, `reminders.payload`)** · RISCO SOB CARGA / BUG
- Evidência: `reminder-dispatcher.worker.ts:690,751,926` escrevem `{...uMeta}` com snapshot do **início do tick** (`:142-148`), sem CAS — com 2 lembretes do mesmo paciente no tick, o 2º sobrescreve o 1º; `:1060` promete "só quem ganhou" mas o UPDATE é `.eq('id')` puro. `open-intent-chaser.worker.ts:99,129,157-159`; turno: `tool-executor.ts:486-488`, `inbound-user.ts:2784-2786` (snapshot de `:426`). `conversations.memory_cards`: `packages/db/src/memory.ts:170-184` roda **fora** do `withUserLock` com enricher `concurrency: 2`. `consultations.preferences` em 6 pontos (consultation-feedback `:72-76` também vira status sem CAS).
- Correção: uma RPC atômica em vez de read-modify-write no app:
  ```sql
  create or replace function public.users_metadata_merge(p_user_id uuid, p_patch jsonb, p_drop text[] default '{}')
  returns jsonb language sql security definer set search_path = public, pg_temp as $$
    update public.users set metadata = (coalesce(metadata,'{}'::jsonb) - p_drop) || coalesce(p_patch,'{}'::jsonb)
    where id = p_user_id returning metadata; $$;
  revoke all on function public.users_metadata_merge(uuid,jsonb,text[]) from public, anon, authenticated;
  ```
  (mesmo padrão para `preferences`/`payload`; para `memory_cards`, `jsonb_path`/append no SQL). Esforço: médio. Confiança: alta.

**9. Invariantes "um pedido ativo por paciente" / "uma conversa por JID" só protegidos por lock fail-open** · RISCO SOB CARGA
- Evidência: check-then-insert em `orders` (`tool-executor.ts:1049-1056` → `:1301`, e o comentário `:1071` "senão ficam 2 vivos"); `findOrCreateConversation` é SELECT + INSERT sem `onConflict` (`packages/db/src/queries.ts:41-69`); dedupe de `create_reminder` idem (`:2406-2414` → `:2511`). O lock de turno é fail-open em erro de Redis **e** em timeout (`inbound-user.ts:402-410`; `concurrency/user-lock.ts:60-63`).
- Correção (defesa em profundidade, o app trata 23505):
  ```sql
  create unique index concurrently if not exists orders_one_active_per_user
    on public.orders (user_id) where status in ('drafting','quoting','quoted','confirming');
  ```
  e `upsert(..., { onConflict: 'whatsapp_instance,whatsapp_jid', ignoreDuplicates: false })` em conversations. Esforço: baixo. Confiança: alta.

**10. `webhook_events` sem retenção (maior tabela) e `prune_webhook_events()` QUEBRADA** · RISCO / LGPD / BUG
- Evidência: 4.877 linhas / 14 MB (~2,9 KB por evento), `cron.job` só tem `prune-system-logs`; `0028_webhook_events_lgpd.sql:55-56` insere em `system_logs (level, source, message, context)` — `system_logs` só tem `level, category, message, metadata` (prod) → na primeira execução com `v_deleted > 0` a função lança `column "source" does not exist`. A purga por titular varre `raw::text like` a tabela inteira (`0028:100-104`) — barata só enquanto houver retenção. O mesmo payload ainda é duplicado em `messages.raw_payload` (`inbound-user.ts:460`).
- Correção: corrigir a função (`category`, `metadata`) e agendar (`cron.schedule('prune-webhook-events','20 3 * * *', $$select public.prune_webhook_events();$$)`) — as 94 mensagens órfãs recuperáveis já foram tratadas na 0029, as ~93 restantes não têm dono. Estimativa: ~1,3 MB por paciente-ano só aqui; a 10k pacientes, ~13 GB/ano de PII crua. Esforço: baixo. Confiança: **alta**.

### P2

**11. 77% das requisições ao banco são pollers devolvendo 0 linhas** · OTIMIZAÇÃO / RISCO SOB CARGA
- Evidência (`pg_stat_statements` desde 10/04, 4,03 M chamadas PostgREST): `red_flag_pending` 961.992 (poll de 10 s, sem cron lock — `red-flag-escalator.worker.ts:17,51`), `consultations` ~550 k, `consultation_quotes` 326 k, `orders` ~495 k, `reminders` ~375 k, `conversations`+`users` 171 k (admin `/conversations`). `pg_stat_user_tables`: `consultations seq_scan=516.700`, `consultation_quotes 488.901`, `orders 345.830`, `reminders 220.665` — não há índice por `status` para esses filtros (só `(user_id,status)` e parciais específicas). Hoje custa 0,05–0,2 ms cada; cresce linearmente com pacientes × ticks.
- Correção: índices parciais por status (item 12) + trocar os pollers de 10–30 s por BullMQ delayed jobs (o lembrete já tem `next_run_at`; o red flag tem `expires_at`) ou pelo menos 60 s. Esforço: médio.

**12. Índices ausentes nas consultas quentes (53 FKs sem índice segundo o advisor)** · OTIMIZAÇÃO
- Evidência: `reminders` não tem índice algum por `user_id` (todas as leituras por paciente: `inbound-user.ts:809-814`, `app-overview.ts:62-66`, `routes/app/reminders.ts:374-547`, `tool-executor.ts:2406-2770`); `quotes` sem índice em `conversation_id`/`supplier_id` — hot path de cada mensagem de farmácia (`inbound-supplier.ts:159-164`, `:238-245`); `orders/consultations/consultation_quotes` sem `(conversation_id)`; `conversations` sem `(party_type, last_message_at)`; `messages` sem índice por `created_at` sozinho — `metrics-aggregator.worker.ts:95-100` (2×/h) e `anomaly-detector.worker.ts:284-293` (6×/h, `ilike` com wildcard inicial + `count: 'exact'`) varrem a tabela inteira; `consent_events`/`assistant_tasks` sem `user_id`.
- Correção (fora de transação, um por vez — ver `0022:40-44`):
  ```sql
  create index concurrently if not exists reminders_user_status_idx on public.reminders (user_id, status, next_run_at);
  create index concurrently if not exists quotes_conversation_idx on public.quotes (conversation_id, created_at desc);
  create index concurrently if not exists quotes_supplier_open_idx on public.quotes (supplier_id, created_at desc)
    where status in ('pending','contacting','negotiating');
  create index concurrently if not exists orders_status_created_idx on public.orders (status, created_at) where status in ('quoting','quoted');
  create index concurrently if not exists orders_conversation_idx on public.orders (conversation_id);
  create index concurrently if not exists consultations_status_created_idx on public.consultations (status, created_at);
  create index concurrently if not exists consultations_conversation_idx on public.consultations (conversation_id);
  create index concurrently if not exists consultation_quotes_status_idx on public.consultation_quotes (status, created_at);
  create index concurrently if not exists consultation_quotes_conversation_idx on public.consultation_quotes (conversation_id);
  create index concurrently if not exists conversations_party_last_msg_idx on public.conversations (party_type, last_message_at desc nulls last);
  create index concurrently if not exists messages_created_brin on public.messages using brin (created_at);
  create index concurrently if not exists consent_events_user_idx on public.consent_events (user_id, created_at desc);
  create index concurrently if not exists assistant_tasks_user_idx on public.assistant_tasks (user_id);
  ```
  Esforço: baixo.

**13. Realtime = 54% do tempo de CPU do banco, com publicação em 9 tabelas que ninguém assina** · OTIMIZAÇÃO
- Evidência: `realtime.list_changes` 741 k chamadas / 4.306 s de 7.917 s totais; `pg_publication_tables`: `consultation_quotes, consultations, conversations, medication_log, messages, orders, quotes, system_logs, treatments` (`schema.sql:449-453`, `0003:407-410`). O web só assina `messages` e `quotes` (`use-chat.ts:110-133`, `WhatsAppSim.tsx:136-214`, `app/atividade/page.tsx:175-195`); `system_logs` recebe 20 k inserts que o decodificador precisa filtrar.
- Correção: `alter publication supabase_realtime drop table public.system_logs, public.orders, public.conversations, public.consultations, public.consultation_quotes, public.treatments, public.medication_log;` (e, após o item 1, `messages` e `quotes` também — o app usa SSE em `routes/app/stream.ts`). Esforço: trivial.

**14. `select('*')` em linhas largas no caminho quente** · OTIMIZAÇÃO
- Evidência: histórico do LLM `packages/db/src/queries.ts:76-83` (`*` × 30 msgs, inclui `raw_payload` jsonb — o consumidor só usa 5 colunas, `packages/llm/src/utils/history.ts:48-73`); `memory.ts:219-224` `select('*')` em `memory_cards_index` **traz a coluna `embedding` (1536 floats ≈ 15–20 KB texto) × 8** em todo turno curto ("oi", "sim") ou quando o embed falha; admin `/conversations` `select('*, users(...)')` inclui `memory_cards` (até 200 cards) — 171 k chamadas, max 1.010 ms (`routes/admin.ts:159-168`); admin detalhe `messages.*` × 200 (`:171-186`, 59 k chamadas). Esforço: baixo.

**15. Dezenas de `await writeLog` por turno (insert síncrono em `system_logs`)** · OTIMIZAÇÃO
- Evidência: 71 sites em `inbound-user.ts` + 79 em `tool-executor.ts` (todos awaited; `queries.ts:149-162`); o INSERT custa 4,48 ms de servidor (`pg_stat_statements`, 20.122 chamadas) + RTT Railway→Supabase, com 5 índices em `system_logs` e a tabela na publicação realtime. 10–20 logs por turno ≈ 100–400 ms de latência só de log. Correção: buffer em memória com flush assíncrono em lote (`insert` de array), tirar da publicação, revisar `system_logs_trace_idx`/`category_idx` (baixo uso). Esforço: médio.

**16. Trilha de compliance apagável: `audit_log`/`event_log`/`consent_events` com `user_id … ON DELETE CASCADE` e sem proteção contra UPDATE/DELETE** · SEGURANÇA/LGPD
- Evidência: `0002:49,89`; `schema.sql:346`. Em prod, `audit_log` tem `n_tup_upd=37, n_tup_del=51` e `consent_events` `n_tup_del=79` (`pg_stat_user_tables`) — o "append-only" (`0002:12`) não é imposto. Hard deletes de `users` existem no código: `routes/admin.ts:691` (`/test/cleanup`), `routes/simulate.ts:178,206`, `inbound-user.ts:2839` (gated por `isSimulatorMode()`), `scripts/verify-forget-me.ts`; cada um leva a auditoria junto pelo cascade.
- Correção: FK `on delete restrict` em `audit_log.user_id`, `event_log.user_id`, `consent_events.user_id` (o forget-me anonimiza, nunca apaga — o restrict nunca dispara em produção) + trigger `before update or delete on audit_log … raise exception` com bypass via `current_setting('app.audit_maintenance', true) = 'on'` para reparos deliberados. Esforço: baixo.

**17. PII/dado clínico que sobrevive ao "CONFIRMO APAGAR"** · SEGURANÇA/LGPD — ver mapa na seção 4. Os pontos mais duros: `audit_log.metadata.text_preview` (120 chars de cada memory card, `packages/db/src/audit.ts:362-387`), `metadata.args` das tools (redação só por nome de chave — `medication_name`, `notes`, `evidence` de red flag passam), `consent_events.evidence_text` com 300 chars da fala (`tool-executor.ts:3143` — se a pessoa digitar "sim, senha 1234" no mesmo turno, a senha do portal fica para sempre) + `ip/user_agent` antigos, `otp_codes` (`phone_e164`, `request_ip`; sem `user_id`, sem poda — `0024:57` promete um cron que não existe). Correção: redigir `evidence_text` com `maskString` + anonimizar `metadata` de `audit_log` por `user_id` no forget-me (manter `action`/`occurred_at`), cron para `otp_codes` (`delete … where created_at < now()-interval '24 hours'`). Esforço: baixo/médio.

**18. Funções e policies: revokes ineficazes, recursão e `search_path` mutável** · QUALIDADE/SEGURANÇA (impacto baixo graças ao RLS)
- Evidência: `0031:62` revoga `match_user_memory` só de `anon`, mas o EXECUTE de `PUBLIC` continua (`has_function_privilege('anon', …)` = true em prod) — idem `query_user_360`, `calc_adherence_score`, `find_clinics`, `pharmacy_history`, `medications_running_low`; `rls_auto_enable()` é SECURITY DEFINER executável por anon/authenticated via `/rest/v1/rpc` (advisor); `is_staff()`, `set_updated_at`, `match_user_memory` sem `search_path` fixo; `staff_read_staff on staff_users using (is_staff())` é recursiva (`schema.sql:416-420,439`) e todas as 30+ policies `staff_read*` são código morto (`staff_users` tem 0 linhas); 19 policies com `auth.uid()` sem `(select …)` (advisor).
- Correção: `revoke execute on function … from public, anon, authenticated;` para todas as RPCs de domínio e `rls_auto_enable`; `alter function … set search_path = public, pg_temp`; ou remover as policies `staff_*` se o dashboard nunca vai usar Supabase Auth. Esforço: baixo.

**19. Drift repo × produção e ausência de tipos gerados** · QUALIDADE (é a causa-raiz do item 5)
- Evidência: `query_user_360` em prod usa `'onset_date', c.onset_date`; o repo (`0004:236-238`) usa `c.since` — coluna que não existe: **reaplicar a 0004 num ambiente novo quebra a RPC** (e `queryUser360` devolve `null` em silêncio, `user360.ts:86-95`). Enum `order_status_t` tem `completed` em prod, não em `schema.sql:26` nem em `packages/shared/src/types.ts:6`. Migrations 0008–0010 e 0027 não existem (`0011:65` cita "hardening 0008"); `anon_read_*`, buckets `xarlote-media`/`xarlote-audio` e `rls_auto_enable` só existem em prod. `packages/db/src/types.ts` (que o `CLAUDE.md` manda gerar) **não existe**; `createClient` sem generic `Database` (`client.ts:32-40`) → nomes de coluna não são checados em compile time.
- Correção: commitar um baseline `pg_dump --schema-only` como `0000_baseline.sql`, `supabase gen types typescript --linked` no CI com diff obrigatório, corrigir a 0004 e adicionar `alter type order_status_t add value if not exists 'completed'` numa migration. Esforço: médio.

**20. Locks de worker: TTL == intervalo e fail-open; `reconhecendo` órfão re-enfileirado sem claim** · RISCO SOB CARGA
- Evidência: `middleware/cron-lock.ts:38-56` (`SET NX PX interval`, chave por janela; erro de Redis → roda mesmo assim); red-flag-escalator sem lock (só CAS `:32-38`); `handlers/lab-fetch.ts:532-536` reenfileira `reconhecendo` > 2 min a cada minuto sem mudar status (dedupe só pelo `jobId`). Com uma 2ª réplica do worker, ticks longos e Redis instável geram duplicidade (o CAS do lembrete cobre o envio, mas os `writeLog`/`event_log`/nudges não). Correção: TTL = 2× intervalo + renovação, e `update … set status='reconhecendo_retry' where status='reconhecendo' returning id` como claim. Esforço: baixo.

**21. `created_at` usado como relógio de estado; `updated_at` órfão; `processed_at` nunca escrito** · QUALIDADE
- Evidência: `tool-executor.ts:1971`, `:2189` e `inbound-supplier.ts:221` reescrevem `orders.created_at = now()` (janelas de 24 h, export e métricas passam a mentir a data do pedido); `reminders.updated_at` existe mas não tem trigger (`pg_trigger` prod; `schema.sql:324-341`) e nenhum dos 10 updates a escreve; `webhook_events.processed_at` nunca é preenchido. Correção: coluna própria (`requoted_at`), trigger `set_updated_at` em `reminders`, remover ou usar `processed_at`. Esforço: baixo.

**22. Índices redundantes e mortos (incl. o ivfflat)** · OTIMIZAÇÃO
- Evidência (`pg_stat_user_indexes`): `memory_cards_embedding_idx` ivfflat 3,4 MB > tabela (2,5 MB), `idx_scan=0` — e **nunca poderá ser usado**: `match_user_memory` (`0031:42-56`) filtra por `user_id` num CTE e ordena por `1 - (embedding <=> q)` derivado, não por `embedding <=> q` direto; o scan exato por usuário está correto e é melhor. `users_phone_idx` duplica `users_phone_e164_key`; `messages_conv_created_idx` é prefixo de `messages_conv_created_id_idx`; `memory_cards_user_idx` é prefixo; `messages_undelivered_idx` (0022) não tem nenhum leitor (`grep delivered_at … .is(`: nenhum); +11 índices com 0 scans (advisor).
- Correção: `drop index concurrently if exists memory_cards_embedding_idx, users_phone_idx, messages_conv_created_idx, memory_cards_user_idx, messages_undelivered_idx;` Esforço: trivial.

**23. N+1 em workers** · OTIMIZAÇÃO
- Evidência: `nudge-stalled-flows.worker.ts:152-168` (1 query de `messages` com `raw_payload` por conversa, até 40, a cada 15 min); compactor (item 7); `knowledge-graph-builder.worker.ts:135-139` e `skill-extractor.worker.ts:138` (`quotes` por pedido); `reminder-dispatcher` ~12–15 round-trips por lembrete × 50 por tick (`:249-1069`); `tool-executor.ts:1475-1478` `count: 'exact'` por cotação, sem limite de tempo; `inbound-user.ts:2756-2761` COUNT sobre a conversa inteira. Correção: embeds PostgREST (`quotes(suppliers(*))`), `in(...)` em lote, `select … order … limit 1` via `distinct on` numa view. Esforço: médio.

### P3

**24. Cursor keyset com `id` não validado → injeção no `or=()` do PostgREST (auto-escopada)** · QUALIDADE — `lib/messages-cursor.ts:24-40` valida `createdAt` mas não `id`; interpolado em `routes/app/messages.ts:124-125` e `routes/app/reminders.ts:450-453`. O `.eq('conversation_id'/'user_id')` é um parâmetro separado, então o alcance é a própria conta; ainda assim, validar UUID (`^[0-9a-f-]{36}$`). Esforço: trivial.

**25. Tabelas sem retenção além das citadas** · QUALIDADE — `event_log` (3.630 linhas, cresce ~330/paciente-ano; `daily_metrics` já agrega), `assistant_tasks` (`tool_input/tool_output` jsonb com argumentos das tools), `app_sessions` revogadas, `care_invites` e `share_grants` expirados, `otp_codes` (item 17). Correção: uma `prune_operational()` no cron (180 d para `event_log`/`assistant_tasks`, 24 h `otp_codes`, 30 d sessões revogadas/convites expirados). Esforço: baixo.

## 3. Mapa consulta → índice (as mais quentes)

| # | Consulta (arquivo:linha) | Filtro / ordem | Índice | Veredito |
|---|---|---|---|---|
| 1 | `findUserByPhone` `queries.ts:8-12` (todo turno) | `phone_e164 =` | `users_phone_e164_key` | coberta (`users_phone_idx` redundante) |
| 2 | `findOrCreateConversation` `queries.ts:41-46` | `(whatsapp_instance, whatsapp_jid)` | `conversations_jid_instance_idx` | coberta |
| 3 | histórico LLM `queries.ts:76-83` / app `routes/app/messages.ts:105-125` | `conversation_id`, `created_at desc[, id desc]` | `messages_conv_created_id_idx` | coberta (`select *` = item 14) |
| 4 | `match_user_memory` `0031:42-56` | `user_id`, ordena por similaridade | `memory_cards_kind_idx`/`last_seen_idx` (prefixo) | coberta; ivfflat morto (item 22) |
| 5 | `query_user_360` `0004:222-351` (56 ms médio, 1.087 chamadas) | 12 subconsultas por `user_id` | uniq/parciais de cada tabela | coberta (custo = 12 agregações) |
| 6 | pedido ativo `inbound-user.ts:787-794`, `tool-executor.ts:1049-1056` | `user_id, status in (…), created_at desc` | `orders_user_status_idx` | coberta (ordem não, mas por usuário é pequeno) |
| 7 | lembretes do paciente `inbound-user.ts:809-814`, `app-overview.ts:62-66`, `routes/app/reminders.ts:374-547` | `user_id, status …, next_run_at` | **nenhum por `user_id`** | **não coberta** |
| 8 | lembretes vencidos `reminder-dispatcher.worker.ts:142-148` (30 s) | `status='pending' and next_run_at <= now` | `reminders_next_run_idx` (parcial) | coberta |
| 9 | red flag vencido `red-flag-escalator.worker.ts:21-26` (10 s, 962 k) | `status='pending' and expires_at <` | `red_flag_pending_expires_idx` | coberta (frequência = item 11) |
| 10 | cotações da farmácia `inbound-supplier.ts:159-164`, `:238-245` | `conversation_id` / `supplier_id + status in (…)` | **nenhum** (`quotes_order_idx` só por `order_id`) | **não coberta** (hot path da farmácia) |
| 11 | pollers de pedido `order-followup.worker.ts:116-121`, `quote-consolidation.ts:92-111` | `status='quoted'/'quoting' and created_at <` | só `orders_handed_off_followup_idx` (handed_off) | **não coberta** |
| 12 | pollers de consulta `consultation-consolidation.ts:68-73,158-163,390-395`, `consultation-dispatcher.worker.ts:53-60` | `status … and created_at/updated_at` | `consultations_user_status_idx` (user primeiro) | **não coberta** |
| 13 | ações recentes `inbound-user.ts:818-825` | `conversation_id, completed_at desc` | `assistant_tasks_conv_completed_idx` | coberta |
| 14 | conversas por janela `nudge-stalled-flows.worker.ts:152-160`, `anomaly-detector.worker.ts:149-155`, admin `:159-168` | `party_type, last_message_at` | **nenhum** | **não coberta** |
| 15 | métricas/anomalia em `messages` `metrics-aggregator.worker.ts:95-100`, `anomaly-detector.worker.ts:284-293` | `created_at between` / `direction + created_at + ilike` | **nenhum por `created_at`** | **não coberta** (varre a tabela) |
| 16 | dedupe webhook `webhook.zpro.ts:111-117` | insert com unique | `webhook_events_provider_instance_external_event_id_key` | coberta |
| 17 | busca agendada `handlers/lab-fetch.ts:514-519` (60 s) | `status='agendada' and scheduled_for <=` | `lab_fetches_agendadas_idx` | coberta (ainda 0 scans — tabela minúscula) |
| 18 | export/consentimento `app-export.ts:145`, `routes/app/consent.ts:36-40` | `consent_events.user_id …` | **nenhum** | **não coberta** |

## 4. Onde PII sobrevive ao "CONFIRMO APAGAR"

| Tabela / lugar | Coluna | Evidência | O que fica |
|---|---|---|---|
| `audit_log` (preservada de propósito) | `metadata` (`args` das tools, `text_preview` de memory cards, `phone` truncado, `name`), `reason`, `before/after` | `lgpd-plan.ts:156-162`; `audit.ts:283-328,362-387`; `routes/admin.ts:151`; `tool-executor-v2.ts:478` | fatos clínicos inferidos, nomes de remédio, nome preferido, `medication_name/notes` — redação só por nome de chave (`redact.ts:14-31`) |
| `consent_events` (preservada) | `evidence_text` (300 chars da fala), `ip`, `user_agent`, `evidence_message_id` | `tool-executor.ts:3143`; `schema.sql:350-353`; `forget-me.ts:328-333` | fala literal do titular (possível senha de portal), IP |
| `system_logs` (preservada, 30–180 d) | `message` (mascarada só por padrão: telefone/CPF/e-mail/geo), `metadata`, `user_id` | `lgpd-plan.ts:170-176`; `queries.ts:156-161`; `0011` | primeiros nomes, remédios, texto livre por até 180 d |
| `otp_codes` (não tem `user_id`; fora do plano) | `phone_e164`, `request_ip` | `0024:21-34`; `lgpd-plan.ts:47-82` não lista; sem cron | telefone + IP para sempre |
| `webhook_events` | `raw` (redigido por chave, mas texto da mensagem e chaves não previstas ficam; linhas de abr–mai pré-redação têm telefone) | `0028:3-19`; `0029:22-25`; `webhook.zpro.ts:111-117` | purga por titular só acha o que casa `like '%digitos%'` — se o RPC falhar, nunca mais (item 4) |
| Storage `xarlote-audio` | arquivos TTS (resposta falada) | `audio-host.ts:23-32`; `forget-me.ts:39` | público, sem poda, sem vínculo com o titular |
| Storage `xarlote-media` | mídia recebida em fios de fornecedor/clínica | `forget-me.ts:150-159` (só coleta das conversas do paciente) | receita/exame encaminhados à farmácia ficam |
| `messages` de fios compartilhados | `media_storage_path`, `raw_payload` das mensagens sem nome/telefone no texto | `forget-me.ts:251-271` (redige `content`/`transcript`, zera `raw_payload` só nas casadas) | número do remetente dentro de `raw_payload` |
| `messages` (todas) quando há consentimento de exame | tudo | item 2 (FK) | o apagamento inteiro para no passo 3 |
| Redis | jobs `outbound-whatsapp-*` concluídos (`phoneE164` + texto, últimos 1.000), `zpro:ticket:<phone>` 24 h, rate-limit | `queues/outbound.queue.ts:25-37,76-77`; `middleware/zpro-ticket.ts:14,21` | telefone + texto das últimas mensagens |
| `users` (anonimizada) | `id`, `timezone`, `account_kind`, `created_at`, `lgpd_consent_*` | `lgpd-plan.ts:199-242` | ok (sem PII) |

## 5. O que verifiquei e está OK

- RLS **ligada em todas as 44 tabelas** (`pg_class.relrowsecurity`), com event trigger `ensure_rls → rls_auto_enable` garantindo tabelas novas; tabelas sensíveis novas (`app_sessions`, `share_grants`, `care_*`, `lab_fetches`, `user_exam_results`, `otp_codes`, `device_tokens`) sem policy = só service role; `lab_fetches` além disso sem grant para anon.
- `service_role` só no backend (`packages/db/src/client.ts:30-43`, timeout de 15 s em toda chamada); web e mobile não têm a chave; o web só toca o Supabase nos 3 arquivos do item 1 — todo o admin passa pela API.
- Segredos de auth por hash: `otp_codes.code_hash+salt`, `app_sessions.refresh_hash` com rotação e detecção de reuso, `share_grants.token_hash`, `care_invites.code_hash` (0024/0026/0030); `credenciais_cifradas` AES-GCM só enquanto pendente, `campos` sem valores (0033).
- Idempotência de entrada: `webhook_events` unique + `messages_external_idx` (o `insertMessage` lança em 23505 antes do LLM) + `messages_app_external_uq` com `jobId = clientId`; claim de lembrete com CAS `(status, next_run_at)` (`reminder-dispatcher.worker.ts:271-277`); CAS em `orders` (`quote-consolidation.ts:470`, `tool-executor.ts:2836-2841`), `red_flag_pending`, `lab_fetches` agendadas, `consultations` cancel.
- Keyset pagination correta (`(created_at, id)`, índice `messages_conv_created_id_idx`, aspas no timestamp) no app e no export (páginas de 1.000, teto declarado).
- Tipos: `timestamptz` em 100% das colunas de tempo; `numeric` em preço/`price_brl`; enums em `messages`, `orders`, `quotes`, `reminders`, `consent_events`; `check` em `lab_fetches.status`, `app_media.kind`, `care_links`, `red_flag_pending`, `audit_log.actor_type` (com teste que compara TS × SQL); `updated_at` por trigger em 11 tabelas.
- Migrations 0032/0033 derrubam checks **pelo conteúdo** (não pelo nome) — o padrão certo depois do incidente de nome silencioso.
- `pg_cron` `prune-system-logs` ativo (04:00 UTC), `system_logs` estável em ~5 k linhas; `daily_metrics` upsert por `day`.
- Autovacuum em dia (dead tuples baixos); 8 conexões PostgREST ociosas de 60; sem `statement_timeout` estourando (max 1,0 s no pior query).
- `redactPII`/`maskString` preservam uuid/hex e não deixam telefone de 12–13 dígitos passar como token (regras comentadas em `redact.ts:33-72`).

## 6. Perguntas em aberto

1. **Cutover do `/app` web**: o mobile e as rotas `/app/*` com OTP já existem — o que ainda impede trocar `use-chat.ts` para a API e derrubar as `anon_read_*` hoje? (Item 1; o plano reserva `0037_drop_anon_read.sql`.)
2. Migrations **0008–0010** ("hardening") e **0027** foram aplicadas por MCP e nunca salvas? Existe algum outro DDL de prod fora do repo além de `anon_read_*`, `rls_auto_enable`, buckets e `order_status_t.completed`? Um `pg_dump --schema-only` comparado com o repo responde de vez.
3. Os **37 updates / 51 deletes em `audit_log`** e **79 deletes em `consent_events`** (desde 10/04): foram só `/test/cleanup`/reset de simulador, ou reparos manuais? Se reparos, qual a política — o trigger do item 16 precisa de um bypass explícito.
4. `xarlote-audio` público é decisão consciente (o zpro só aceita URL) — aceita-se **poda por idade** (24 h–7 d) e o registro do path na mensagem, para o forget-me alcançar?
5. Em fios compartilhados, o primeiro nome isolado fica de propósito (`lgpd-plan.ts:343-346`). E o número do remetente dentro de `raw_payload` das mensagens que não citam nome/telefone no texto — aceitável, ou zerar `raw_payload` do fio inteiro?
6. `assistant_tasks.tool_output` e `audit_log.metadata.args` guardam os argumentos das tools: qual a retenção pretendida para `assistant_tasks` (hoje infinita) e o forget-me deve anonimizar `metadata` da auditoria mantendo `action/occurred_at`?
7. `orders.created_at` reescrito em três lugares: as janelas de 24 h dependem disso de propósito? Se sim, vale uma coluna `requoted_at` para o export/métricas não perderem a data real.
8. Há intenção de rodar **2 réplicas do worker**? Se sim, os itens 8, 9 e 20 sobem de prioridade; se não, documentar "worker é singleton" no `start-all.ts`.

---

**Arquivos de apoio (só scratchpad, fora do repo):** `/private/tmp/claude-501/-Users-hiagovieira-IA-da-saude/90495a35-56cc-4b5e-af5f-c09ca0e2c7b7/scratchpad/agente-db/notas.md` (metadados brutos coletados) e `from_calls.txt` (dump dos 935 call-sites com contexto).
