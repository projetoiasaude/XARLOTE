-- Tokens de push das instalações nativas (iOS/Android via Capacitor + FCM).
-- Um usuário pode ter vários aparelhos; um aparelho (token) pertence a 1 usuário.
-- Quando o FCM diz que um token morreu (UNREGISTERED), a row é deletada.
create table if not exists device_tokens (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users(id) on delete cascade,
  token       text not null unique,
  platform    text not null check (platform in ('ios', 'android', 'web')),
  app_version text,
  created_at  timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create index if not exists device_tokens_user_idx on device_tokens(user_id);

-- RLS: ligado, sem policy pública. Só o service role (backend) acessa — tokens
-- de push são credenciais de entrega, nunca expostos ao anon/cliente.
alter table device_tokens enable row level security;
