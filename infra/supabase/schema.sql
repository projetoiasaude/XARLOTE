-- IA da Saúde — Schema completo
-- Aplicar via: scripts/apply-migrations.ts  ou SQL Editor do Supabase Dashboard

-- ─── Extensions ──────────────────────────────────────────────────────────────
create extension if not exists "uuid-ossp";
create extension if not exists "pgcrypto";

-- ─── Enums ───────────────────────────────────────────────────────────────────
do $$ begin
  create type gender_t as enum ('female','male','other','not_informed');
exception when duplicate_object then null; end $$;

do $$ begin
  create type message_direction_t as enum ('in','out');
exception when duplicate_object then null; end $$;

do $$ begin
  create type message_content_type_t as enum ('text','image','audio','video','document','location','sticker','system');
exception when duplicate_object then null; end $$;

do $$ begin
  create type conversation_party_t as enum ('user','supplier');
exception when duplicate_object then null; end $$;

do $$ begin
  create type order_status_t as enum ('drafting','quoting','quoted','confirming','handed_off','cancelled','failed');
exception when duplicate_object then null; end $$;

do $$ begin
  create type quote_status_t as enum ('pending','contacting','negotiating','quoted','unavailable','timeout','refused');
exception when duplicate_object then null; end $$;

do $$ begin
  create type reminder_type_t as enum ('medication','appointment','exercise','hydration','sleep','custom');
exception when duplicate_object then null; end $$;

do $$ begin
  create type reminder_status_t as enum ('pending','sent','acknowledged','snoozed','cancelled');
exception when duplicate_object then null; end $$;

do $$ begin
  create type supplier_type_t as enum ('pharmacy','clinic','lab','therapist','hospital');
exception when duplicate_object then null; end $$;

do $$ begin
  create type consent_event_t as enum ('accept','revoke','update');
exception when duplicate_object then null; end $$;

-- ─── updated_at trigger function ────────────────────────────────────────────
create or replace function set_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end;
$$;

-- ─── Users ───────────────────────────────────────────────────────────────────
create table if not exists users (
  id                    uuid primary key default gen_random_uuid(),
  phone_e164            text not null unique,
  full_name             text,
  preferred_name        text,
  birth_date            date,
  gender                gender_t default 'not_informed',
  document_cpf          text,
  timezone              text not null default 'America/Sao_Paulo',
  preferred_language    text not null default 'pt-BR',
  onboarding_status     text not null default 'not_started',
  lgpd_consent_at       timestamptz,
  lgpd_consent_version  text,
  lgpd_consent_source   text,
  lgpd_consent_message_id uuid,
  metadata              jsonb not null default '{}',
  deleted_at            timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
create index if not exists users_phone_idx on users(phone_e164);
drop trigger if exists trg_users_updated on users;
create trigger trg_users_updated before update on users for each row execute function set_updated_at();

-- ─── User Addresses ──────────────────────────────────────────────────────────
create table if not exists user_addresses (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references users(id) on delete cascade,
  label        text not null default 'principal',
  street       text,
  number       text,
  complement   text,
  neighborhood text,
  city         text,
  state        text,
  cep          text,
  country      text default 'BR',
  latitude     double precision,
  longitude    double precision,
  is_default   boolean default false,
  created_at   timestamptz default now()
);
create index if not exists user_addresses_user_idx on user_addresses(user_id);

-- ─── User Health Conditions ──────────────────────────────────────────────────
create table if not exists user_health_conditions (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references users(id) on delete cascade,
  name       text not null,
  icd10      text,
  severity   text,
  onset_date date,
  active     boolean default true,
  source     text default 'self_reported',
  notes      text,
  created_at timestamptz default now()
);

-- ─── User Allergies ──────────────────────────────────────────────────────────
create table if not exists user_allergies (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references users(id) on delete cascade,
  substance  text not null,
  reaction   text,
  severity   text,
  source     text default 'self_reported',
  created_at timestamptz default now()
);

-- ─── User Medications ────────────────────────────────────────────────────────
create table if not exists user_medications (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references users(id) on delete cascade,
  medication_name text not null,
  active_ingredient text,
  dosage          text,
  form            text,
  frequency       text,
  schedule_times  jsonb,
  start_date      date,
  end_date        date,
  prescription_id uuid,
  active          boolean default true,
  source          text default 'self_reported',
  notes           text,
  created_at      timestamptz default now()
);

-- ─── Prescriptions ───────────────────────────────────────────────────────────
create table if not exists prescriptions (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references users(id) on delete cascade,
  message_id     uuid,
  storage_path   text,
  ocr_raw_text   text,
  parsed_json    jsonb,
  doctor_name    text,
  doctor_crm     text,
  doctor_uf      text,
  issued_at      date,
  validated      boolean default false,
  validated_at   timestamptz,
  created_at     timestamptz default now()
);

create table if not exists prescription_items (
  id              uuid primary key default gen_random_uuid(),
  prescription_id uuid not null references prescriptions(id) on delete cascade,
  medication_name text not null,
  active_ingredient text,
  dosage          text,
  form            text,
  quantity        text,
  frequency       text,
  duration        text,
  notes           text,
  confidence      numeric,
  created_at      timestamptz default now()
);

-- ─── Conversations ───────────────────────────────────────────────────────────
create table if not exists conversations (
  id                 uuid primary key default gen_random_uuid(),
  party_type         conversation_party_t not null,
  user_id            uuid references users(id) on delete set null,
  supplier_id        uuid,
  whatsapp_instance  text not null,
  whatsapp_jid       text not null,
  status             text not null default 'active',
  last_message_at    timestamptz,
  summary            text,
  memory_cards       jsonb default '[]',
  created_at         timestamptz default now(),
  updated_at         timestamptz default now()
);
create unique index if not exists conversations_jid_instance_idx on conversations(whatsapp_instance, whatsapp_jid);
create index if not exists conversations_user_idx on conversations(user_id);
drop trigger if exists trg_conversations_updated on conversations;
create trigger trg_conversations_updated before update on conversations for each row execute function set_updated_at();

-- ─── Messages ────────────────────────────────────────────────────────────────
create table if not exists messages (
  id                  uuid primary key default gen_random_uuid(),
  conversation_id     uuid not null references conversations(id) on delete cascade,
  external_id         text,
  direction           message_direction_t not null,
  sender_role         text not null,
  content_type        message_content_type_t not null,
  content             text,
  media_storage_path  text,
  media_mime          text,
  media_duration_ms   integer,
  location_lat        double precision,
  location_lng        double precision,
  raw_payload         jsonb,
  llm_model           text,
  llm_tokens_in       integer,
  llm_tokens_out      integer,
  llm_latency_ms      integer,
  trace_id            text,
  created_at          timestamptz not null default now()
);
create index if not exists messages_conv_created_idx on messages(conversation_id, created_at desc);
create unique index if not exists messages_external_idx on messages(conversation_id, external_id)
  where external_id is not null;

-- ─── Assistant Tasks ─────────────────────────────────────────────────────────
create table if not exists assistant_tasks (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid references conversations(id) on delete cascade,
  user_id         uuid references users(id) on delete set null,
  tool_name       text not null,
  tool_input      jsonb,
  tool_output     jsonb,
  status          text not null default 'pending',
  error           text,
  trace_id        text,
  started_at      timestamptz default now(),
  completed_at    timestamptz
);

-- ─── Suppliers ───────────────────────────────────────────────────────────────
create table if not exists suppliers (
  id                    uuid primary key default gen_random_uuid(),
  type                  supplier_type_t not null default 'pharmacy',
  name                  text not null,
  phone_e164            text,
  whatsapp_e164         text,
  whatsapp_verified_at  timestamptz,
  google_place_id       text unique,
  address               text,
  city                  text,
  state                 text,
  cep                   text,
  latitude              double precision,
  longitude             double precision,
  rating                numeric,
  reviews               integer,
  status                text default 'active',
  blacklist_reason      text,
  tags                  text[] default '{}',
  source                text default 'google_places',
  last_contacted_at     timestamptz,
  created_at            timestamptz default now(),
  updated_at            timestamptz default now()
);
create index if not exists suppliers_whatsapp_idx on suppliers(whatsapp_e164);
drop trigger if exists trg_suppliers_updated on suppliers;
create trigger trg_suppliers_updated before update on suppliers for each row execute function set_updated_at();

-- ─── Orders ──────────────────────────────────────────────────────────────────
create table if not exists orders (
  id                      uuid primary key default gen_random_uuid(),
  user_id                 uuid not null references users(id) on delete cascade,
  conversation_id         uuid references conversations(id),
  origin                  text,
  origin_prescription_id  uuid references prescriptions(id),
  status                  order_status_t not null default 'drafting',
  items                   jsonb not null default '[]',
  user_address_id         uuid references user_addresses(id),
  delivery_lat            double precision,
  delivery_lng            double precision,
  delivery_address        text,
  payment_method          text,
  status_3min_sent        boolean not null default false,
  status_5min_done        boolean not null default false,
  selected_quote_id       uuid,
  summary                 text,
  cancelled_reason        text,
  created_at              timestamptz default now(),
  updated_at              timestamptz default now()
);
create index if not exists orders_user_status_idx on orders(user_id, status);
drop trigger if exists trg_orders_updated on orders;
create trigger trg_orders_updated before update on orders for each row execute function set_updated_at();

-- ─── Quotes ──────────────────────────────────────────────────────────────────
create table if not exists quotes (
  id               uuid primary key default gen_random_uuid(),
  order_id         uuid not null references orders(id) on delete cascade,
  supplier_id      uuid not null references suppliers(id),
  conversation_id  uuid references conversations(id),
  status           quote_status_t not null default 'pending',
  distance_km      numeric,
  items_available  jsonb,
  subtotal         numeric,
  delivery_fee     numeric,
  total            numeric,
  currency         text default 'BRL',
  eta_minutes      integer,
  payment_methods  text[],
  pix_key          text,
  pix_receiver_name text,
  payment_link     text,
  notes            text,
  contact_attempts integer default 0,
  started_at       timestamptz,
  completed_at     timestamptz,
  created_at       timestamptz default now(),
  updated_at       timestamptz default now()
);
create index if not exists quotes_order_idx on quotes(order_id);
drop trigger if exists trg_quotes_updated on quotes;
create trigger trg_quotes_updated before update on quotes for each row execute function set_updated_at();

alter table orders add column if not exists selected_quote_id uuid references quotes(id) on delete set null;

-- ─── Reminders ───────────────────────────────────────────────────────────────
create table if not exists reminders (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references users(id) on delete cascade,
  type          reminder_type_t not null,
  title         text not null,
  body          text,
  scheduled_at  timestamptz,
  rrule         text,
  next_run_at   timestamptz,
  last_run_at   timestamptz,
  last_confirmed_at timestamptz, -- 0020: última confirmação do usuário (gate de backup condicional)
  status        reminder_status_t not null default 'pending',
  payload       jsonb default '{}',
  medication_id uuid references user_medications(id) on delete set null,
  created_at    timestamptz default now(),
  updated_at    timestamptz default now()
);
create index if not exists reminders_next_run_idx on reminders(next_run_at) where status = 'pending';

-- ─── Consent Events ──────────────────────────────────────────────────────────
create table if not exists consent_events (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references users(id) on delete cascade,
  event_type          consent_event_t not null,
  policy_version      text not null,
  channel             text default 'whatsapp',
  evidence_message_id uuid references messages(id),
  evidence_text       text,
  ip                  text,
  user_agent          text,
  created_at          timestamptz default now()
);

-- ─── System Logs ─────────────────────────────────────────────────────────────
create table if not exists system_logs (
  id              bigserial primary key,
  level           text not null,
  category        text not null,
  trace_id        text,
  user_id         uuid,
  conversation_id uuid,
  order_id        uuid,
  quote_id        uuid,
  message         text not null,
  metadata        jsonb default '{}',
  created_at      timestamptz default now()
);
create index if not exists system_logs_created_idx on system_logs(created_at desc);
create index if not exists system_logs_trace_idx on system_logs(trace_id);

-- ─── Staff Users ─────────────────────────────────────────────────────────────
create table if not exists staff_users (
  id           uuid primary key references auth.users(id) on delete cascade,
  email        text not null unique,
  display_name text,
  role         text not null default 'operator',
  allowed      boolean default true,
  created_at   timestamptz default now()
);

-- ─── Webhook Events (idempotência) ───────────────────────────────────────────
create table if not exists webhook_events (
  id                uuid primary key default gen_random_uuid(),
  provider          text not null,
  instance          text not null,
  external_event_id text not null,
  event_type        text,
  received_at       timestamptz default now(),
  processed_at      timestamptz,
  raw               jsonb,
  unique(provider, instance, external_event_id)
);

-- ─── RLS ─────────────────────────────────────────────────────────────────────
alter table users enable row level security;
alter table user_addresses enable row level security;
alter table user_health_conditions enable row level security;
alter table user_allergies enable row level security;
alter table user_medications enable row level security;
alter table prescriptions enable row level security;
alter table prescription_items enable row level security;
alter table conversations enable row level security;
alter table messages enable row level security;
alter table assistant_tasks enable row level security;
alter table suppliers enable row level security;
alter table orders enable row level security;
alter table quotes enable row level security;
alter table reminders enable row level security;
alter table consent_events enable row level security;
alter table system_logs enable row level security;
alter table staff_users enable row level security;

create or replace function is_staff() returns boolean language sql stable as $$
  select exists (
    select 1 from staff_users where id = auth.uid() and allowed = true
  );
$$;

-- Staff pode ler tudo (sem write — writes são feitos pelo service role)
do $$ begin
  create policy staff_read_users          on users           for select using (is_staff());
  create policy staff_read_conversations  on conversations   for select using (is_staff());
  create policy staff_read_messages       on messages        for select using (is_staff());
  create policy staff_read_orders         on orders          for select using (is_staff());
  create policy staff_read_quotes         on quotes          for select using (is_staff());
  create policy staff_read_suppliers      on suppliers       for select using (is_staff());
  create policy staff_read_logs           on system_logs     for select using (is_staff());
  create policy staff_read_tasks          on assistant_tasks for select using (is_staff());
  create policy staff_read_prescriptions  on prescriptions   for select using (is_staff());
  create policy staff_read_conditions     on user_health_conditions for select using (is_staff());
  create policy staff_read_allergies      on user_allergies  for select using (is_staff());
  create policy staff_read_medications    on user_medications for select using (is_staff());
  create policy staff_read_consent        on consent_events  for select using (is_staff());
  create policy staff_read_addresses      on user_addresses  for select using (is_staff());
  create policy staff_read_reminders      on reminders       for select using (is_staff());
  create policy staff_read_staff          on staff_users     for select using (is_staff());
exception when duplicate_object then null; end $$;

-- Admin pode editar suppliers (blacklist manual)
do $$ begin
  create policy admin_write_suppliers on suppliers for all
    using (exists (select 1 from staff_users where id = auth.uid() and role = 'admin'));
exception when duplicate_object then null; end $$;

-- ─── Realtime ────────────────────────────────────────────────────────────────
alter publication supabase_realtime add table messages;
alter publication supabase_realtime add table system_logs;
alter publication supabase_realtime add table orders;
alter publication supabase_realtime add table quotes;
alter publication supabase_realtime add table conversations;
