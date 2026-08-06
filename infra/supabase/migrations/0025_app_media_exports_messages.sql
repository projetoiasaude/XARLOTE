-- 0025 — Mídia do app (fotos de exame/receita + áudio), exports LGPD e índices do chat.
--
--   • app_media: upload do paciente ANTES de virar mensagem (o app faz POST /app/media,
--     recebe mediaId, e então POST /app/messages {kind:'image'|'audio', mediaId}).
--     Bucket privado — leitura só via signed URL emitida pela API a quem é dono.
--   • app_exports: job assíncrono do "exportar meus dados" (LGPD Art. 18 II/V) —
--     o export atual era um dump client-side SEM as mensagens; o novo inclui TUDO.
--   • Índice keyset (conversation_id, created_at desc, id desc): paginação do chat que
--     custa o mesmo na página 1 e na 1000 (nunca OFFSET).
--   • Índice único parcial em external_id 'app-%': idempotência do envio pelo app —
--     o worker que processa a fila pode re-executar sem duplicar a mensagem, e o eco
--     do envio otimista casa por esse id.

create table if not exists app_media (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references users(id) on delete cascade,
  storage_path        text not null,
  mime                text not null,
  bytes               int  not null,
  kind                text not null check (kind in ('image', 'audio')),
  consumed_message_id uuid references messages(id) on delete set null,
  created_at          timestamptz not null default now()
);

create index if not exists app_media_user_idx on app_media (user_id, created_at desc);

create table if not exists app_exports (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references users(id) on delete cascade,
  status       text not null default 'pending' check (status in ('pending', 'ready', 'failed')),
  storage_path text,
  error        text,
  created_at   timestamptz not null default now(),
  completed_at timestamptz
);

create index if not exists app_exports_user_idx on app_exports (user_id, created_at desc);

alter table app_media   enable row level security;
alter table app_exports enable row level security;

-- Chat do app: keyset pagination + idempotência de envio.
create index if not exists messages_conv_created_id_idx
  on messages (conversation_id, created_at desc, id desc);

create unique index if not exists messages_app_external_uq
  on messages (external_id)
  where external_id like 'app-%';

-- Buckets privados (leitura SEMPRE via signed URL emitida pela API).
insert into storage.buckets (id, name, public)
values
  ('xarlote-app-media', 'xarlote-app-media', false),
  ('xarlote-exports',   'xarlote-exports',   false)
on conflict (id) do nothing;

comment on table app_media is
  'Mídia enviada pelo app do paciente (exame/receita/áudio). Storage privado; signed URL via API.';
comment on table app_exports is
  'Jobs de export LGPD completo (inclui mensagens/consents/audit). Arquivo em bucket privado xarlote-exports.';
