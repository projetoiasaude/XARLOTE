-- 0026 — Link do médico: compartilhamento do prontuário por link temporário.
--
-- O paciente aperta um botão no app → nasce um grant com token de 256 bits (o banco
-- guarda SÓ o sha256 — quem vaza o banco não abre prontuário nenhum) → o médico abre
-- /s/<token> no navegador, sem instalar nada.
--
-- Regras de segurança (validadas em share-grants.ts + tests/share-grant.test.ts):
--   • TTL default 72h (máx 7 dias) — expirado/revogado/inexistente respondem 404
--     IDÊNTICO (não vaza qual link já existiu).
--   • PIN de 4 dígitos opcional (hash+salt); 5 erros → grant travado.
--   • summary_cache: o resumo clínico é gerado UMA vez na criação (custo de LLM
--     determinístico, não por acesso).
--   • Cada acesso: access_count++, last_accessed_at, auditoria e push ao paciente
--     ("seu médico abriu seu prontuário").

create table if not exists share_grants (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references users(id) on delete cascade,
  token_hash       text not null unique,
  pin_hash         text,
  pin_salt         text,
  pin_attempts     int  not null default 0,
  summary_cache    jsonb,
  expires_at       timestamptz not null,
  revoked_at       timestamptz,
  access_count     int  not null default 0,
  last_accessed_at timestamptz,
  created_at       timestamptz not null default now()
);

create index if not exists share_grants_user_idx on share_grants (user_id, created_at desc);

alter table share_grants enable row level security;

comment on table share_grants is
  'Links temporários de prontuário pro médico. token_hash = sha256; PIN opcional; 404 indistinguível pós-expiração/revogação.';
