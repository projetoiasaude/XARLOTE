-- 0032 — Buscar exames no portal do laboratório (docs/PLANO_EXAMES_LAB.md).
--
-- Duas coisas, e o que NÃO está aqui importa tanto quanto o que está:
--
--   1. `lab_fetches`: o registro de cada busca — status, motivo de parada, contagens.
--      **Sem credencial.** A senha vive cifrada no job da fila pelos segundos que ele dura e
--      em lugar nenhum do Postgres. Esta tabela é auditoria e estado, não cofre.
--   2. `app_media.kind` ganha 'pdf': os resultados baixados vão para o mesmo bucket privado
--      das fotos e áudios, com o mesmo forget-me, em vez de nascer um armazenamento novo.

create table if not exists lab_fetches (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references users(id) on delete cascade,
  conversation_id  uuid references conversations(id) on delete set null,
  -- O nome como a visão leu no protocolo. Serve para escolher o adapter e para a mensagem.
  laboratorio      text,
  -- Qual adapter tentou — 'generico' hoje; um id específico quando existir.
  adapter          text,
  status           text not null default 'na_fila'
                   check (status in ('na_fila', 'rodando', 'concluida', 'parada', 'falhou')),
  -- Só preenchido em 'parada'/'falhou'. Espelha `MotivoParada` do código; texto livre aqui
  -- porque o conjunto vai crescer com cada portal novo e migration por enum é atrito.
  motivo           text,
  pdfs_baixados    integer not null default 0,
  exames_salvos    integer not null default 0,
  -- A autorização que permitiu esta busca — o gate de consentimento aponta para cá.
  consent_event_id uuid references consent_events(id) on delete set null,
  started_at       timestamptz,
  finished_at      timestamptz,
  created_at       timestamptz not null default now()
);

create index if not exists lab_fetches_user_idx on lab_fetches (user_id, created_at desc);

-- O rate limit por pessoa (3/dia) lê daqui; o índice parcial mantém a leitura barata.
create index if not exists lab_fetches_recentes_idx on lab_fetches (user_id, created_at desc)
  where status in ('na_fila', 'rodando', 'concluida');

alter table lab_fetches enable row level security;
-- Só o backend (service_role) escreve e lê. O app lê pelo resumo que a API monta.
revoke all on lab_fetches from anon, authenticated;

-- ── app_media aceita PDF ─────────────────────────────────────────────────────
-- O check original era inline: `kind text not null check (kind in ('image','audio'))`.
-- O NOME que o Postgres deu a ele não é garantido (`app_media_kind_check` é o padrão, mas
-- basta um rename ou uma criação diferente para mudar). Um `drop ... if exists` com nome
-- errado passa em silêncio, o check velho FICA, e o primeiro PDF do worker quebra em
-- produção. Então: localiza pelo CONTEÚDO (todo check de app_media que cite `kind`) e derruba.
do $$
declare r record;
begin
  for r in
    select conname from pg_constraint
     where conrelid = 'public.app_media'::regclass
       and contype = 'c'
       and pg_get_constraintdef(oid) ilike '%kind%'
  loop
    execute format('alter table app_media drop constraint %I', r.conname);
  end loop;
end $$;
alter table app_media add constraint app_media_kind_check check (kind in ('image', 'audio', 'pdf'));

comment on table lab_fetches is
  'Uma linha por busca de exames em portal de laboratório. Nunca contém credencial — ver docs/PLANO_EXAMES_LAB.md §3.';
