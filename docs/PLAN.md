# IA da Saúde — Planejamento End-to-End (MVP Piloto Farmácia)

## Context

**Por que este projeto existe.** Hoje, cuidar da saúde exige que o paciente orquestre manualmente: marcar consulta, comprar remédio, lembrar de tomar, cotar preços em farmácias, falar com atendentes, guardar receitas. A "IA da Saúde" (produto) + "Sara" (persona conversacional via WhatsApp) substitui esse esforço por um único contato empático: o usuário fala com a Sara e ela resolve.

**O que prova o MVP.** O piloto cobre apenas o vertical **farmácia**: o usuário pede um medicamento (texto, áudio ou foto de receita) e a Sara (1) entende, (2) geolocaliza o usuário, (3) descobre farmácias próximas, (4) negocia em paralelo via WhatsApp com várias, (5) consolida cotações e (6) devolve ao usuário as melhores opções com link/Pix para pagamento direto. O ciclo se fecha sem intermediação financeira.

**Produto paralelo: dashboard operacional.** Um frontend restrito aos desenvolvedores/fundadores que mostra, em tempo real, todas as conversas — do usuário com a Sara e da Sara com cada farmácia — mais logs, orders, cotações e perfil 360 do usuário. É o "cockpit" que prova que o sistema funciona e permite intervir.

**Intenção deste plano.** Descrever, passo a passo, tudo o que precisa ser construído para que o sistema rode em produção: arquitetura, stack, modelo de dados (SQL), contratos de API, prompts da LLM, orquestração de filas, segurança, LGPD, deploy, observabilidade, testes e roadmap por sprint. O plano é longo porque o usuário pediu "para executar exatamente em cima dele".

---

## 0. Decisões já travadas nesta conversa

| Decisão | Escolha |
|---|---|
| Linguagem/framework backend | **Node.js 20 + TypeScript + Fastify + BullMQ** |
| Instâncias WhatsApp (uazapi) | **2 números**: 1 para usuários (Sara) + 1 para fornecedores (agente) |
| Pagamento no MVP | **Sem intermediação**: Sara transmite Pix/link da farmácia ao usuário |
| Hospedagem | **Railway** (api + worker + Redis) · **Vercel** (dashboard) · **Supabase gerenciado** |
| LLM | **Google Gemini** (2.5 Flash para conversa; 2.5 Pro para OCR/raciocínio) |
| Dados | **Supabase** (Postgres + Auth + Storage + Realtime) |
| Observabilidade dashboard | Next.js + Supabase Realtime |

---

## 1. Visão de produto e escopo MVP

### 1.1 Persona "Sara"
- **Tom**: empático, tranquilo, intimista, "concierge de saúde". Nunca clínico-frio, nunca vendedor.
- **Limites médicos**: Sara **não** diagnostica, **não** prescreve, **não** altera dose. Se o usuário relata sintoma grave → acolhe, orienta procurar atendimento, sugere SAMU 192 se suspeita de emergência.
- **Transparência**: na primeira mensagem, Sara se identifica como inteligência artificial. Se perguntada, reconhece. Nunca finge ser humana quando questionada diretamente.

### 1.2 Escopo funcional do MVP (v1)
✅ Conversa por WhatsApp (texto, imagem, áudio, localização, documento PDF)
✅ Onboarding + consentimento LGPD
✅ Perfil de saúde 360 (condições, alergias, medicamentos em uso, endereços, preferências)
✅ OCR de receita médica via Gemini Vision
✅ Lembretes de medicação/rotina
✅ **Piloto principal**: cotar e orquestrar compra de medicamentos em farmácias via WhatsApp
✅ Dashboard dev (conversas ao vivo, logs, orders, cotações, perfis)

### 1.3 Fora de escopo (v1) — roadmap futuro
❌ Agendar médicos/exames/fisioterapia (v2)
❌ Pagamento intermediado via gateway (v2)
❌ App mobile nativo / interface própria do paciente (v3)
❌ Integração com laboratórios para puxar resultados (v3)
❌ Marketplace de profissionais de saúde (v4)
❌ WhatsApp Business API oficial (v2 — após validação uazapi)

---

## 2. Arquitetura de alto nível

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│   Usuário    │◀───▶│  uazapi      │◀───▶│   Farmácias  │
│  (WhatsApp)  │     │  Instância A │     │  (WhatsApp)  │
└──────────────┘     │    "Sara"    │     └──────┬───────┘
                     └──────┬───────┘            │
                            │ webhook            │
                            ▼                    │
                     ┌──────────────┐            │
                     │   Fastify    │            │
                     │  webhook API │            │
                     │  (Railway)   │            │
                     └──────┬───────┘            │
                            │ enqueue            │
                            ▼                    │
                     ┌──────────────┐            │
                     │   BullMQ     │            │
                     │  (Redis)     │            │
                     └──────┬───────┘            │
                            │ dequeue            │
                            ▼                    │
                     ┌──────────────┐            │
                     │  Workers     │            │
                     │  (Railway)   │            │
                     └──┬─────┬──┬──┘            │
                        │     │  │               │
           ┌────────────┘     │  └──────┐        │
           ▼                  ▼         ▼        │
   ┌────────────┐  ┌────────────┐  ┌────────────┐│
   │  Gemini    │  │  Supabase  │  │  Google    ││
   │  (LLM+Viz) │  │  (PG+RLS+  │  │  Places    ││
   │            │  │  Realtime) │  │  + Geocode ││
   └────────────┘  └──────┬─────┘  └────────────┘│
                          │ realtime              │
                          ▼                       │
                   ┌──────────────┐               │
                   │  Next.js     │               │
                   │  Dashboard   │               │
                   │  (Vercel)    │               │
                   └──────────────┘               │
                                                  │
                     ┌──────────────┐             │
                     │  uazapi      │◀────────────┘
                     │  Instância B │
                     │  "Agente"    │
                     └──────────────┘
                            ▲
                            │ webhook (idem)
                            └─▶ Fastify → BullMQ → Worker
```

### 2.1 Componentes
| Componente | Responsabilidade |
|---|---|
| **uazapi A** (Sara) | Canal bidirecional com usuários finais |
| **uazapi B** (Agente) | Canal bidirecional com farmácias |
| **Fastify API** | Recebe webhooks, valida, persiste msg crua, enfileira |
| **Redis + BullMQ** | Filas persistentes com retry, rate limit, concorrência |
| **Workers** | Processam jobs (LLM, descoberta, negociação, lembretes, enriquecimento de perfil) |
| **Supabase Postgres** | Fonte única de verdade: usuários, conversas, orders, quotes, perfil, logs |
| **Supabase Storage** | Imagens de receita, áudios, comprovantes |
| **Supabase Realtime** | Push ao dashboard (novidade em conversa, quote, order) |
| **Gemini API** | LLM principal (texto, imagem, áudio), function calling, embeddings |
| **Google Places/Geocoding** | Descoberta de farmácias por lat/lng, geocoding reverso de endereços |
| **Next.js Dashboard** | Cockpit interno: conversas, orders, logs, perfis |
| **Sentry + Grafana Cloud** | Erros e métricas |

---

## 3. Stack tecnológica final (versões-alvo)

### Backend
- Node.js **20.x LTS**
- TypeScript **5.x** (`"strict": true`, `"noUncheckedIndexedAccess": true`)
- Fastify **4.x** (+ `@fastify/helmet`, `@fastify/rate-limit`, `@fastify/sensible`)
- BullMQ **5.x** (Redis 7)
- `zod` **3.x** para validação de payloads e schemas
- `pino` **9.x** para logs estruturados
- `@supabase/supabase-js` **2.x**
- `@google/generative-ai` **0.x** (Gemini SDK oficial)
- `axios` + `axios-retry` para chamadas HTTP externas
- `dayjs` + plugins (timezone, relativeTime) para datas
- `rrule` para recorrência de lembretes
- `libphonenumber-js` para E.164

### Frontend (dashboard)
- Next.js **14.x** App Router
- React **18.x**
- Tailwind CSS + shadcn/ui
- `@supabase/ssr` + Supabase Auth (provedor e-mail/senha, lista branca)
- `@tanstack/react-query` para cache de dados não-realtime
- `date-fns` para datas

### Infra
- pnpm **9.x** workspaces (monorepo)
- Docker (apenas para dev local: Redis e emulação de workers)
- Supabase CLI para migrations
- GitHub Actions para CI (lint, typecheck, test, build)
- Railway para deploy do backend
- Vercel para deploy do frontend

---

## 4. Estrutura do repositório (monorepo pnpm)

```
ia-da-saude/
├── apps/
│   ├── api/                    # Fastify: recebe webhooks, expõe endpoints internos p/ dashboard
│   │   ├── src/
│   │   │   ├── server.ts
│   │   │   ├── routes/
│   │   │   │   ├── webhook.uazapi.ts    # POST /webhook/uazapi/:instance
│   │   │   │   ├── admin.conversations.ts
│   │   │   │   ├── admin.orders.ts
│   │   │   │   └── health.ts
│   │   │   ├── middleware/
│   │   │   │   ├── verify-uazapi-signature.ts
│   │   │   │   └── require-staff-auth.ts
│   │   │   └── queues.ts        # exporta wrappers para enfileirar
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   ├── worker/                 # Workers BullMQ (processo separado, escalável)
│   │   ├── src/
│   │   │   ├── index.ts         # inicializa todos os workers
│   │   │   ├── workers/
│   │   │   │   ├── inbound-user.worker.ts
│   │   │   │   ├── inbound-supplier.worker.ts
│   │   │   │   ├── outbound-whatsapp.worker.ts
│   │   │   │   ├── pharmacy-discovery.worker.ts
│   │   │   │   ├── pharmacy-negotiation.worker.ts
│   │   │   │   ├── quote-consolidation.worker.ts
│   │   │   │   ├── reminder-dispatcher.worker.ts
│   │   │   │   └── profile-enricher.worker.ts
│   │   │   └── handlers/        # Lógica pura chamada pelos workers (testável)
│   │   └── package.json
│   │
│   └── web/                    # Next.js dashboard
│       ├── app/
│       │   ├── (dash)/
│       │   │   ├── layout.tsx
│       │   │   ├── page.tsx                     # overview
│       │   │   ├── conversations/
│       │   │   │   ├── page.tsx
│       │   │   │   └── [id]/page.tsx
│       │   │   ├── orders/
│       │   │   │   ├── page.tsx
│       │   │   │   └── [id]/page.tsx            # "cockpit" de ordem
│       │   │   ├── users/[id]/page.tsx          # perfil 360
│       │   │   ├── suppliers/page.tsx
│       │   │   └── logs/page.tsx
│       │   ├── login/page.tsx
│       │   └── layout.tsx
│       ├── components/ (chat-pane, timeline, kanban, etc.)
│       ├── lib/ (supabase client, realtime helpers)
│       └── package.json
│
├── packages/
│   ├── shared/                 # Tipos, enums, schemas Zod compartilhados
│   │   ├── src/
│   │   │   ├── types.ts
│   │   │   ├── schemas.ts
│   │   │   └── constants.ts
│   │   └── package.json
│   │
│   ├── db/                     # Cliente Supabase + tipos gerados
│   │   ├── src/
│   │   │   ├── client.ts                 # service-role client (backend)
│   │   │   ├── client-public.ts          # anon client (frontend)
│   │   │   └── types.ts                  # gerado via supabase gen types
│   │   └── package.json
│   │
│   ├── llm/                    # Wrapper Gemini + prompts + tools
│   │   ├── src/
│   │   │   ├── client.ts
│   │   │   ├── prompts/
│   │   │   │   ├── sara.system.ts
│   │   │   │   ├── sara.onboarding.ts
│   │   │   │   ├── agent-pharmacy.system.ts
│   │   │   │   ├── prescription-ocr.ts
│   │   │   │   └── profile-enricher.ts
│   │   │   ├── tools/
│   │   │   │   └── definitions.ts        # declarações de function calling
│   │   │   └── utils/
│   │   │       ├── trim-history.ts
│   │   │       └── redact-pii.ts
│   │   └── package.json
│   │
│   ├── whatsapp/               # Cliente uazapi
│   │   ├── src/
│   │   │   ├── client.ts                 # sendText, sendImage, sendLocation, checkWhatsApp
│   │   │   ├── types.ts
│   │   │   └── normalize.ts              # payload webhook → formato interno
│   │   └── package.json
│   │
│   ├── integrations/
│   │   ├── src/
│   │   │   ├── google-places.ts          # nearby, details
│   │   │   ├── geocoding.ts              # endereço ↔ lat/lng
│   │   │   └── phone-lookup.ts           # scrape website farmácia → whatsapp
│   │   └── package.json
│   │
│   └── core/                   # Regras de negócio puras (testáveis sem infra)
│       ├── src/
│       │   ├── orders/
│       │   ├── quotes/
│       │   ├── reminders/
│       │   └── lgpd/
│       └── package.json
│
├── infra/
│   ├── supabase/
│   │   ├── migrations/                   # arquivos SQL numerados
│   │   │   ├── 0001_init_users.sql
│   │   │   ├── 0002_conversations.sql
│   │   │   ├── ...
│   │   │   └── 0099_rls_policies.sql
│   │   ├── seed.sql
│   │   └── config.toml
│   └── railway/
│       ├── railway.toml
│       └── Procfile
│
├── scripts/
│   ├── setup-supabase.ts
│   ├── generate-db-types.sh
│   └── seed-dev.ts
│
├── docs/                                  # docs auxiliares (playbook, onboarding de dev)
├── .env.example
├── .github/workflows/ci.yml
├── pnpm-workspace.yaml
├── package.json
├── tsconfig.base.json
├── .eslintrc.cjs
├── .prettierrc
└── README.md
```

---

## 5. Modelo de dados Supabase (SQL completo)

> **Regra geral**: todas as tabelas têm `id uuid default gen_random_uuid() primary key`, `created_at timestamptz default now()`, `updated_at timestamptz default now()` com trigger. Campos de saúde tratados como **dados sensíveis** (LGPD art. 11). RLS ativo em tudo; acesso de leitura/escrita operacional feito pelo **service role key** no backend.

### 5.1 Enums

```sql
create type gender_t as enum ('female','male','other','not_informed');
create type message_direction_t as enum ('in','out');
create type message_content_type_t as enum ('text','image','audio','video','document','location','sticker','reaction','system');
create type order_status_t as enum ('drafting','quoting','quoted','confirming','handed_off','cancelled','failed');
create type quote_status_t as enum ('pending','contacting','negotiating','quoted','unavailable','timeout','refused');
create type reminder_type_t as enum ('medication','appointment','exercise','hydration','sleep','custom');
create type reminder_status_t as enum ('pending','sent','acknowledged','snoozed','cancelled');
create type supplier_type_t as enum ('pharmacy','clinic','lab','therapist','hospital');
create type consent_event_t as enum ('accept','revoke','update');
create type conversation_party_t as enum ('user','supplier');
```

### 5.2 Tabelas principais

```sql
-- 5.2.1 Usuários finais (pacientes)
create table users (
  id uuid primary key default gen_random_uuid(),
  phone_e164 text not null unique,
  full_name text,
  preferred_name text,              -- como a Sara chama
  birth_date date,
  gender gender_t default 'not_informed',
  document_cpf text,                -- opcional, criptografado no app
  timezone text not null default 'America/Sao_Paulo',
  preferred_language text not null default 'pt-BR',
  onboarding_status text not null default 'not_started', -- not_started|consent_pending|profiling|active
  lgpd_consent_at timestamptz,
  lgpd_consent_version text,
  lgpd_consent_source text,         -- 'whatsapp' | 'web'
  lgpd_consent_message_id uuid,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index users_phone_idx on users(phone_e164);

-- 5.2.2 Endereços do usuário
create table user_addresses (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  label text not null default 'principal',       -- casa|trabalho|outro
  street text, number text, complement text,
  neighborhood text, city text, state text, cep text,
  country text default 'BR',
  latitude double precision,
  longitude double precision,
  is_default boolean default false,
  created_at timestamptz default now()
);
create index user_addresses_user_idx on user_addresses(user_id);

-- 5.2.3 Condições de saúde declaradas
create table user_health_conditions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  name text not null,
  icd10 text,
  severity text,                        -- leve|moderada|severa
  onset_date date,
  active boolean default true,
  source text default 'self_reported',  -- self_reported|prescription|doctor
  notes text,
  created_at timestamptz default now()
);

-- 5.2.4 Alergias
create table user_allergies (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  substance text not null,
  reaction text,
  severity text,
  source text default 'self_reported',
  created_at timestamptz default now()
);

-- 5.2.5 Medicamentos em uso
create table user_medications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  medication_name text not null,
  active_ingredient text,
  dosage text,                          -- "500mg"
  form text,                            -- comprimido|cápsula|gotas|...
  frequency text,                       -- "2x ao dia"
  schedule_times jsonb,                 -- ["08:00","20:00"]
  start_date date, end_date date,
  prescription_id uuid,                 -- FK preenchida depois
  active boolean default true,
  source text default 'self_reported',
  notes text,
  created_at timestamptz default now()
);

-- 5.2.6 Receitas
create table prescriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  message_id uuid,                      -- mensagem onde veio a foto
  storage_path text,                    -- bucket 'prescriptions'
  ocr_raw_text text,
  parsed_json jsonb,                    -- {doctor:{name,crm,uf}, items:[...]}
  doctor_name text, doctor_crm text, doctor_uf text,
  issued_at date,
  validated boolean default false,
  validated_at timestamptz,
  validator_note text,
  created_at timestamptz default now()
);

create table prescription_items (
  id uuid primary key default gen_random_uuid(),
  prescription_id uuid not null references prescriptions(id) on delete cascade,
  medication_name text not null,
  active_ingredient text,
  dosage text, form text, quantity text,
  frequency text, duration text, notes text,
  confidence numeric,                   -- 0..1 confiança do OCR
  created_at timestamptz default now()
);

alter table user_medications
  add constraint user_medications_prescription_fk
  foreign key (prescription_id) references prescriptions(id) on delete set null;

-- 5.2.7 Conversas (threads)
create table conversations (
  id uuid primary key default gen_random_uuid(),
  party_type conversation_party_t not null,      -- 'user' ou 'supplier'
  user_id uuid references users(id) on delete set null,
  supplier_id uuid,                              -- se party_type='supplier'
  whatsapp_instance text not null,               -- 'sara' | 'agent'
  whatsapp_jid text not null,                    -- 55xxxxxxxx@s.whatsapp.net
  status text not null default 'active',         -- active|archived
  last_message_at timestamptz,
  summary text,                                  -- atualizado periodicamente
  memory_cards jsonb default '[]'::jsonb,        -- resumos compactos
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create unique index conversations_jid_instance_idx on conversations(whatsapp_instance, whatsapp_jid);
create index conversations_user_idx on conversations(user_id);

-- 5.2.8 Mensagens
create table messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversations(id) on delete cascade,
  external_id text,                              -- id do wa (key.id)
  direction message_direction_t not null,
  sender_role text not null,                     -- user|assistant|supplier|system
  content_type message_content_type_t not null,
  content text,                                  -- texto (ou legenda)
  media_storage_path text,
  media_mime text,
  media_duration_ms integer,
  location_lat double precision,
  location_lng double precision,
  raw_payload jsonb,
  llm_model text,
  llm_tokens_in integer,
  llm_tokens_out integer,
  llm_latency_ms integer,
  trace_id text,
  created_at timestamptz not null default now()
);
create index messages_conv_created_idx on messages(conversation_id, created_at desc);
create unique index messages_external_idx on messages(conversation_id, external_id) where external_id is not null;

-- 5.2.9 Tarefas do assistente (function calls para auditoria)
create table assistant_tasks (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid references conversations(id) on delete cascade,
  user_id uuid references users(id) on delete set null,
  tool_name text not null,
  tool_input jsonb,
  tool_output jsonb,
  status text not null default 'pending',        -- pending|running|success|error
  error text,
  trace_id text,
  started_at timestamptz default now(),
  completed_at timestamptz
);

-- 5.2.10 Fornecedores (farmácias descobertas/persistidas)
create table suppliers (
  id uuid primary key default gen_random_uuid(),
  type supplier_type_t not null default 'pharmacy',
  name text not null,
  phone_e164 text,
  whatsapp_e164 text,                            -- validado via uazapi
  whatsapp_verified_at timestamptz,
  google_place_id text unique,
  address text, city text, state text, cep text,
  latitude double precision, longitude double precision,
  rating numeric, reviews integer,
  status text default 'active',                  -- active|blacklisted|inactive
  blacklist_reason text,
  tags text[] default '{}',                      -- "24h", "delivery", "convenio-x"
  source text default 'google_places',
  last_contacted_at timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create index suppliers_location_idx on suppliers using gist (point(longitude, latitude));
create index suppliers_whatsapp_idx on suppliers(whatsapp_e164);

-- 5.2.11 Orders (pedidos)
create table orders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  conversation_id uuid references conversations(id),
  origin text,                                   -- 'prescription_image'|'user_text'|'reminder'
  origin_prescription_id uuid references prescriptions(id),
  status order_status_t not null default 'drafting',
  items jsonb not null default '[]'::jsonb,      -- [{name,dosage,quantity,substitutes_ok}]
  user_address_id uuid references user_addresses(id),
  delivery_lat double precision, delivery_lng double precision,
  selected_quote_id uuid,                        -- preenchido quando usuário escolhe
  summary text,
  cancelled_reason text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create index orders_user_status_idx on orders(user_id, status);

-- 5.2.12 Cotações (uma por supplier contatado em uma order)
create table quotes (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references orders(id) on delete cascade,
  supplier_id uuid not null references suppliers(id),
  conversation_id uuid references conversations(id),  -- thread com a farmácia
  status quote_status_t not null default 'pending',
  distance_km numeric,
  items_available jsonb,                         -- [{name, price, available:true}]
  subtotal numeric, delivery_fee numeric, total numeric, currency text default 'BRL',
  eta_minutes integer,
  payment_methods text[],                        -- pix|cartao|dinheiro
  pix_key text, pix_receiver_name text,
  payment_link text,
  notes text,
  contact_attempts integer default 0,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create index quotes_order_idx on quotes(order_id);

alter table orders
  add constraint orders_selected_quote_fk
  foreign key (selected_quote_id) references quotes(id) on delete set null;

-- 5.2.13 Lembretes
create table reminders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  type reminder_type_t not null,
  title text not null,
  body text,
  scheduled_at timestamptz,
  rrule text,                                    -- recorrência
  next_run_at timestamptz,
  last_run_at timestamptz,
  status reminder_status_t not null default 'pending',
  payload jsonb default '{}'::jsonb,
  medication_id uuid references user_medications(id) on delete set null,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create index reminders_next_run_idx on reminders(next_run_at) where status = 'pending';

-- 5.2.14 Consentimento LGPD (audit log imutável)
create table consent_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  event_type consent_event_t not null,
  policy_version text not null,
  channel text default 'whatsapp',
  evidence_message_id uuid references messages(id),
  evidence_text text,                            -- snapshot da mensagem de aceite
  ip text, user_agent text,
  created_at timestamptz default now()
);

-- 5.2.15 Logs de sistema (dashboard dev)
create table system_logs (
  id bigserial primary key,
  level text not null,                           -- debug|info|warn|error
  category text not null,                        -- webhook|llm|worker|integration|order|quote
  trace_id text,
  user_id uuid,
  conversation_id uuid,
  order_id uuid,
  quote_id uuid,
  message text not null,
  metadata jsonb default '{}'::jsonb,
  created_at timestamptz default now()
);
create index system_logs_created_idx on system_logs(created_at desc);
create index system_logs_trace_idx on system_logs(trace_id);

-- 5.2.16 Staff (dashboard)
create table staff_users (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null unique,
  display_name text,
  role text not null default 'operator',         -- operator|admin
  allowed boolean default true,
  created_at timestamptz default now()
);

-- 5.2.17 Idempotência de webhooks
create table webhook_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null,                        -- 'uazapi'
  instance text not null,
  external_event_id text not null,
  event_type text,
  received_at timestamptz default now(),
  processed_at timestamptz,
  raw jsonb,
  unique(provider, instance, external_event_id)
);

-- 5.2.18 Rate limits e locks distribuídos (auxiliar, ou usar Redis)
create table outbound_rate_bucket (
  instance text primary key,
  tokens integer not null default 0,
  last_refill timestamptz not null default now()
);
```

### 5.3 Trigger de `updated_at`

```sql
create or replace function set_updated_at() returns trigger as $$
begin new.updated_at = now(); return new; end;
$$ language plpgsql;

-- aplicar em cada tabela relevante:
create trigger trg_users_updated before update on users for each row execute function set_updated_at();
create trigger trg_conversations_updated before update on conversations for each row execute function set_updated_at();
-- ... idem para orders, quotes, suppliers, user_medications, reminders
```

### 5.4 RLS (Row Level Security)

> **Princípio**: service role faz tudo (backend). Frontend dashboard usa JWT de `staff_users` autenticados e só pode ler. Nenhum usuário final autentica diretamente no Supabase no MVP.

```sql
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

-- Helper: checa se usuário autenticado é staff permitido
create or replace function is_staff() returns boolean language sql stable as $$
  select exists (
    select 1 from staff_users
    where id = auth.uid() and allowed = true
  );
$$;

-- Política padrão: staff pode ler tudo
create policy "staff_read_all_users" on users for select using (is_staff());
create policy "staff_read_all_conversations" on conversations for select using (is_staff());
create policy "staff_read_all_messages" on messages for select using (is_staff());
create policy "staff_read_all_orders" on orders for select using (is_staff());
create policy "staff_read_all_quotes" on quotes for select using (is_staff());
create policy "staff_read_all_suppliers" on suppliers for select using (is_staff());
create policy "staff_read_all_reminders" on reminders for select using (is_staff());
create policy "staff_read_all_tasks" on assistant_tasks for select using (is_staff());
create policy "staff_read_all_logs" on system_logs for select using (is_staff());
create policy "staff_read_all_prescriptions" on prescriptions for select using (is_staff());
create policy "staff_read_all_conditions" on user_health_conditions for select using (is_staff());
create policy "staff_read_all_allergies" on user_allergies for select using (is_staff());
create policy "staff_read_all_medications" on user_medications for select using (is_staff());
create policy "staff_read_all_consent" on consent_events for select using (is_staff());

-- Admin pode escrever em suppliers (blacklist manual) e reminders
create policy "admin_write_suppliers" on suppliers for all using (
  exists (select 1 from staff_users where id = auth.uid() and role = 'admin')
);
```

### 5.5 Storage buckets

```sql
-- via supabase CLI / dashboard:
-- bucket 'prescriptions' (private)
-- bucket 'audio-messages' (private)
-- bucket 'documents' (private)

-- Policies: apenas service role pode ler/escrever; dashboard lê via signed URL
```

### 5.6 Índices de busca geoespacial
```sql
create extension if not exists cube;
create extension if not exists earthdistance;
-- suppliers_location_idx já criado acima
-- função auxiliar para buscar num raio:
create or replace function suppliers_near(
  in_lat double precision, in_lng double precision, radius_km numeric
) returns setof suppliers language sql stable as $$
  select *
  from suppliers
  where latitude is not null and longitude is not null
    and earth_distance(ll_to_earth(latitude, longitude), ll_to_earth(in_lat, in_lng)) <= radius_km * 1000
  order by earth_distance(ll_to_earth(latitude, longitude), ll_to_earth(in_lat, in_lng));
$$;
```

---

## 6. Integração uazapi

### 6.1 Duas instâncias

| Instância | Finalidade | Número | Webhook path |
|---|---|---|---|
| **sara** | Conversa com usuário final | +55 XX XXXXX-XXXX (Número A) | `POST /webhook/uazapi/sara` |
| **agent** | Conversa com farmácias | +55 XX XXXXX-XXXX (Número B) | `POST /webhook/uazapi/agent` |

> Os números B (agente) se identificam na primeira mensagem à farmácia como: *"Olá! Aqui é o assistente da IA da Saúde, estou ajudando um paciente a cotar um medicamento. Posso perguntar algumas coisinhas?"* — nunca se passa por humano, mantém transparência.

### 6.2 Configuração inicial de cada instância
1. Criar instância no painel uazapi → receber `instance_id`, `instance_token`, `server_url`.
2. Conectar via QR code (modo MD / multi-device).
3. Configurar webhook:
   - URL: `https://api.iadasaude.com/webhook/uazapi/sara` (e `/agent`)
   - Método: `POST`
   - Eventos: `messages.upsert`, `messages.update`, `connection.update`, `presence.update` (opcional)
   - Secret header: `X-Uazapi-Secret: ${UAZAPI_WEBHOOK_SECRET}` (mesmo para ambas)

### 6.3 Formato típico do payload (normalizar em `packages/whatsapp/src/normalize.ts`)

```json
{
  "event": "messages.upsert",
  "instance": "sara",
  "data": {
    "key": {
      "remoteJid": "5511999999999@s.whatsapp.net",
      "fromMe": false,
      "id": "3EB0ABCD..."
    },
    "pushName": "João",
    "message": {
      "conversation": "Oi, preciso comprar dipirona"
    },
    "messageType": "conversation",
    "messageTimestamp": 1713500000
  }
}
```

Outros tipos: `imageMessage`, `audioMessage`, `locationMessage`, `documentMessage`, `extendedTextMessage`. A função `normalize()` converte tudo para:

```ts
type NormalizedInbound = {
  instance: 'sara' | 'agent';
  externalId: string;              // key.id
  from: { jid: string; pushName?: string; phoneE164: string };
  fromMe: boolean;
  timestamp: Date;
  contentType: 'text' | 'image' | 'audio' | 'video' | 'document' | 'location' | 'sticker' | 'reaction';
  text?: string;                   // texto ou legenda
  media?: { url?: string; base64?: string; mime?: string; durationMs?: number };
  location?: { lat: number; lng: number; name?: string; address?: string };
  raw: unknown;
};
```

### 6.4 Cliente de envio (`packages/whatsapp/src/client.ts`)

```ts
// Assinatura de alto nível (os paths exatos devem ser confirmados na doc da uazapi).
export class UazapiClient {
  constructor(private cfg: { serverUrl: string; token: string; instance: 'sara'|'agent' }) {}

  async sendText(toPhoneE164: string, text: string, opts?: { quotedId?: string }): Promise<{ messageId: string }> { ... }
  async sendImage(toPhoneE164: string, image: { url?: string; base64?: string }, caption?: string): Promise<...> { ... }
  async sendAudio(toPhoneE164: string, audio: { url?: string; base64?: string }, isPtt?: boolean): Promise<...> { ... }
  async sendLocation(toPhoneE164: string, lat: number, lng: number, name?: string): Promise<...> { ... }
  async sendDocument(toPhoneE164: string, doc: { url: string; filename: string }): Promise<...> { ... }
  async setPresence(toPhoneE164: string, state: 'composing'|'paused'|'available'): Promise<void> { ... }
  async checkWhatsApp(phoneE164: string): Promise<{ exists: boolean; jid?: string }> { ... }
  async getMedia(messageId: string): Promise<Buffer> { ... }
  async getInstanceStatus(): Promise<{ connected: boolean; battery?: number }> { ... }
}
```

**Axios config** com retry exponencial em 5xx/timeouts, timeout global de 15s, log de latência, emissão de evento em `system_logs`.

### 6.5 Rate limit de envio (crítico para evitar ban)
Implementado como **rate limiter do BullMQ** por fila `outbound-whatsapp:<instance>`:
- **sara**: 1 msg a cada 1.5s por número destinatário; 30 msgs/min globais.
- **agent**: 1 msg a cada 3s por número destinatário; 20 msgs/min globais; presença "composing" antes do envio (simula humano); jitter aleatório ±800ms.

### 6.6 Tratamento de eventos

| Evento | Ação |
|---|---|
| `messages.upsert` com `fromMe=false` | Enfileirar em `inbound-user` ou `inbound-supplier` conforme instância |
| `messages.upsert` com `fromMe=true` | Atualizar status da mensagem (enviada) se correspondente no DB |
| `messages.update` | Atualizar status (entregue/lida) |
| `connection.update` status `close` | Alertar Sentry + sistema de notificação: reconectar! |

### 6.7 Idempotência
Toda mensagem entrante é registrada em `webhook_events` via `UNIQUE(provider, instance, external_event_id)`. Se insert falhar por conflito, o job é **pulado** (já processado).

---

## 7. Integração Google Gemini

### 7.1 Modelos
| Uso | Modelo |
|---|---|
| Conversa com usuário (Sara) | `gemini-2.5-flash` (latência baixa, tools, multimodal) |
| Conversa com farmácia (Agente) | `gemini-2.5-flash` |
| OCR de receita | `gemini-2.5-pro` (visão + raciocínio) |
| Enriquecimento de perfil / sumarização | `gemini-2.5-flash` |
| Embeddings (busca semântica futura) | `text-embedding-004` |

### 7.2 Parâmetros padrão
- `temperature`: 0.4 (conversa), 0.1 (OCR e extração), 0.7 (nunca — evitar imprevisibilidade clínica)
- `topP`: 0.95
- `maxOutputTokens`: 1024 (conversa), 4096 (OCR)
- `safetySettings`: bloquear categorias de alto risco (HARM_CATEGORY_*), mas **não** bloquear tópicos de saúde (configurar `BLOCK_ONLY_HIGH` para temas médicos).

### 7.3 Function calling — ferramentas declaradas (Sara)

Declaradas em `packages/llm/src/tools/definitions.ts`. Cada chamada é registrada em `assistant_tasks`.

```ts
export const saraTools = [
  {
    name: 'save_user_profile_fact',
    description: 'Registra ou atualiza um fato do perfil do usuário (condição, alergia, medicamento, preferência, endereço).',
    parameters: {
      type: 'object',
      properties: {
        category: { type: 'string', enum: ['condition','allergy','medication','address','preference','contact','other'] },
        payload: { type: 'object' },       // schema específico por category
        confidence: { type: 'number' }
      },
      required: ['category','payload']
    }
  },
  { name: 'request_user_location',      description: '...', parameters: { ... } },
  { name: 'parse_prescription_image',   description: 'Dispara OCR da imagem anexada à mensagem.', parameters: { messageId: 'string' } },
  { name: 'start_pharmacy_order',       description: 'Inicia fluxo de cotação em farmácias.', parameters: { items: [...], addressId: 'uuid|null' } },
  { name: 'get_order_status',           description: 'Consulta estado de uma order em andamento.', parameters: { orderId: 'uuid' } },
  { name: 'confirm_order_selection',    description: 'Usuário escolheu um quote; confirmar.', parameters: { orderId, quoteId } },
  { name: 'cancel_order',               description: '...', parameters: { orderId, reason } },
  { name: 'create_reminder',            description: '...', parameters: { type, title, scheduled_at|rrule, payload } },
  { name: 'record_health_event',        description: 'Registra sintoma, medição, evento.', parameters: { ... } },
  { name: 'send_emergency_orientation', description: 'Instrução para casos graves (SAMU 192).', parameters: { severity } },
  { name: 'escalate_to_human',          description: 'Marca conversa para revisão humana.', parameters: { reason } }
];
```

### 7.4 Function calling — ferramentas do Agente (farmácia)

```ts
export const agentPharmacyTools = [
  { name: 'record_supplier_ack',         description: 'Farmácia confirmou ter o remédio.', parameters: { ... } },
  { name: 'record_supplier_unavailable', description: 'Farmácia não tem ou não entrega.', parameters: { ... } },
  { name: 'record_quote_price',          description: 'Registra preço, entrega, ETA, Pix.',
    parameters: { subtotal, delivery_fee, total, eta_minutes, payment_methods:['pix','cartao','dinheiro'], pix_key?, payment_link?, notes? } },
  { name: 'request_clarification',       description: 'Precisa perguntar algo ao usuário antes de continuar.', parameters: { question } },
  { name: 'finalize_supplier_contact',   description: 'Encerrou a negociação (sucesso ou falha).', parameters: { outcome } }
];
```

### 7.5 Construção do prompt da Sara (alto nível, em `packages/llm/src/prompts/sara.system.ts`)

**Bloco 1 — Identidade**: "Você é Sara, assistente de saúde empática da IA da Saúde, que conversa por WhatsApp..."

**Bloco 2 — Princípios**:
- Empática, curta, tom intimista, linguagem PT-BR natural
- Nunca diagnostica, nunca ajusta dose
- Sempre confirma antes de agir (pedir remédio, criar lembrete)
- Transparência: é IA quando perguntada
- Sinais de emergência → orientar SAMU 192 e chamar `send_emergency_orientation`

**Bloco 3 — Estado do usuário** (injetado dinamicamente):
- Nome preferido, idade aproximada, condições/alergias ativas, medicamentos em uso, endereços registrados
- Últimas 3-5 "memory cards" (resumos compactos de conversas anteriores)

**Bloco 4 — Regras operacionais**:
- Se usuário pedir compra de remédio → chamar `start_pharmacy_order`, **não** prometer preço ou farmácia específica
- Se mandar foto → chamar `parse_prescription_image` primeiro, depois confirmar
- Se mandar localização → nunca expor lat/lng cru; confirmar "é em Rua X, bairro Y?"

**Bloco 5 — Guardrails**:
- Nunca compartilha dados de outros usuários
- Não executa ação em nome do usuário sem confirmação explícita (exceto lembretes que ele mesmo pediu)
- Não cita preços/farmácias antes de `quote-consolidation` concluir

**Bloco 6 — Histórico**: últimas N mensagens (trimmed para ~20 turnos ou 8k tokens).

### 7.6 Histórico e memória
- **Curto prazo**: últimas ~20 mensagens injetadas literalmente
- **Médio prazo**: `conversations.memory_cards` — array de objetos `{created_at, text, tags}` com resumos (gerados pelo `profile-enricher.worker` a cada N mensagens)
- **Longo prazo**: `users.*` + tabelas de perfil (condições, alergias, meds, endereços)
- **Sumarização**: quando histórico > 40 mensagens, worker sumariza as 20 mais antigas em 1 memory card e descarta do prompt

### 7.7 Controle de custo/latência
- Trim agressivo do histórico
- Cache de prompts do sistema (Gemini API usa `system_instruction`)
- Circuit breaker: se Gemini falhar 3× seguidas, fallback "Tive um probleminha, pode repetir em alguns minutos?" + alerta
- Timeout: 25s; retry: 2×

---

## 8. Integração Google Places + Geocoding

### 8.1 APIs usadas
- **Places API (New)** — `searchNearby` para farmácias por lat/lng+raio
- **Place Details** — para pegar `formatted_phone_number`, `websiteUri`, `openingHours`
- **Geocoding API** — endereço texto → `{lat,lng}` (quando usuário manda endereço digitado)

### 8.2 Fluxo de descoberta (worker `pharmacy-discovery`)
```
1. Input: { orderId, lat, lng }
2. Cache key: geohash(lat,lng, precision=6) + "radius=3km"
   → se hit válido (< 24h), usar; senão, chamar API
3. searchNearby(types=['pharmacy'], radius=3000)
   → se < 3 resultados, expandir radius=5000; se ainda < 3, 8000
4. Para cada resultado (até 8):
   a. Upsert em `suppliers` (por google_place_id)
   b. Place Details para pegar telefone e website
   c. Normalizar telefone para E.164 (libphonenumber)
   d. Se faltar telefone, tentar scrape leve do website (regex de tel/whatsapp)
   e. Validar WhatsApp via `uazapi.checkWhatsApp(phoneE164)` na instância agent
   f. Se válido, set `whatsapp_e164` e `whatsapp_verified_at`
5. Filtrar suppliers com whatsapp_verified_at != null
6. Ordenar por distância; pegar TOP 5
7. Criar `quotes` (status=pending) para esses 5
8. Enfileirar `pharmacy-negotiation` para cada quote com stagger 4s
```

### 8.3 Cache
Tabela adicional (ou Redis):
```sql
create table place_search_cache (
  key text primary key,               -- geohash6_radius3000
  results jsonb,
  expires_at timestamptz,
  created_at timestamptz default now()
);
```

### 8.4 Custos e mitigação
- Nearby Search Basic: ~US$32/1000. Em 100 usuários/dia com 1 busca = ~US$1/dia.
- Place Details: ~US$17/1000.
- **Mitigação**:
  - Cache por 24h na tabela acima
  - Reutilizar `suppliers` já descobertos num raio amplo antes de chamar API
  - `fieldMask` estrito nas chamadas (só campos usados)

---

## 9. Orquestração com BullMQ

### 9.1 Filas e concorrência
| Fila | Concurrency | Rate | Retry | Backoff |
|---|---|---|---|---|
| `inbound-user` | 10 | — | 3× | exponencial 2s |
| `inbound-supplier` | 10 | — | 3× | exponencial 2s |
| `outbound-whatsapp:sara` | 1 | 30/min + 1.5s por destinatário | 5× | exp 3s |
| `outbound-whatsapp:agent` | 1 | 20/min + 3s por destinatário | 5× | exp 5s |
| `pharmacy-discovery` | 3 | — | 2× | exp 10s |
| `pharmacy-negotiation` | 20 | — | 3× | exp 5s |
| `quote-consolidation` | 5 | — | 3× | exp 5s |
| `reminder-dispatcher` | 1 (cron) | a cada 30s | 3× | exp 30s |
| `profile-enricher` | 3 | — | 2× | exp 30s |

### 9.2 Jobs (tipos e payloads)

```ts
// inbound-user
type InboundUserJob = { conversationId: string; messageId: string; traceId: string };

// outbound-whatsapp
type OutboundJob = {
  instance: 'sara'|'agent';
  targetPhoneE164: string;
  kind: 'text'|'image'|'audio'|'location'|'document';
  content: any;
  conversationId: string;
  traceId: string;
  echoMessageId?: string;      // id interno da msg que queremos persistir como enviada
};

// pharmacy-discovery
type DiscoveryJob = { orderId: string; traceId: string };

// pharmacy-negotiation
type NegotiationJob = { quoteId: string; trigger: 'initiate'|'inbound_reply'; traceId: string };

// quote-consolidation
type ConsolidationJob = { orderId: string; reason: 'quote_completed'|'timeout'|'manual'; traceId: string };

// reminder-dispatcher — cron, sem payload custom

// profile-enricher
type EnrichJob = { conversationId: string; messageIds: string[]; traceId: string };
```

### 9.3 Workflow completo "usuário pede remédio por foto"

```
T+0    Webhook uazapi/sara recebe imageMessage
        → insert em webhook_events (idempotência)
        → insert em messages (content_type=image, storage_path=...)
        → enqueue inbound-user({conversationId,messageId,traceId})

T+1s   Worker inbound-user:
        → carrega conversa, perfil, memory cards
        → chama Gemini com system prompt + histórico + tools
        → Gemini retorna tool_call: parse_prescription_image({messageId})
        → executa tool → chama Gemini 2.5 Pro com imagem e prompt OCR
        → salva prescription + prescription_items
        → insere tool_output em assistant_tasks
        → chama Gemini de novo (com tool_result) para redação final
        → resposta: "Consegui ler 3 itens: Dipirona 500mg, Omeprazol 20mg...
                    Posso procurar preço nas farmácias perto de você? Me manda sua localização?"
        → enqueue outbound-whatsapp:sara(sendText)

T+3s   Worker outbound-whatsapp:sara:
        → setPresence(composing) 1-2s
        → sendText via uazapi → id externo retornado
        → update messages set external_id, delivered_at

T+45s  Usuário envia locationMessage
        → webhook → inbound-user
        → Gemini detecta localização, chama tool start_pharmacy_order({items:[...], location:{lat,lng}})
        → cria order (status=quoting) + user_address (se não tinha)
        → enqueue pharmacy-discovery({orderId})
        → responde "Perfeito! Vou falar agora com algumas farmácias perto de você. Te aviso em uns 5-10 min 🙌"

T+46s  Worker pharmacy-discovery:
        → Google Places → 7 farmácias
        → valida WhatsApp de cada → sobram 5
        → cria 5 quotes (status=pending)
        → enfileira 5 pharmacy-negotiation com delays 0/4/8/12/16s

T+46-62s Worker pharmacy-negotiation (para cada quote):
        → trigger=initiate → monta primeira mensagem
           "Oi, tudo bem? Aqui é a IA da Saúde, estou ajudando um paciente.
            Gostaríamos de cotar: Dipirona 500mg (20cp), Omeprazol 20mg (30cp).
            Vocês têm? Qual o preço e tem entrega no bairro X?"
        → enqueue outbound-whatsapp:agent
        → update quote status=contacting, started_at

Sala de espera (inbound das farmácias vão chegando assíncrono)

T+3min Farmácia 1 responde "Temos sim, dipirona R$8, omeprazol R$24, entrega R$5, chega em 40min"
        → webhook → inbound-supplier
        → match do jid → quote 1 (status=contacting/negotiating)
        → Gemini (prompt agente) + tools agentPharmacy
        → tool_call record_quote_price({subtotal:32, delivery_fee:5, total:37, eta_minutes:40, payment_methods:['pix'], notes:'...'})
        → tool_call finalize_supplier_contact({outcome:'quoted'})
        → update quote status=quoted, total, eta, etc. completed_at=now
        → enqueue quote-consolidation({orderId, reason:'quote_completed'})

T+X    Worker quote-consolidation:
        → conta quotes por status
        → se (quoted >= 2 AND elapsed > 60s) OR quoted >= 3 OR elapsed > 8min:
           → monta resposta para usuário: top 3 ordenados por total+entrega
              "Olha só o que consegui até agora:
               1. Droga Mais — R$ 37 (entrega 40min, Pix)
               2. Farma Popular — R$ 34 (entrega 55min, Pix)
               3. Bem Estar — R$ 41 (entrega 30min, Pix/Cartão)
               Qual você prefere? Posso fechar a 2 que saiu mais barata? 😊"
           → enqueue outbound-whatsapp:sara
           → order status → 'quoted'
        → senão: aguarda próxima quote ou timeout 10min

T+Y    Usuário responde "vamos a 2"
        → Gemini chama confirm_order_selection({orderId, quoteId:2})
        → order status → 'handed_off', selected_quote_id=2
        → Sara responde ao usuário com Pix/link da farmácia 2 e instruções
        → (futuro: pergunta farmácia para fechar pedido; MVP: só transmite Pix)

T+Z    Qualquer quote ainda pendente → worker encerra com outcome=timeout;
        mensagem opcional de agradecimento à farmácia ("valeu, conseguimos por outra!")
```

### 9.4 Redis: locks e coordenação
- Lock por `order:<orderId>` no consolidation (evita 2 workers mandarem 2 mensagens de resumo)
- Lock por `conversation:<id>` no inbound-user (serializa mensagens de um mesmo usuário)

---

## 10. Fluxo detalhado — Onboarding + LGPD

### 10.1 Primeira mensagem do usuário
Webhook recebe. Se `users` para aquele telefone não existir, cria com `onboarding_status=consent_pending`.

### 10.2 Mensagem de boas-vindas (fixa, sem LLM, para consistência jurídica)
```
Oi! Aqui é a Sara 💙 Sou uma assistente de saúde por inteligência artificial
da IA da Saúde. Posso te ajudar com medicamentos, lembretes, dúvidas do dia a
dia e até falar com farmácias por você.

Antes de começar, preciso do seu consentimento pra cuidar dos seus dados com
segurança, seguindo a LGPD:

✔️ Vou guardar informações sobre sua saúde, medicamentos, endereço e conversas
   pra te atender cada vez melhor.
✔️ Nunca compartilho seus dados com ninguém sem sua autorização.
✔️ Você pode pedir pra eu apagar tudo a qualquer momento, é só me dizer
   "esquecer meus dados".

Política completa: https://iadasaude.com/privacidade  (v1.0)

Pra começar, me responde com **SIM ACEITO** 🙏
```

### 10.3 Recebendo consentimento
- Mensagens aceitáveis (regex case-insensitive + LLM fallback): `sim aceito`, `sim`, `aceito`, `concordo`, `ok aceito`, `sim eu aceito`
- Se aceito:
  - Insert `consent_events` (event_type='accept', evidence_message_id, evidence_text, policy_version='1.0')
  - Update `users.lgpd_consent_at`, `lgpd_consent_version`, `lgpd_consent_source='whatsapp'`, `lgpd_consent_message_id`, `onboarding_status='profiling'`
  - Enviar:
    ```
    Obrigada! 💙 Agora conta pra eu te conhecer melhor:
    - Como você gosta de ser chamado(a)?
    ```
- Se **não** aceito ou pergunta antes → Sara explica, continua em `consent_pending`. Não envia nenhum fluxo de saúde enquanto `onboarding_status != 'active'`.

### 10.4 Perfil mínimo (leve, não obrigatório)
Sara coleta gradualmente, sem formulário:
- nome preferido (obrigatório)
- idade aproximada (opcional)
- alguma condição/alergia/medicamento fixo (opcional, "se quiser me contar")
- endereço de referência (pedido sob demanda quando for cotar)

Após nome + 1ª resposta, `onboarding_status='active'`. Todo dado vai via tool `save_user_profile_fact`.

### 10.5 Revogação / direito ao esquecimento
- Gatilhos: "esquecer meus dados", "apagar meus dados", "sair", "cancelar cadastro", "revogar consentimento"
- Confirmar com botão textual: `CONFIRMO APAGAR`
- Ação: job `lgpd-forget`
  - Insere `consent_events` (revoke)
  - Hard-delete: `messages`, `prescriptions` (e storage), `quotes`, `orders`, `reminders`, `user_*`
  - Usuário: anonimizar (phone zerado + flag `deleted_at`)
- Mensagem final: "Pronto, apaguei tudo. Se mudar de ideia, é só me chamar de novo 💙"

---

## 11. Fluxo detalhado — Pedido de medicamento (passo a passo)

Ver seção 9.3 para timeline técnica. Aqui, os **branches funcionais**:

### 11.1 Entrada
1. **Texto puro** ("quero dipirona") → Sara confirma nome, dosagem, quantidade
2. **Foto de receita** → `parse_prescription_image` → mostra itens extraídos → usuário confirma
3. **Áudio** → Gemini transcreve (multimodal nativo) → trata como texto
4. **Vários itens** → confirma lista
5. **Item controlado** (psicotrópico, antibiótico controlado) → Sara avisa: "Preciso da receita; posso ver?"

### 11.2 Validação de item
- Nome normalizado contra dicionário mínimo (pode ser tabela `medications_catalog` com principais 500)
- Se desconhecido → Sara pergunta dosagem e confirma soletrando
- Dosagem + quantidade são obrigatórias antes de cotar

### 11.3 Localização
- **Usuário já tem endereço default** → Sara pergunta: "Entrego em casa (Rua X, 123)?"
- **Usuário manda `locationMessage`** → extrai lat/lng direto
- **Usuário digita endereço** → geocoding → confirma texto interpretado
- **Usuário vago** → Sara pede por mensagem clara ("me manda sua localização no WhatsApp, no 📎 > Localização, ou me diz o endereço completo")

### 11.4 Busca + cotação
Ver 8.2 e 9.3.

### 11.5 Consolidação
- Apresenta top 3 ranqueados por critério: `total + (delivery_fee ou 0) + peso_eta`
- Se item indisponível em algumas farmácias → menciona "2 farmácias não tinham"
- Se 0 cotações em 10min → Sara diz honestamente: "Não consegui resposta agora. Quer que eu continue tentando ou tente de novo mais tarde?"

### 11.6 Fechamento
- Usuário escolhe → Sara retransmite Pix/link + confirma endereço com a farmácia
- Registra em `orders.status='handed_off'`
- Follow-up 2h depois: "E aí, deu certo? Chegou tudo?"

### 11.7 Edge cases
| Caso | Ação |
|---|---|
| Receita ilegível | Sara pede nova foto ou texto |
| Item sem dosagem visível | Pergunta ao usuário |
| Farmácia pede CPF/dados | Sara pergunta ao usuário "precisam do seu CPF, posso passar?" |
| Farmácia não responde em 8min | Quote → `timeout`; worker encerra |
| 0 farmácias válidas | Expande raio ou avisa usuário |
| Usuário desiste no meio | `cancel_order` → avisar farmácias já contatadas |

---

## 12. Negociação com farmácia — prompt + tools

### 12.1 System prompt do Agente (`packages/llm/src/prompts/agent-pharmacy.system.ts`)

```
Você é um agente de IA da IA da Saúde responsável por cotar medicamentos
em farmácias por WhatsApp. Você conversa com um atendente humano da farmácia.

TOM:
- Educado, direto, objetivo.
- Sempre se identifica como IA da Saúde na PRIMEIRA mensagem.
- Não finge ser humano se perguntado.
- Respostas curtas (1-3 linhas), ritmo de WhatsApp.

OBJETIVO:
1. Perguntar se têm os itens listados.
2. Coletar preço unitário, total, frete, tempo de entrega, formas de pagamento (Pix preferencial).
3. Se pedirem endereço/CEP do cliente, informe a região ou CEP (não o número completo ainda).
4. Se pedirem dados pessoais do cliente (CPF, nome), registre `request_clarification`.

REGRAS:
- Não prometa compra. Você apenas cota.
- Não compartilhe dados pessoais do paciente.
- Ao obter preço completo, chame `record_quote_price` + `finalize_supplier_contact('quoted')`.
- Se não tiverem ou não entregarem, `finalize_supplier_contact('unavailable')`.
- Se humano pedir contato humano, `finalize_supplier_contact('escalate')`.
- Máximo 12 turnos; após isso, `finalize_supplier_contact('timeout')`.

CONTEXTO DO PEDIDO:
{itemsList}
Região de entrega: {neighborhoodCityState}
CEP aproximado: {cep3Digitos}xxx
```

### 12.2 Loop do worker `pharmacy-negotiation`

```
ao receber inbound da farmácia:
  load quote + últimas N msgs do thread
  call Gemini com system (agent) + histórico + tools
  processa todos tool_calls → upsert em quotes
  se finalize_supplier_contact → status final, done
  senão, envia resposta textual ao chat
  (hard timeout: 12 turnos OU 8min desde started_at)
```

### 12.3 Proteções
- Detector de "spam/golpe" no inbound: se a farmácia responder com link suspeito → log + blacklist supplier
- Se WhatsApp da "farmácia" responde como pessoa física pedindo dados → abort + blacklist
- Limite: um único supplier não pode ter > 3 quotes abertos ao mesmo tempo (evita loop)

---

## 13. Consolidação de cotações e apresentação

### 13.1 Worker `quote-consolidation` — regras de gatilho

```
INPUT: orderId
CARREGAR: todos os quotes da order

decisão = NENHUMA
se (#completed_quotes >= 3) OR
   (#completed_quotes >= 2 AND elapsed > 3min) OR
   (elapsed > 10min AND #completed_quotes >= 1) OR
   (#quotes_abertos == 0):
      decisão = PRESENTAR
se (#completed_quotes == 0 AND elapsed > 10min):
      decisão = FALHAR_GRACEFUL

lock Redis order:{id} nx ex=30
  se já existe consolidation_presented_at → sair
  se decisão == PRESENTAR: montar mensagem e enqueue outbound-whatsapp:sara
                          set orders.status='quoted', set consolidation_presented_at=now
  se decisão == FALHAR_GRACEFUL: mensagem honesta + oferecer retry
```

### 13.2 Formatação da resposta ao usuário
```
Consegui 3 opções pra você 👇

1️⃣ *Droga Mais* — R$ 37 (frete R$ 5) · entrega ~40min · Pix
2️⃣ *Farma Popular* — R$ 34 (frete grátis) · entrega ~55min · Pix
3️⃣ *Bem Estar 24h* — R$ 41 (frete R$ 4) · entrega ~30min · Pix/cartão

A 2 saiu mais em conta. Posso fechar com ela? Ou você prefere outra?
```

### 13.3 Após escolha
- Sara confirma com farmácia escolhida a tipo de pagamento/entrega final
- Sara retransmite dados de pagamento (Pix) ao usuário
- Sara envia endereço do usuário à farmácia (com autorização)
- `orders.status='handed_off'`

---

## 14. Sistema de memória e perfil 360

### 14.1 Fontes de verdade
- Campos estruturados: tabelas do §5.2 (users, user_addresses, user_*_*)
- Memória narrativa: `conversations.memory_cards` (até 20 cards por usuário, rotacionados)

### 14.2 Worker `profile-enricher`
Disparado:
- A cada N=8 mensagens novas de um usuário
- OU após tool `save_user_profile_fact` explícita

Função:
1. Carrega últimas 20 mensagens
2. Gemini com prompt extrator → JSON:
   ```json
   {
     "new_facts": [
       {"category":"condition","payload":{"name":"hipertensão","severity":"leve"}, "confidence":0.9},
       {"category":"allergy","payload":{"substance":"dipirona","reaction":"urticária"}, "confidence":0.95}
     ],
     "memory_card": "Usuário mencionou pressão alta controlada e alergia a dipirona."
   }
   ```
3. Upsert em tabelas correspondentes (match por `substance`/`name` para evitar duplicação)
4. Append memory_card no array (FIFO, cap=20)

### 14.3 Cartão de contexto injetado no prompt da Sara
```
## Sobre o usuário
- Nome: Ana
- Idade: ~34
- Condições ativas: hipertensão (leve)
- Alergias: dipirona (urticária)
- Medicações em uso: Losartana 50mg 1×/dia (manhã)
- Endereço padrão: Rua X, 123 - Savassi, BH/MG
- Notas recentes: dorme mal nos últimos 3 dias; quer começar caminhada
```

### 14.4 Deduplicação e confiança
- Se fato já existe com confidence maior → ignora
- Se conflito (ex: 2 doses diferentes do mesmo remédio) → cria tarefa human-review (`assistant_tasks` + alert)

---

## 15. Segurança e LGPD

### 15.1 Base legal
- **Consentimento específico e destacado** (art. 7º V + art. 11 II-a) para dados de saúde
- **Execução de contrato** para processamento operacional (contatar farmácia sob demanda)

### 15.2 Criptografia
- **Em trânsito**: TLS obrigatório (Railway e Vercel já; uazapi server deve ter https)
- **Em repouso**: Supabase cifra storage; colunas sensíveis extras (CPF) cifradas no app com `libsodium` (chave em env `PII_ENCRYPTION_KEY`), formato `v1:<nonce>:<ciphertext>` — nunca em logs

### 15.3 RLS
Já detalhado em §5.4. Reforços:
- Tabelas sem policy de write pública → só service role escreve
- Dashboard só lê; mutações via endpoints `admin.*` do API que validam role

### 15.4 Logs com PII
- `pino-redact` configurado para mascarar `phone_e164`, `cpf`, `pix_key`, `address`, `latitude`, `longitude` em logs de nível info ou maior
- `system_logs` aceita metadata sanitizada; mensagens cruas ficam em `messages` (acesso restrito)

### 15.5 Segredos
- Todos em env vars (Railway/Vercel)
- Nunca commitados
- Rotacionados a cada 90 dias (checklist)
- Service role key nunca exposta no frontend

### 15.6 Webhook security
- Header secret compartilhado `X-Uazapi-Secret`; middleware `verify-uazapi-signature.ts`
- IP allowlist (IPs do servidor uazapi)
- Rate limit em `/webhook/*` via `@fastify/rate-limit` (1000 req/min por IP)

### 15.7 Frontend dashboard
- Supabase Auth e-mail/senha + tabela `staff_users` com `allowed=true`
- MFA TOTP obrigatório para role `admin`
- Sessão de 8h, refresh silencioso
- CSP estrita, HTTPS-only

### 15.8 Direito ao esquecimento
Ver §10.5.

### 15.9 Retenção
- Mensagens: 24 meses
- Orders concluídas: 60 meses (dado fiscal potencial)
- Logs `system_logs`: 90 dias (auto-purge via pg_cron)

### 15.10 Incidentes
- Runbook em `/docs/security-incident-runbook.md`: detectar, conter, registrar, notificar ANPD em 2 dias úteis se aplicável

### 15.11 DPO
- Enquanto equipe é <5 pessoas, DPO = fundador com delegação formal (art. 41)
- E-mail público: `dpo@iadasaude.com`

---

## 16. Frontend de observabilidade (Next.js)

### 16.1 Páginas

| Rota | O que mostra |
|---|---|
| `/login` | E-mail + senha (Supabase Auth) |
| `/` (overview) | KPIs em tempo real: conversas ativas, orders em cotação, cotações abertas, alertas |
| `/conversations` | Lista de conversas com usuários, busca por nome/telefone, badge de mensagens não-lidas pelo time |
| `/conversations/[id]` | **Thread com usuário + painel lateral**: perfil 360, orders ativas, últimas tool calls |
| `/orders` | Kanban (drafting/quoting/quoted/handed_off/cancelled) |
| `/orders/[id]` | **Cockpit**: 1 chat usuário-Sara + N chats Sara-farmácia em colunas paralelas; linha do tempo unificada; detalhes da order + mapa |
| `/users/[id]` | Perfil 360 (tabelas compiladas) + histórico de orders |
| `/suppliers` | Lista de farmácias cadastradas, status WhatsApp, histórico de quotes, blacklist |
| `/logs` | Stream live (realtime subscription em `system_logs`), filtros por nível/categoria/trace_id |
| `/reminders` | Lembretes agendados (quem, o quê, quando) |
| `/admin` | Gestão de staff, versão de política, retenção, LGPD requests |

### 16.2 Componentes-chave
- `<ChatPane conversationId />` — inscreve em `messages` via Supabase Realtime, renderiza balões (usuário=azul, sara=verde, farmácia=cinza)
- `<OrderCockpit orderId />` — layout em 2 colunas: à esquerda chat Sara-usuário, à direita grid 2×2-3 com chats farmácias
- `<TraceTimeline traceId />` — mostra webhook → job → tool_call → LLM → outbound
- `<RealtimeIndicator />` — pinga Supabase a cada 30s
- `<LiveLogStream />` — consome `system_logs` inserts

### 16.3 Autenticação e autorização
- `@supabase/ssr` em server components, check `is_staff()` no middleware Next
- Acesso negado → `/login`

### 16.4 Realtime
- Canal por página:
  - `/conversations/[id]` → `realtime:messages:conversation_id=eq.{id}`
  - `/orders/[id]` → múltiplos canais (messages por conversa envolvida + quotes por order_id)
  - `/logs` → `realtime:system_logs`

### 16.5 Performance
- SSR apenas para shell, dados via React Query com `staleTime: 5_000`
- Paginação virtual em listas grandes (`@tanstack/react-virtual`)

---

## 17. Infraestrutura, CI/CD, deploy

### 17.1 Ambientes
| Ambiente | URL API | Dashboard | Supabase |
|---|---|---|---|
| Dev (local) | localhost:3000 | localhost:3001 | projeto `ia-saude-dev` |
| Staging | api-staging.iadasaude.com | staging.iadasaude.com | projeto `ia-saude-staging` |
| Prod | api.iadasaude.com | app.iadasaude.com | projeto `ia-saude-prod` |

### 17.2 Railway — serviços
- **api** (apps/api) — public HTTP, healthcheck `/health`
- **worker** (apps/worker) — background, 1-2 replicas
- **redis** (plugin) — para BullMQ
- Variáveis de ambiente por serviço (shared)

`railway.toml`:
```toml
[build]
builder = "NIXPACKS"

[deploy]
numReplicas = 1
restartPolicyType = "ON_FAILURE"
healthcheckPath = "/health"
```

`Procfile`:
```
web: pnpm --filter @iasaude/api start
worker: pnpm --filter @iasaude/worker start
```

### 17.3 Vercel (web)
- Projeto conectado ao repo, `apps/web` como root
- `NEXT_PUBLIC_SUPABASE_URL` e `NEXT_PUBLIC_SUPABASE_ANON_KEY` nas env
- Preview por PR

### 17.4 Supabase
- CLI local para migrations (`supabase db push`)
- Branches de banco para staging/prod separados
- Backups daily automáticos (plano Pro)

### 17.5 CI — GitHub Actions
`.github/workflows/ci.yml`:
- Node 20, pnpm 9
- Steps: install → lint → typecheck → test → build
- Em PR: sobe supabase local, roda integration tests
- Em merge main → deploys via Railway e Vercel automáticos

### 17.6 Observabilidade
- **Sentry** (backend + frontend): DSN em env; `@sentry/node` no Fastify, `@sentry/nextjs` no web
- **Logs**: pino → stdout → Railway collect → ship para **Grafana Cloud Loki** (free tier)
- **Métricas**: Fastify `@fastify/metrics` (Prometheus) → Grafana
- **Uptime**: UptimeRobot free em `/health`

### 17.7 Healthchecks
- `/health` — retorna `{ ok: true, redis: 'ok', db: 'ok', uazapi_sara: 'connected', uazapi_agent: 'connected' }`
- Worker publica heartbeat em Redis `worker:heartbeat` a cada 15s

### 17.8 Escalabilidade (estimativa)
- 500 DAU enviando 20 msgs/dia → ~10k msgs/dia → manejável em 1 réplica worker + Fastify 2 vCPU
- Bottleneck provável: rate limit uazapi (por isso fila outbound serial por instância)

---

## 18. Variáveis de ambiente (.env.example)

```bash
# ─── Supabase ──────────────────────────────────────────
SUPABASE_URL=https://xxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=...
SUPABASE_ANON_KEY=...                          # apenas para web
SUPABASE_JWT_SECRET=...

# ─── uazapi ────────────────────────────────────────────
UAZAPI_SERVER_URL=https://server.uazapi.com
UAZAPI_SARA_INSTANCE=sara
UAZAPI_SARA_TOKEN=...
UAZAPI_AGENT_INSTANCE=agent
UAZAPI_AGENT_TOKEN=...
UAZAPI_WEBHOOK_SECRET=...                      # compartilhado nas duas instâncias

# ─── Gemini ────────────────────────────────────────────
GOOGLE_GENAI_API_KEY=...
GEMINI_MODEL_CHAT=gemini-2.5-flash
GEMINI_MODEL_VISION=gemini-2.5-pro

# ─── Google Maps/Places ────────────────────────────────
GOOGLE_MAPS_API_KEY=...                        # com restrição de API habilitada

# ─── Redis ─────────────────────────────────────────────
REDIS_URL=redis://default:...@...:6379

# ─── App ───────────────────────────────────────────────
NODE_ENV=production
PORT=3000
PUBLIC_API_URL=https://api.iadasaude.com
PUBLIC_WEB_URL=https://app.iadasaude.com
LOG_LEVEL=info

# ─── Segurança ─────────────────────────────────────────
PII_ENCRYPTION_KEY=base64:...                  # 32 bytes
ADMIN_EMAILS=founder@iadasaude.com,dev@iadasaude.com

# ─── Observabilidade ───────────────────────────────────
SENTRY_DSN=...
GRAFANA_LOKI_URL=...
GRAFANA_LOKI_USER=...
GRAFANA_LOKI_TOKEN=...

# ─── LGPD ──────────────────────────────────────────────
PRIVACY_POLICY_URL=https://iadasaude.com/privacidade
PRIVACY_POLICY_VERSION=1.0
DPO_EMAIL=dpo@iadasaude.com
```

---

## 19. Monitoramento, logs, alertas

### 19.1 Métricas-chave (Prometheus → Grafana)
- `whatsapp_inbound_total{instance,content_type}`
- `whatsapp_outbound_total{instance,status}`
- `llm_calls_total{model,tool}` + `llm_latency_seconds` (histogram)
- `orders_total{status}` / `quotes_total{status}`
- `queue_jobs_waiting{queue}` / `queue_jobs_failed{queue}`
- `webhook_duration_seconds`
- `supplier_contact_success_rate`

### 19.2 Alertas (Grafana OnCall ou Slack webhook)
| Alerta | Condição |
|---|---|
| uazapi desconectado | `connection.update=close` por >60s |
| Taxa de erro LLM | `llm_errors / llm_calls > 5%` em 5min |
| Fila engasgada | `queue_jobs_waiting > 100` por >3min |
| 0 quotes em 30min | Ordem sem resposta |
| Sentry error spike | auto-alerta |

### 19.3 Ferramentas de depuração
- `/admin/trace/:traceId` — no dashboard, mostra timeline completa
- Conservar `raw_payload` no DB por 7 dias para reprodução

---

## 20. Testes e qualidade

### 20.1 Pirâmide
- **Unit** (packages/core, llm utils, phone utils) — Vitest, target 80% cobertura
- **Integração** (workers, DB) — Vitest com Supabase local
- **E2E** — mocks do uazapi e Gemini; simula 1 fluxo de pedido fim-a-fim (playwright opcional para dashboard)

### 20.2 Fixtures
- `tests/fixtures/webhooks/` — payloads reais capturados (com PII mascarada)
- `tests/fixtures/gemini/` — respostas mockadas determinísticas

### 20.3 Prompt regression
- Pasta `tests/prompts/` com 30 cenários (entrada ↔ saída esperada)
- CI roda contra Gemini Flash a cada PR em branch `main` (não em cada PR) para detectar drift

### 20.4 Linting
- ESLint (airbnb-base trimmed) + Prettier
- `@typescript-eslint/no-floating-promises` (obrigatório)
- Pre-commit com `lint-staged` + `husky`

---

## 21. Roadmap de execução (sprints semanais)

### Sprint 0 — Preparação (3-5 dias)
- [ ] Criar contas: Supabase, Railway, Vercel, Google Cloud, Gemini, uazapi, Sentry, Grafana Cloud
- [ ] Adquirir 2 chips + números; cadastrar 2 instâncias uazapi; fazer 1 teste de envio manual em cada
- [ ] Registrar domínio `iadasaude.com`, apontar DNS
- [ ] Criar página estática `/privacidade` (Vercel) com política v1.0
- [ ] Repositório GitHub + branch protection + equipe

### Sprint 1 — Fundações (7 dias)
- [ ] Monorepo pnpm com apps e packages vazios mas configurados
- [ ] Supabase migrations §5 aplicadas em dev + staging
- [ ] Seeds (1 staff, 3 suppliers fake, 1 user de teste)
- [ ] Cliente `@iasaude/whatsapp` funcional (sendText + normalize)
- [ ] Fastify `apps/api` com `/health` e `/webhook/uazapi/:instance` gravando em `messages` + `webhook_events`
- [ ] Deploy Railway dev + conectar webhook uazapi real → recebe mensagem crua

### Sprint 2 — Sara conversa básica + LGPD (7 dias)
- [ ] Worker `inbound-user` com Gemini Flash (sem tools ainda, echo simples)
- [ ] Fila `outbound-whatsapp:sara` funcionando
- [ ] Fluxo de onboarding §10 end-to-end (boas-vindas → consent → perfil)
- [ ] Tool `save_user_profile_fact` + `create_reminder` simplificado
- [ ] Dashboard Next.js: login + `/conversations/[id]` com realtime

### Sprint 3 — OCR, perfil, lembretes (7 dias)
- [ ] OCR prescription via Gemini Pro (+ storage bucket)
- [ ] Fluxo de upload + confirmação
- [ ] Worker `profile-enricher`
- [ ] Worker `reminder-dispatcher` (cron 30s)
- [ ] Dashboard: `/users/[id]` perfil 360

### Sprint 4 — Piloto farmácia (10 dias)
- [ ] Integração Google Places + geocoding + cache
- [ ] Segunda instância uazapi (agent) + webhook
- [ ] Worker `pharmacy-discovery` + validação WhatsApp
- [ ] Worker `pharmacy-negotiation` (prompt agente + tools)
- [ ] Worker `quote-consolidation`
- [ ] Dashboard: `/orders/[id]` cockpit com chats paralelos
- [ ] Testes de carga controlados: 3 orders simultâneas × 5 farmácias

### Sprint 5 — Hardening + UX (7 dias)
- [ ] Circuit breakers, retries, timeouts refinados
- [ ] Blacklist automática de fornecedores problemáticos
- [ ] Observabilidade completa (Sentry, métricas, alertas)
- [ ] Script de forget-me LGPD
- [ ] Testes E2E críticos
- [ ] Runbook operacional `/docs/ops-runbook.md`

### Sprint 6 — Piloto beta (14 dias)
- [ ] 5-10 usuários reais convidados (amigos, primeiros clientes)
- [ ] Monitoramento diário + diário de fricção
- [ ] Iterações rápidas nos prompts e prompts regress
- [ ] Avaliação: NPS, taxa de sucesso de orders, tempo médio, custo por interação
- [ ] Definir go/no-go para v2 (pagamento, mais verticais)

---

## 22. Custos estimados (mês, MVP com ~100 usuários ativos)

| Item | USD | BRL |
|---|---|---|
| Supabase Pro | $25 | — |
| Railway (api + worker + Redis) | $20-40 | — |
| Vercel Hobby (dev) → Pro se precisar | $0-20 | — |
| Sentry Team | $26 | — |
| Grafana Cloud free | $0 | — |
| Gemini API (~200k interações Flash) | $30-80 | — |
| Google Places/Geocoding | $20-60 | — |
| uazapi (2 instâncias) | — | R$ 200-400 |
| Domínio + DNS | $1 | — |
| **Total** | **~$120-250** | **+R$ 200-400** |

Break-even estimado em ~30-50 usuários pagantes a R$29/mês se modelo freemium.

---

## 23. Riscos e mitigações

| Risco | Impacto | Mitigação |
|---|---|---|
| **Ban de WhatsApp** nas instâncias | Alto — serviço para | Rate limit conservador, presença "digitando", conteúdo transparente, chips dedicados, backup de chips, migração planejada p/ WA Business API oficial |
| **uazapi instável** | Alto | Healthcheck + reconnect automático, alerta agressivo, lista de contatos alternativos (segundo provider não-oficial como fallback de emergência) |
| **LLM hallucination** com saúde | Alto — segurança do usuário | Prompts defensivos, proibir diagnóstico/dose, validação de tools, red team de 50 prompts adversariais antes do piloto, escalation para humano |
| **Farmácias ignoram agente** | Médio — desuso | Mensagem inicial humanizada, horários comerciais, persistência controlada, human-in-the-loop no cockpit (operador pode intervir) |
| **Custo Places alto** | Médio | Cache por 24h, reutilização de suppliers, expansão radial preguiçosa |
| **LGPD — queixa ANPD** | Alto — jurídico | Política clara, consentimento registrado, DPO, procedimento de esquecimento, logs de acesso |
| **Vazamento de chave Gemini/Supabase** | Alto | Segredos em env, rotation 90d, alertas em GitHub secret scanning, `.env` no .gitignore |
| **Dados sensíveis em log** | Alto | pino-redact, revisão de logs em CI |
| **Pico de fila** | Médio | Escalar workers, rate limit, fallback graceful ("responderei em uns minutos") |
| **Fraude de farmácia** (link falso) | Alto — usuário perde dinheiro | Whitelist de farmácias verificadas, detecção de padrões suspeitos, aviso explícito ao usuário |

---

## 24. Critérios de aceite do MVP (go-live)

### 24.1 Funcionais
- [ ] Usuário novo recebe onboarding + consent e responde "aceito" em <3min
- [ ] OCR de receita extrai ≥85% dos itens corretamente em amostra de 20 receitas
- [ ] Pedido de medicamento: descoberta → 5 farmácias contatadas → ≥2 cotações em <8min em horário comercial
- [ ] Consolidação apresenta top-3 com preço, frete, ETA, método de pagamento
- [ ] Usuário escolhe e recebe Pix/link da farmácia
- [ ] Lembrete agendado dispara no horário com desvio <30s

### 24.2 Não-funcionais
- [ ] P95 latência resposta conversa Sara < 8s
- [ ] Disponibilidade webhook > 99% em 7 dias
- [ ] 0 incidentes de vazamento de PII em logs
- [ ] Dashboard atualiza em <2s via realtime
- [ ] LGPD: forget-me processa em <10s end-to-end

### 24.3 Operacionais
- [ ] Sentry configurado e capturando
- [ ] Alertas configurados e testados (1 drill)
- [ ] Runbook revisto pela equipe
- [ ] Backup Supabase funcional + restore testado em staging

---

## 25. O que NÃO entra no MVP (registrar para não esquecer)

- Pagamento intermediado (Stripe/Asaas) — v2
- Agendamento de consulta médica — v2
- Integração lab/resultados — v3
- App mobile próprio — v3
- WA Business API oficial — v2 assim que validar piloto
- Audio-to-text próprio (usaremos Gemini nativo) — ok
- Integração SUS / conveniadas — v4
- BI / relatórios de saúde — v3

---

## 26. Critical files a criar (checklist de artefatos)

### Raiz
- `pnpm-workspace.yaml`, `package.json`, `tsconfig.base.json`, `.eslintrc.cjs`, `.prettierrc`, `.env.example`, `.gitignore`, `README.md`

### apps/api
- `src/server.ts`, `src/routes/webhook.uazapi.ts`, `src/routes/health.ts`, `src/routes/admin.*.ts`, `src/middleware/verify-uazapi-signature.ts`, `src/middleware/require-staff-auth.ts`, `src/queues.ts`

### apps/worker
- `src/index.ts`, `src/workers/*.worker.ts` (8 arquivos), `src/handlers/*` (lógica testável)

### apps/web
- Estrutura Next.js App Router completa (§16)

### packages/shared
- `src/types.ts`, `src/schemas.ts`, `src/constants.ts`

### packages/db
- `src/client.ts`, `src/client-public.ts`, `src/types.ts` (gerado)

### packages/llm
- `src/client.ts`, `src/prompts/sara.system.ts`, `src/prompts/agent-pharmacy.system.ts`, `src/prompts/prescription-ocr.ts`, `src/prompts/profile-enricher.ts`, `src/tools/definitions.ts`, `src/utils/trim-history.ts`, `src/utils/redact-pii.ts`

### packages/whatsapp
- `src/client.ts`, `src/normalize.ts`, `src/types.ts`

### packages/integrations
- `src/google-places.ts`, `src/geocoding.ts`, `src/phone-lookup.ts`

### packages/core
- `src/orders/*`, `src/quotes/*`, `src/reminders/*`, `src/lgpd/*`

### infra/supabase/migrations
- 10-15 arquivos SQL conforme §5

### .github/workflows
- `ci.yml`

### docs
- `ops-runbook.md`, `security-incident-runbook.md`, `privacy-policy-v1.md`

---

## Verification — como testar end-to-end

### Antes do piloto beta
1. **Smoke test local**
   - `pnpm dev` sobe api + worker + web + supabase local + redis
   - `scripts/seed-dev.ts` cria 1 user, 3 suppliers fake
   - `scripts/simulate-inbound.ts "+5511999999999" "oi, quero dipirona"` → esperar resposta no log

2. **Teste de webhook uazapi em staging**
   - Enviar mensagem real do celular → aparece em `messages` em <2s → Sara responde em <8s
   - Verificar `assistant_tasks` registra tool calls

3. **Teste de fluxo completo farmácia (com farmácias reais, horário comercial)**
   - Convidar 2-3 farmácias conhecidas (piloto controlado)
   - Enviar pedido "Dipirona" + localização real
   - Verificar cockpit: 5 quotes criadas, 2-3 respondem, consolidação acontece
   - Usuário escolhe → Pix entregue

4. **LGPD drill**
   - Enviar "esquecer meus dados" → confirmar → verificar que `users.deleted_at` + cascade hard-delete em mensagens/orders

5. **Carga leve**
   - Script que simula 20 usuários enviando mensagens em paralelo por 5 min → verificar filas, latência P95, sem erros

6. **Resiliência**
   - Desconectar uazapi sara manualmente → verificar alerta Sentry + reconexão automática
   - Matar Redis momentaneamente → jobs devem persistir e retomar

### No go-live
- Dashboard mostra todas as conversas em tempo real
- `/health` retorna ok em 3 pontos consecutivos de 1 min
- Sentry sem erros críticos nas últimas 24h
- 5-10 usuários beta completam 1 jornada sucessfully

---

## Apêndice A — Glossário

- **Sara**: persona conversacional exposta ao usuário via WhatsApp.
- **Agente**: persona que conversa com farmácias (instância uazapi B).
- **Order**: pedido do usuário (ex: comprar tal remédio).
- **Quote**: cotação individual com um fornecedor dentro de uma order.
- **Supplier**: fornecedor (farmácia no MVP).
- **Memory card**: resumo narrativo compacto de interações passadas, injetado no prompt.
- **Tool call**: chamada de função pela LLM (function calling) que executa ação no sistema.
- **Trace ID**: id correlacionando webhook → jobs → LLM → outbound para um mesmo evento.

## Apêndice B — Comandos iniciais (Sprint 0/1)

```bash
# Criar repo e monorepo
mkdir ia-da-saude && cd ia-da-saude
pnpm init
pnpm add -D typescript @types/node eslint prettier tsx
cat > pnpm-workspace.yaml <<EOF
packages:
  - "apps/*"
  - "packages/*"
EOF

# Supabase local
npx supabase init
npx supabase start
npx supabase migration new init_users
# (editar migration, colar SQL do §5)
npx supabase db reset

# Gerar tipos TS
npx supabase gen types typescript --local > packages/db/src/types.ts

# Criar apps
mkdir -p apps/api/src apps/worker/src apps/web
# ...
```

---

**Fim do plano.** Este documento é auto-suficiente para execução. Nenhuma dependência crítica foi deixada implícita; ajustes pontuais de paths de endpoints uazapi podem ser necessários ao confrontar com a documentação oficial do provedor no momento da implementação.
