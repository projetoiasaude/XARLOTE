-- 0024 — Auth de PACIENTE do app nativo: OTP via WhatsApp + sessões com refresh rotativo.
--
-- Por que existe: até aqui NÃO havia autenticação de paciente — digitar um telefone em
-- /app/entrar devolvia o prontuário completo (risco residual documentado em
-- middleware/auth.ts:69-71 e PROJECT_STATE.md:192). Este é o alicerce que permite matar
-- as policies anon_read_* (migration 0027, aplicada SÓ após o cutover do web).
--
-- Modelo:
--   • otp_codes: código de 6 dígitos NUNCA em claro — sha256(pepper_env + salt + code).
--     Um dump do banco não permite forjar login (o pepper vive só no Railway).
--     attempts é incrementado ANTES da comparação (update condicional) — fecha corrida
--     de força bruta. TTL 5min; prune de vencidos entra no cron de retenção (padrão 0011).
--   • app_sessions: refresh token opaco de 256 bits, banco guarda só o sha256.
--     Rotação a cada uso: o anterior vira prev_refresh_hash com janela de graça
--     (prev_valid_until, 60s) — retry de rede móvel não derruba a sessão; reuso FORA
--     da graça = token vazou → a sessão é revogada (revoked_at).
--
-- RLS ligado SEM policy = service-role only (mesmo padrão de device_tokens/0012):
-- tokens de sessão jamais são legíveis por anon/authenticated.

create table if not exists otp_codes (
  id           uuid primary key default gen_random_uuid(),
  phone_e164   text not null,
  code_hash    text not null,
  salt         text not null,
  attempts     int  not null default 0,
  max_attempts int  not null default 3,
  request_ip   text,
  expires_at   timestamptz not null,
  consumed_at  timestamptz,
  created_at   timestamptz not null default now()
);

create index if not exists otp_codes_phone_idx on otp_codes (phone_e164, created_at desc);

create table if not exists app_sessions (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references users(id) on delete cascade,
  refresh_hash      text not null unique,
  prev_refresh_hash text,
  prev_valid_until  timestamptz,
  device_name       text,
  platform          text not null check (platform in ('ios', 'android', 'web')),
  created_at        timestamptz not null default now(),
  last_used_at      timestamptz not null default now(),
  revoked_at        timestamptz
);

create index if not exists app_sessions_user_idx on app_sessions (user_id);
create index if not exists app_sessions_prev_idx on app_sessions (prev_refresh_hash)
  where prev_refresh_hash is not null;

alter table otp_codes    enable row level security;
alter table app_sessions enable row level security;

comment on table otp_codes is
  'Códigos OTP de login do app (hash com pepper de env + salt por linha). Prune >24h via cron de retenção.';
comment on table app_sessions is
  'Sessões do app do paciente. refresh_hash = sha256 do token opaco; rotação com graça de 60s e detecção de reuso.';
