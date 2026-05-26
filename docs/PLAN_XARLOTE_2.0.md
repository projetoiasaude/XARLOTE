# Xarlote 2.0 — Roadmap para Produção
> Health concierge AI brasileira via WhatsApp.
> Inspirado em padrões do **Hermes Agent (NousResearch, mar/2026)** e da geração atual de **memory frameworks** (Letta/Zep/Mem0/LangMem).
> Versão: 1.0 · Status: planejamento aprovado pendente

---

## 0. Filosofia

A Xarlote 1.x já conversa, cota farmácias e lembra de fatos. Pra ir pro 2.0 ela precisa virar **agente de verdade**: um sistema que **aprende com cada interação**, **age no mundo real** (não só responde), **mantém identidade ao longo do tempo** e tem **conhecimento estruturado** sobre cada paciente.

Quatro princípios inegociáveis:

1. **Função primeiro, conversa segunda.** Cada turno deve mover o usuário pra algo concreto: cotar, agendar, lembrar, registrar.
2. **Memória é primeiro-cidadão.** Estado do usuário não é "contexto do prompt" — é dado relacional persistente, queriable, auditável.
3. **Especialista, não chatbot.** Domínio profundo de saúde BR (medicamentos, dosagens, marcas, ANVISA, SUS, planos) > simulação de empatia.
4. **Compliance LGPD nativo, não cosmético.** Audit log, field-level encryption pra dados ultra-sensíveis, forget-me em cascata.

---

## 1. Estado atual (Xarlote 1.5)

### ✅ O que JÁ funciona em produção

| Capacidade | Como funciona hoje |
|---|---|
| Conversa WhatsApp (texto/áudio/imagem) | uazapi webhook → inbound-user → LLM → outbound |
| Voz humanizada (Carla BR) | ElevenLabs Multilingual v2, intro de boas-vindas |
| Transcrição de voz nota | ElevenLabs Scribe v1 (PT-BR nativo) |
| Cotação de farmácia automática | start_pharmacy_order → 3-5 farmácias via agent-instance → consolidação 3min/5min |
| Memória semântica persistente | `memory_cards_index` (pgvector 1536d) + decay temporal por kind |
| Profile enricher async | worker extrai facts/episodes/preferences pós-turno |
| LGPD consent + forget-me | consent_events + cascata em todas as tabelas |
| Dashboard ops | /conversations, /orders, /users, /suppliers, /logs, /prompts |
| 9 tools da Sara | save_user_profile_fact, parse_prescription_image, start_pharmacy_order, etc |

### 🚧 Gaps críticos para concierge de saúde real

| Gap | Impacto |
|---|---|
| **Sem tratamentos longitudinais** | Sara não sabe que o usuário está em tratamento contínuo de HAS há 6 meses |
| **Sem inventário de medicamentos** | Não conta comprimidos, não avisa quando vai acabar |
| **Sem adherence tracking** | User não confirma se tomou, sem feedback de adesão |
| **Sem fluxo de consulta médica** | Hoje só farmácia; usuário precisa marcar médico por fora |
| **Endereços não rotulados na prática** | Schema permite "casa"/"trabalho", mas Sara não usa |
| **Sem cache de clínicas** | Cada busca refaz Google Places do zero |
| **Sem feedback loop** | User não pode dar 👍/👎 em quote, reminder, etc |
| **Sem knowledge graph** | Relações entidade↔entidade ficam implícitas no JSONB |
| **Sem aprendizado emergente** | Padrões repetidos não viram "skills" — Sara reaprende toda vez |
| **Sem detecção de red flags** | Mensagem com "tomei 30 comprimidos" não dispara protocolo |

---

## 2. Arquitetura alvo

### 2.1 Modelo de memória em 5 camadas (Letta-inspired + Hermes)

```
┌─────────────────────────────────────────────────────────────┐
│ 1. WORKING MEMORY (turno atual)                             │
│    System prompt + tools available + current user message   │
└─────────────────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────────────────┐
│ 2. RECALL MEMORY (conversa recente)                         │
│    Últimas 30 msgs do `messages`, trimadas por trim-history │
└─────────────────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────────────────┐
│ 3. SEMANTIC MEMORY (fatos sobre o usuário)                  │
│    memory_cards_index (vector 1536d, kNN com decay)         │
│    Já existe — expandir confidence + procedência            │
└─────────────────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────────────────┐
│ 4. EPISODIC MEMORY (eventos passados)                       │
│    orders, consultations, symptoms_log, medication_log      │
│    Queriable: "última vez que tomou ibuprofeno?"            │
└─────────────────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────────────────┐
│ 5. PROCEDURAL MEMORY (skills aprendidas)                    │
│    agent_skills — padrões detectados >=3x viram atalho      │
│    Ex: "user pede Losartana → SEMPRE oferece Hidroclor."    │
└─────────────────────────────────────────────────────────────┘
            ↕
┌─────────────────────────────────────────────────────────────┐
│ KNOWLEDGE GRAPH (entity_relations)                          │
│    user--takes-->medication--treats-->condition             │
│    medication--prescribed_by-->prescriber--at-->clinic      │
│    order--fulfilled_by-->supplier--located_in-->address     │
└─────────────────────────────────────────────────────────────┘
```

### 2.2 Loop de agente (Hermes-inspired)

```
INPUT (mensagem WhatsApp)
   │
   ▼
[1. OBSERVE] — multimodal parsing, transcribe audio, OCR image
   │
   ▼
[2. REMEMBER] — recall + semantic kNN + episodic query (paralelo)
   │
   ▼
[3. THINK] — LLM com context (system + memories + tools)
   │
   ▼
[4. TOOL] — function calling (validated args, idempotent)
   │
   ▼
[5. VERIFY] — checks (red flag, low confidence, dose check)
   │
   ▼
[6. RESPOND] — text + opcional TTS audio
   │
   ▼
[7. LEARN] (async) — enricher + skill_detector + adherence_scorer
```

### 2.3 Princípios de implementação

- **Event-driven**: cada turno emite eventos (`message.received`, `order.confirmed`, `medication.taken`) que workers escutam
- **Workers idempotentes**: retry-safe, dedupe via event_id
- **Single source of truth no DB**: nada de estado em memória que sobrevive crash
- **Tools são contratos**: schema Zod, validation rígida, side-effects em transação
- **Prompts versionados**: cada deploy guarda hash do system prompt em `assistant_tasks.prompt_version`

---

## 3. Schema do banco — evolução

### 3.1 Tabelas a EXPANDIR (alter table)

#### `users`
```sql
ALTER TABLE users ADD COLUMN:
  communication_prefs JSONB  -- { audio_replies: true, reminder_max_per_day: 3, quiet_hours: [22,7] }
  professional_profile JSONB  -- { occupation, workplace_address_id }
  primary_doctor_id UUID REFERENCES prescribers(id)  -- médico de confiança
  health_summary TEXT  -- síntese gerada pelo enricher, ~200 chars
  last_active_at TIMESTAMPTZ
  adherence_score_30d DECIMAL(3,2)  -- 0.00-1.00, calculado pelo worker
```

#### `user_addresses`
```sql
ALTER TABLE user_addresses ADD COLUMN:
  usage_count INTEGER DEFAULT 0       -- incrementa toda vez que é usado em pedido
  last_used_at TIMESTAMPTZ
  is_default BOOLEAN DEFAULT false
  notes TEXT                          -- "deixar com porteiro", "tocar campainha 2x"
-- Constraint: at most 1 is_default=true per user_id
```

#### `user_medications`
```sql
ALTER TABLE user_medications ADD COLUMN:
  treatment_id UUID REFERENCES treatments(id)
  tablets_per_box INTEGER             -- ex: Losartana 50mg = 30 cp
  daily_consumption DECIMAL(4,2)      -- ex: 1.0 / dia, 0.5 / dia (meio comprimido)
  start_date DATE
  expected_end_date DATE              -- pra tratamentos finitos (antibiótico)
  prescriber_id UUID REFERENCES prescribers(id)
  last_taken_at TIMESTAMPTZ           -- atualizado por medication_log
  needs_prescription BOOLEAN          -- tarja vermelha/preta?
```

### 3.2 Tabelas NOVAS

#### `treatments` — agrupador de medicações de um regime clínico
```sql
CREATE TABLE treatments (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,                 -- "Tratamento de hipertensão"
  condition_id UUID REFERENCES user_health_conditions(id),
  status TEXT NOT NULL CHECK (status IN ('active','paused','completed','interrupted')),
  started_at DATE NOT NULL,
  ended_at DATE,
  interruption_reason TEXT,
  prescriber_id UUID REFERENCES prescribers(id),
  prescription_id UUID REFERENCES prescriptions(id),
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
```

#### `medication_inventory` — caixas que o user tem em casa
```sql
CREATE TABLE medication_inventory (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  medication_id UUID NOT NULL REFERENCES user_medications(id) ON DELETE CASCADE,
  treatment_id UUID REFERENCES treatments(id),
  source_order_id UUID REFERENCES orders(id),  -- de qual pedido veio
  box_count INTEGER NOT NULL,         -- quantas caixas compradas nesse evento
  tablets_per_box INTEGER NOT NULL,
  tablets_remaining INTEGER NOT NULL, -- decrementado pelo inventory-tracker
  purchased_at TIMESTAMPTZ NOT NULL,
  expected_depletion_at DATE,         -- calculado: remaining / daily_consumption
  reorder_offered_at TIMESTAMPTZ,     -- pra não reoferecer
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX ON medication_inventory(user_id, expected_depletion_at) WHERE tablets_remaining > 0;
```

#### `medication_log` — adesão
```sql
CREATE TABLE medication_log (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  medication_id UUID NOT NULL REFERENCES user_medications(id),
  treatment_id UUID REFERENCES treatments(id),
  reminder_id UUID REFERENCES reminders(id),
  status TEXT NOT NULL CHECK (status IN ('taken','skipped','snoozed','no_response')),
  scheduled_at TIMESTAMPTZ NOT NULL,  -- horário planejado
  responded_at TIMESTAMPTZ,           -- quando user respondeu
  response_text TEXT,                 -- texto bruto da resposta
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX ON medication_log(user_id, scheduled_at DESC);
```

#### `prescribers` — médicos
```sql
CREATE TABLE prescribers (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,  -- prescriber pode ser global (NULL) ou user-specific
  name TEXT NOT NULL,
  crm TEXT,                            -- CRM/SP-123456
  crm_state CHAR(2),
  specialty TEXT,                      -- cardiologia, endocrinologia, etc
  clinic_id UUID REFERENCES clinics(id),
  phone_e164 TEXT,
  whatsapp_verified_at TIMESTAMPTZ,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
```

#### `clinics` — diretório de clínicas/médicos (espelho do `suppliers` mas pra consultas)
```sql
CREATE TABLE clinics (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('clinic','hospital','lab','solo_doctor','telemedicine')),
  specialties TEXT[],                  -- ['cardiologia', 'clínica geral']
  google_place_id TEXT UNIQUE,
  address TEXT,
  city TEXT,
  state CHAR(2),
  neighborhood TEXT,
  lat DECIMAL(10,7),
  lng DECIMAL(10,7),
  phone_e164 TEXT,
  whatsapp_e164 TEXT,
  whatsapp_verified_at TIMESTAMPTZ,
  accepts_plans TEXT[],                -- ['Unimed', 'Bradesco Saúde']
  rating DECIMAL(2,1),
  blacklist_reason TEXT,
  last_contacted_at TIMESTAMPTZ,
  last_response_rate DECIMAL(3,2),    -- responde em % das tentativas
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX ON clinics(city, specialties);
```

#### `consultations` — espelho de `orders` pra consultas médicas
```sql
CREATE TABLE consultations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id UUID REFERENCES conversations(id),
  status TEXT NOT NULL CHECK (status IN (
    'drafting','searching','quoting','quoted','confirming','scheduled','completed','cancelled','failed'
  )),
  specialty TEXT NOT NULL,             -- "cardiologia"
  urgency TEXT NOT NULL CHECK (urgency IN ('rotina','72h','24h','urgente')),
  modality TEXT CHECK (modality IN ('presencial','telemedicina','indiferente')),
  city TEXT,
  preferences JSONB,                   -- { plano: "Unimed", genero_medico: "feminino", horario_pref: "manhã" }
  selected_quote_id UUID,              -- preenchido após user escolher
  scheduled_at TIMESTAMPTZ,            -- data/hora da consulta
  scheduled_clinic_id UUID REFERENCES clinics(id),
  scheduled_prescriber_id UUID REFERENCES prescribers(id),
  user_rating INTEGER CHECK (user_rating BETWEEN 1 AND 5),  -- pós-consulta
  user_feedback TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
```

#### `consultation_quotes` — ofertas de clínicas
```sql
CREATE TABLE consultation_quotes (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  consultation_id UUID NOT NULL REFERENCES consultations(id) ON DELETE CASCADE,
  clinic_id UUID NOT NULL REFERENCES clinics(id),
  prescriber_id UUID REFERENCES prescribers(id),
  conversation_id UUID REFERENCES conversations(id),
  status TEXT NOT NULL CHECK (status IN ('pending','offered','unavailable','timeout','withdrawn')),
  proposed_datetime TIMESTAMPTZ,
  alternative_datetimes TIMESTAMPTZ[],
  price_brl DECIMAL(10,2),
  plan_accepted TEXT,                  -- nome do convênio aceito
  payment_methods TEXT[],
  modality TEXT,
  responded_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);
```

#### `symptoms_log` — queixas do user
```sql
CREATE TABLE symptoms_log (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id UUID REFERENCES conversations(id),
  message_id UUID REFERENCES messages(id),
  name TEXT NOT NULL,                  -- "dor de cabeça", "febre", "tontura"
  intensity SMALLINT CHECK (intensity BETWEEN 1 AND 10),
  duration_hours DECIMAL(6,2),
  context TEXT,                        -- "depois do almoço", "ao acordar"
  related_condition_id UUID REFERENCES user_health_conditions(id),
  red_flag_triggered BOOLEAN DEFAULT false,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX ON symptoms_log(user_id, created_at DESC);
```

#### `entity_relations` — knowledge graph
```sql
CREATE TABLE entity_relations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subject_type TEXT NOT NULL,          -- 'user' | 'medication' | 'condition' | 'prescriber' | 'order' | 'supplier' | 'symptom' | 'clinic'
  subject_id UUID NOT NULL,
  relation TEXT NOT NULL,              -- 'takes', 'treats', 'prescribed_by', 'fulfilled_by', 'reported', 'with', 'at'
  object_type TEXT NOT NULL,
  object_id UUID NOT NULL,
  active BOOLEAN DEFAULT true,
  confidence DECIMAL(3,2) DEFAULT 1.0,
  since DATE,
  until DATE,
  evidence_message_id UUID REFERENCES messages(id),
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX ON entity_relations(user_id, subject_type, subject_id);
CREATE INDEX ON entity_relations(user_id, object_type, object_id);
CREATE INDEX ON entity_relations(user_id, relation) WHERE active = true;
```

#### `agent_skills` — procedural memory (Hermes "growing agent")
```sql
CREATE TABLE agent_skills (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,  -- skill pode ser global (NULL) ou per-user
  trigger_pattern TEXT NOT NULL,       -- "user pede medicamento M1"
  action_pattern TEXT NOT NULL,        -- "também oferece M2 (que sempre pede junto)"
  occurrences INTEGER DEFAULT 0,       -- quantas vezes o padrão se confirmou
  last_observed_at TIMESTAMPTZ,
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);
```

#### `feedback_events` — feedback do user
```sql
CREATE TABLE feedback_events (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL,           -- 'order' | 'consultation' | 'reminder' | 'supplier' | 'clinic' | 'prescriber'
  target_id UUID NOT NULL,
  sentiment SMALLINT NOT NULL CHECK (sentiment IN (-1, 0, 1)),  -- 👎 / neutro / 👍
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);
```

#### `audit_log` — auditoria de mudanças sensíveis
```sql
CREATE TABLE audit_log (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID,
  actor TEXT NOT NULL,                 -- 'sara', 'enricher', 'admin:hiago', 'system'
  action TEXT NOT NULL,                -- 'medication.add', 'condition.modify', 'forget_me.execute'
  target_table TEXT,
  target_id UUID,
  before JSONB,
  after JSONB,
  trace_id UUID,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX ON audit_log(user_id, created_at DESC);
```

### 3.3 Functions SQL novas

```sql
-- knowledge graph query: tudo que um user "faz" com X
CREATE FUNCTION get_user_relations(p_user_id UUID, p_relation TEXT)
RETURNS TABLE(...);

-- adherence score nos últimos N dias
CREATE FUNCTION calc_adherence_score(p_user_id UUID, p_days INTEGER)
RETURNS DECIMAL;

-- match clínicas por especialidade + cidade (com cache de rating)
CREATE FUNCTION find_clinics(p_specialty TEXT, p_city TEXT, p_limit INTEGER)
RETURNS TABLE(...);
```

### 3.4 Materialized view: `user_360_view`

Agrega tudo que Sara precisa no system prompt (refresh a cada hora).

---

## 4. Novo fluxo: CONSULTA MÉDICA

Espelho do fluxo de farmácia, mas com timers maiores e perguntas diferentes.

### 4.1 Etapas

```
User: "preciso marcar com cardiologista"
   ▼
Sara confirma:
   - cidade (default: city do user_addresses default)
   - urgência (rotina/72h/24h/urgente)
   - modalidade (presencial/telemedicina)
   - preferências (convênio? gênero? horário?)
   ▼
Tool: start_consultation_search(specialty, city, urgency, preferences)
   ▼
clinic-discoverer worker:
   1. SELECT FROM clinics WHERE specialty IN preferences AND city = X
   2. Se < 5 resultados: Google Places API (q="cardiologista em Goiânia")
   3. Populate clinics + cache
   ▼
Spawn N conversas paralelas (uazapi AGENT_INSTANCE):
   "Oi, somos da IA da Saúde. Tenho um paciente buscando consulta de cardiologia
    com urgência ${urgency}. Vocês têm horário ${data_alvo}? Aceitam ${plano}?
    Qual o valor particular se for o caso?"
   ▼
Agent LLM negocia com cada clínica (tools agent-pharmacy adaptadas → agent-clinic):
   - record_clinic_quote(price, datetime, plan_accepted, doctor_name)
   - record_clinic_unavailable(reason)
   - request_clarification
   ▼
quote-consolidation com TIMER MAIOR (10min vs 5min farmácia):
   - clínicas demoram mais pra responder
   - early consolidate se >=3 quotes
   ▼
Send menu pro user:
   "Achei 3 opções:
    1) Dr. Paulo Mendes, terça 14h, R$ 280
    2) Clínica CardioGo, qua 9h30, R$ 220 (Unimed)
    3) Telemedicina hoje 19h, R$ 150
    Qual prefere?"
   ▼
User escolhe → confirm_consultation_selection(consultation_id, quote_id)
   ▼
Agent confirma com clínica selecionada:
   "Confirmado! Paciente João Silva, 38a, telefone +5562..."
   ▼
status = scheduled
   ▼
Cria reminders automáticos:
   - 1 dia antes
   - 2 horas antes (com endereço/link telemedicina)
   ▼
Pós-consulta (24h depois):
   "Como foi a consulta com Dr. Paulo? 1-5 estrelas?"
   - Salva user_rating em consultations
   - Sentiment positivo: clinic.rating += micro-incremento
```

### 4.2 Diferenças vs farmácia

| Aspecto | Farmácia | Consulta |
|---|---|---|
| Timeout pra quotes | 3min/5min | 8min/12min (clínicas respondem mais devagar) |
| Critério geográfico | mais próximo | qualquer da cidade (médico bom > médico perto) |
| Decisão | preço dominante | qualidade + plano + horário |
| Pagamento | imediato | só na consulta |
| Reminders pós | acabar caixa | véspera + 2h antes |
| Pós-evento | nada | feedback obrigatório (1-5⭐) |

---

## 5. Sistema de tratamentos + inventário + lembretes inteligentes

### 5.1 Modelo conceitual

```
Tratamento (treatments)
  ├─ Medicação A (user_medications + treatment_id)
  │   ├─ Estoque atual (medication_inventory)
  │   ├─ Cronograma (reminder_schedules)
  │   └─ Histórico de adesão (medication_log)
  └─ Medicação B (mesma estrutura)
```

### 5.2 Fluxo: "começar tratamento"

Disparado **automaticamente** após order confirmed (não exige tool extra):

1. Após `confirm_order_selection`, post-process hook detecta itens medicamentosos
2. Sara, no MESMO turno de confirmação, pergunta:
   *"Beleza! Vou registrar como tratamento contínuo? Esse Losartana é pra tomar 1x por dia, todo dia, no mesmo horário?"*
3. Se sim, tool `start_treatment_from_order(order_id)` é chamada
4. Cria:
   - 1 row em `treatments` (name="Tratamento de hipertensão", status=active)
   - 1+ rows em `user_medications` (atualizando o existente se já tinha)
   - 1 row em `medication_inventory` (box_count = ordered, tablets_remaining = box × cp/box)
   - 1+ rows em `reminders` com RRULE (FREQ=DAILY;BYHOUR=8)
5. Confirma: *"Pronto, vou te lembrar todo dia às 8h. Quer que eu ajuste pra outro horário?"*

### 5.3 Fluxo: "tomei o remédio"

Reminder dispara via `reminder-dispatcher`:
> 🔔 Hora da **Losartana 50mg** (1 comprimido). Já tomou?

User responde uma de:
| Resposta | Interpretação | Ação |
|---|---|---|
| "tomei" / "ok" / "👍" / "sim" | taken | medication_log + decrementa inventory |
| "esqueci" / "vou tomar agora" | will_take | snooze 30min, depois pergunta de novo |
| "não vou tomar hoje" / "pulei" | skipped | medication_log, sem decrementar |
| Sem resposta em 2h | no_response | escalation: segundo lembrete + flag pra Sara investigar no próx turno |

### 5.4 Fluxo: "estoque acabando"

Worker `inventory-tracker` (cron 4x/dia: 8h, 12h, 18h, 22h BRT):

```sql
SELECT mi.*, um.medication_name, um.daily_consumption
FROM medication_inventory mi
JOIN user_medications um ON um.id = mi.medication_id
WHERE mi.tablets_remaining > 0
  AND mi.reorder_offered_at IS NULL
  AND mi.tablets_remaining / um.daily_consumption <= 7  -- ≤7 dias
  AND um.active = true
```

Para cada match:
1. Cria `assistant_tasks` (action=medication_running_low, payload={medication_id, days_left})
2. Sara dispara mensagem proativa:
   > Oi! Vi que sua **Losartana 50mg** está acabando — restam ~5 dias. Quer que eu já cote pra repor 1 caixa de 30 comprimidos?
3. Se user aceita → reutiliza `start_pharmacy_order` (já existe)
4. Marca `reorder_offered_at = now` pra não reoferecer

### 5.5 Adherence score

Worker `adherence-scorer` (cron 1x/dia 23h BRT):

```
score = taken / (taken + skipped + no_response)  # janela de 30 dias
```

Salva em `users.adherence_score_30d`. Se score cai >20% num dia → flag pra Sara perguntar no próximo turno: *"Tá tudo bem com o tratamento? Algum efeito colateral?"*

---

## 6. Workers novos

| Worker | Trigger | Frequência | Função |
|---|---|---|---|
| `profile-enricher` (existe, EXPANDIR) | event post-turn | event | Adicionar: extrai treatments, symptoms, prescribers do texto |
| `reminder-dispatcher` (existe, EXPANDIR) | cron | 30s | Adicionar: escalation (2h sem resposta → relembrar) e captura de adesão |
| `conversation-compactor` (existe) | cron | 1h | — |
| **`inventory-tracker`** ✨ | cron | 4x/dia | Decrementa estoque, detecta running-low, cria task |
| **`adherence-scorer`** ✨ | cron | 1x/dia 23h | Calcula score 30d, detecta drops, flag pra Sara |
| **`clinic-discoverer`** ✨ | event ou on-demand | per consultation | Popula clinics via Places + cache 30d |
| **`pharmacy-recommender`** ✨ | event pre-quote | per order | Reordena suppliers pelo histórico do user |
| **`skill-extractor`** ✨ | cron | 1x/dia 4h | Detecta padrões repetidos N>=3, cria agent_skills |
| **`knowledge-graph-builder`** ✨ | event post-enricher | event | Popula entity_relations a partir das memory_cards |
| **`anomaly-detector`** ✨ | event on-message | event | Red flags: suicídio, overdose, automutilação → alerta admin |
| **`metrics-aggregator`** ✨ | cron | 1h | Agrega métricas pra dashboards (não roda em cada request) |

---

## 7. Tools novas pra Xarlote

### 7.1 Tratamentos & medicação
- `start_treatment_from_order(order_id, schedule_pref?, duration_days?)` — orquestra criação completa pós-pedido
- `update_treatment_status(treatment_id, status, reason?)` — "parei porque doutor mandou"
- `log_medication_taken(medication_id, taken_at?, notes?)` — registro manual
- `log_symptom(name, intensity, duration_hours?, context?)` — "dor de cabeça há 3h, intensidade 7"
- `query_my_treatments(active_only?)` — "quais remédios estou tomando?"
- `query_my_medication_log(medication_id?, days?)` — "tomei Losartana semana passada?"

### 7.2 Consultas
- `start_consultation_search(specialty, city?, urgency, modality?, preferences?)`
- `confirm_consultation_selection(consultation_id, quote_id)`
- `cancel_consultation(consultation_id, reason?)`
- `reschedule_consultation(consultation_id, new_datetime_pref)`
- `query_my_consultations(status?, months?)`
- `rate_consultation(consultation_id, rating_1_5, notes?)` — pós-consulta

### 7.3 Endereços
- `query_my_addresses(label?)` — "casa" / "trabalho" / "todos"
- `set_default_address(address_id)` — Sara pode sugerir default quando vê padrão
- `update_address_notes(address_id, notes)` — "deixar com porteiro"

### 7.4 Histórico
- `query_my_pharmacy_history(months?, sort_by?)` — "qual farmácia melhor entregou?"
- `query_my_orders(status?, months?)` — histórico de pedidos
- `query_my_symptoms(days?)` — "tive dor de cabeça quantas vezes esse mês?"

### 7.5 Educação em saúde
- `health_education(topic, user_context_summary)` — orientação não-prescritiva (sintomas comuns, quando procurar médico, primeiros cuidados, etc)
- `interaction_check(medication_names)` — checa interações conhecidas (base curada: paracetamol+álcool, AINEs+anticoagulantes, etc)
- `red_flag_check(symptoms_description)` — detecta sinais de emergência (dor no peito + suor + falta de ar = SAMU)

### 7.6 Sociais / family
- `add_dependent(name, relation, birth_year, conditions?)` — pessoa que o user cuida
- `query_dependents()` — "como tá o filho/pai/mãe que você cuida"

---

## 8. Knowledge graph — uso prático

### 8.1 Tipos de relação

```
user --takes-->         medication  (since, until, active)
medication --treats-->  condition   (confidence)
medication --prescribed_by--> prescriber
medication --bought_at--> supplier  (last, count)
user --has--> condition (severity, since)
user --reported--> symptom (timestamp, intensity)
symptom --possibly_related_to--> condition
consultation --with--> prescriber
consultation --at--> clinic
prescriber --works_at--> clinic
order --contained--> medication  (qty, dose)
order --fulfilled_by--> supplier
```

### 8.2 Queries naturais que Sara faz internamente

| Pergunta do user | Query SQL gerada |
|---|---|
| "Quais remédios eu tomo?" | `SELECT * FROM entity_relations WHERE user_id=X AND relation='takes' AND active=true` |
| "Quando comprei Losartana?" | `SELECT * FROM orders JOIN entity_relations WHERE relation='contained' AND object='losartana'` |
| "Qual médico me prescreveu isso?" | `SELECT * FROM entity_relations WHERE relation='prescribed_by'...` |
| "Tive dor de cabeça quantas vezes?" | `SELECT count(*) FROM symptoms_log WHERE user_id=X AND name='dor de cabeça'` |

### 8.3 Uso pra antecipação

Sara antes de cada turno faz `query_user_360(user_id)` que retorna:
```json
{
  "active_treatments": [...],
  "active_conditions": [...],
  "active_meds_with_inventory": [...],
  "recent_symptoms_30d": [...],
  "upcoming_consultations": [...],
  "addresses": [{label: "casa", is_default: true, ...}, ...],
  "favorite_pharmacies": [...],  // top 3 por uso
  "adherence_score": 0.85
}
```

Isso vai pro **system prompt** dinâmico em vez de viver no `memory_cards`. Mais barato (não precisa kNN), mais preciso.

---

## 9. Aprendizado contínuo (Hermes "growing agent")

### 9.1 Skill detection

Worker `skill-extractor` roda 1x/dia analisando `orders` + `consultations` + `medication_log` por user:

**Heurísticas:**
- Padrão de co-ocorrência: medicamentos sempre pedidos juntos (>=3x) → skill `co_order(M1, M2)`
- Padrão de farmácia preferida: mesma farmácia escolhida >=4x em 6 últimos pedidos → skill `prefers_supplier(S)`
- Padrão temporal: medicação tomada sempre no mesmo horário ±30min → skill `med_routine(M, time)`
- Padrão de endereço: pedidos no horário comercial sempre pro trabalho → skill `weekday_default(work_address)`

**Output:** rows em `agent_skills`. No próximo turno, Sara recebe no contexto:
```
SKILLS APRENDIDAS:
- Você sempre pede Losartana + Hidroclorotiazida juntas → ao receber pedido de uma, ofereça a outra
- Sua farmácia preferida é Drogasil (4/5 últimos pedidos)
- Pedidos em dias úteis até 17h vão pro endereço "Trabalho"
```

### 9.2 Feedback loop explícito

User pode dar feedback de 3 formas:
1. **Implícito**: escolhe quote (sinaliza preferência por aquela farmácia)
2. **Reativo**: Sara pergunta "Como foi a entrega?" → grava em `feedback_events`
3. **Espontâneo**: user diz "essa farmácia foi péssima" → enricher detecta + cria feedback

Feedback vira:
- Ajuste no `supplier.rating` (média ponderada)
- Possível `blacklist_reason` se sentiment muito negativo
- Skill update (parar de oferecer farmácia X pra esse user)

---

## 10. Frontend dashboard — páginas novas

| Rota | Mostra |
|---|---|
| `/treatments` | Lista de todos tratamentos ativos do sistema, com adherence score |
| `/treatments/[id]` | Detalhe: medicações, inventário, log de adesão (gráfico), próximos refills |
| `/consultations` | Lista de consultas (rotina/24h/72h), status, especialidades |
| `/consultations/[id]` | Detalhe: cotações recebidas, clínica escolhida, reminders |
| `/clinics` | Diretório de clínicas (CRUD admin, filtro por specialty/city/blacklist) |
| `/clinics/[id]` | Detalhe + histórico de consultas com essa clínica |
| `/prescribers` | Médicos (CRUD admin) |
| `/users/[id]` (NOVA ABA) | "Saúde 360": treatments, conditions timeline, symptoms log, adherence chart, knowledge graph mini-viz |
| `/skills` | Skills aprendidas pela Sara (per user e globais), com on/off toggle |
| `/metrics` | KPIs operacionais (TTFR, conversion, adherence avg, cost/user/day) |
| `/anomalies` | Alertas de red flag detectados pelo anomaly-detector |

---

## 11. Observabilidade — métricas críticas

### 11.1 KPIs de produto
- **TTFR (Time to First Response)** P50/P95 — quanto tempo Sara demora pra responder
- **Pharmacy conversion rate** — quotes → orders confirmados
- **Consultation conversion rate** — searches → scheduled
- **Adherence avg 30d** — média da base
- **D1/D7/D30 retention** — usuários voltam?
- **Reminder open rate** — quantos lembretes geram resposta
- **Avg messages/user/day** — engajamento

### 11.2 KPIs operacionais
- **LLM cost per user / per turn** — orçamento
- **TTS/STT success rate** — qualidade
- **Tools error rate** — por tool
- **uazapi connection uptime** — instâncias conectadas?
- **Worker queue depth** — workers acompanhando?
- **DB query P95** — performance

### 11.3 KPIs de segurança
- **Red flag events / dia**
- **Forget-me requests / mês**
- **PII leaks em logs** (auditoria automatizada)

### 11.4 Stack
- **Coleta**: Pino structured logs (já existe) + tabela `metrics_events` (nova)
- **Agregação**: worker `metrics-aggregator` (1h cron)
- **Dashboard interno**: `/metrics` page (Grafana-style via Recharts) OR Metabase em cima do Supabase
- **Alertas**: webhook Telegram/Slack quando crítico (uazapi caiu, LLM custo >$N/dia, anomalia)

---

## 12. Segurança e LGPD reforçado

### 12.1 Camadas de proteção

| Camada | Mecanismo |
|---|---|
| Transport | HTTPS only, TLS 1.2+ |
| Auth (dashboard) | Supabase Auth + RLS por staff_users |
| Auth (API admin) | Bearer token interno + IP allowlist Railway |
| Field-level encryption | Dados ultra-sensíveis (HIV, oncológico, transtornos) em `pgcrypto` |
| Audit | Tabela `audit_log` (toda escrita sensível) |
| PII redaction | `pino-redact` no logs (já existe), expandir |
| Rate limiting | Redis: max 30 msg/min por user |
| Anomaly detection | Worker dedicado pra red flags |
| LGPD direito de acesso | `/admin/users/:id/export` (JSON dump completo) |
| LGPD direito de exclusão | forget-me + cascata pgvector (já existe) |

### 12.2 Red flags monitorados

Worker `anomaly-detector` triggera alerta admin (telegram) quando detecta:
- Palavras-chave: "suicídio", "me matar", "overdose", "automutilação", "cortei", "30 comprimidos"
- Padrão: pedido de medicamento controlado em quantidade excessiva
- Padrão: usuário some por 7+ dias após mensagem com sentimento negativo

Sara também tem `red_flag_check` tool que dispara orientação SAMU 192 + sugere CVV 188.

---

## 13. Performance e escala (centenas de users)

### 13.1 Bottlenecks atuais
- ✅ Workers já estão em mesmo processo (apps/api) — adequado até ~200 users
- 🚧 Embeddings 1536d em todo turno — caro em latência (~200ms) e custo
- 🚧 Sem cache de prompts/respostas
- 🚧 Google Places hit a cada busca

### 13.2 Estratégia

| Escala | Estratégia |
|---|---|
| **Até 200 users** (hoje) | Vertical: Railway service único, single Node process |
| **200-1000 users** | Separar `apps/worker` em service dedicado; Supavisor (PgBouncer); read replica pra dashboard |
| **1000-10k users** | Sharding por phone prefix; queue Redis cluster; LLM provider routing (Haiku pra simples, 4.1 pra complex) |
| **10k+** | Multi-region, edge caching, dedicated LLM tier |

### 13.3 Caches obrigatórios já no v2.0

- **Embedding cache**: LRU 1000 entries por hash(message) → reusa em retries
- **Google Places cache**: `clinics` table com `updated_at` < 30d
- **Pharmacy directory cache**: `suppliers` com `updated_at` < 30d
- **Common audio greetings cache**: gerar 1x, reusar (TTS é caro)
- **Prompt cache (Anthropic-style)**: system prompt dinâmico vai pro semantic dedupe
- **Materialized view `user_360_view`**: refresh 1h, leitura instantânea

---

## 14. Roadmap em sprints

| Sprint | Duração | Tema | Entregas verificáveis |
|---|---|---|---|
| **S1: Foundation** | 1 sem | Schema + memory architecture | Migrations rodando; entity_relations sendo populado; query_user_360 funcional |
| **S2: Tratamentos** | 1 sem | treatment + inventory + adherence | `start_treatment_from_order` funcional; inventory-tracker detectando running-low; adherence-scorer rodando |
| **S3: Consultas** | 1.5 sem | Fluxo médico completo | start_consultation_search + clinic-discoverer + agent-clinic; primeira consulta marcada via WhatsApp |
| **S4: Knowledge & Skills** | 1 sem | Graph + procedural memory | knowledge-graph-builder; skill-extractor; Sara antecipando combos |
| **S5: Frontend** | 1 sem | Dashboard novo | /treatments, /consultations, /clinics, aba Saúde 360 |
| **S6: Observability** | 0.5 sem | Métricas + alertas | /metrics page; anomaly-detector + telegram alert |
| **S7: Hardening** | 1 sem | Load test + bugs | 50 users concorrentes simulados; cache hit ratio > 70%; LLM cost/user mapeado |
| **S8: Beta privado** | 2 sem | 20 users reais | Feedback estruturado, refinamento de prompts, tuning de timers |
| **S9: GA controlado** | — | 100 users primeira onda | Lançamento monitorado |

Total: **~9 semanas** até primeiros 100 usuários reais. Cada sprint termina com **smoke test ponta-a-ponta** + **load test** se aplicável.

---

## 15. Riscos e mitigações

| Risco | Probabilidade | Severidade | Mitigação |
|---|---|---|---|
| LLM aceita info errada como fato | Alta | Média | Confidence threshold (já), confirmação verbal pra dados clínicos críticos, audit log |
| Spam de lembretes irrita user | Média | Alta | Max N reminders/dia (config user), snooze inteligente, opt-out fácil |
| WhatsApp ban uazapi | Média | Alta | Rotação de instâncias, warm-up, evitar broadcast, respeitar rate limit nativo |
| Custos LLM escalam | Alta | Média | Cache, smart routing por complexidade, prompt slimming, budget alert por user |
| User reporta emergência real | Baixa | Crítica | red_flag_check tool + orientação SAMU 192 + alerta admin + Sara nunca substitui médico |
| Dados clínicos vazam | Baixa | Crítica | Field-level encryption, RLS rigoroso, audit log, PII redaction, LGPD compliance |
| Hospital/clínica não responde | Alta | Média | Timeout maior (10min), fallback "ligar manualmente", lista alternativa, blacklist auto após N timeouts |
| OpenRouter/Eleven instáveis | Média | Alta | Multi-provider fallback (Gemini, OpenAI direta), feature flags pra desativar TTS/STT |
| User dá info conflitante | Média | Média | Confidence + last_seen_at + Sara pergunta novamente quando incerto |
| Skill aprendida vira anti-padrão | Baixa | Baixa | Skills têm `active` flag, dashboard /skills permite desativar, decay automático |

---

## 16. Comparativo com mercado

| Capability | Letta | Mem0 | Zep | Hermes Agent | **Xarlote 2.0** |
|---|---|---|---|---|---|
| Semantic memory persistente | ✓ | ✓ | ✓ | ✓ | ✓ (pgvector) |
| Episodic memory | ✓ | parcial | ✓ | ✓ | ✓ (orders/consultations/symptoms) |
| Temporal knowledge graph | parcial | parcial | ✓ | parcial | ✓ (entity_relations) |
| Procedural skills (growing) | parcial | ✗ | ✗ | ✓ | ✓ (agent_skills) |
| Multi-platform | ✗ | ✗ | ✗ | ✓ | WhatsApp now, web/iOS depois |
| Domain expertise | generic | generic | generic | generic | **DEEP saúde BR** |
| Compliance LGPD | generic | generic | generic | generic | **nativo** |
| Real-world action | parcial | ✗ | ✗ | ✗ | ✓ (cotação real via WhatsApp B2B) |
| Multi-tenant ready | ✓ | ✓ | ✓ | parcial | ✓ (por user, RLS) |

**Diferencial Xarlote 2.0:** agente de **nicho profundo** (saúde BR) com **compliance LGPD nativo** e capaz de **AGIR no mundo real** (cotações, agendamentos, lembretes), não só conversar. Os frameworks acima dão memória — Xarlote tem memória + ação + domínio.

---

## 17. Decisões abertas pra confirmar

Pontos que precisam decisão sua antes de começar S1:

1. **Encryption pra dados ultra-sensíveis**: ativar pgcrypto field-level desde S1, ou só em S6 (hardening)?
2. **Telemedicina**: incluir já no S3 ou esperar S9+? Tem integração com Conexa, Doctoralia, Memed?
3. **Family / dependentes**: same user account com perfis filhos, ou contas separadas com link? (impacta privacidade)
4. **Pagamento dentro da Xarlote**: hoje paga direto na farmácia. Vai integrar Pix splitting / cartão? (escopo grande, recomendo S10+)
5. **App nativo (iOS/Android)**: WhatsApp basta pra ~1000 users; app vira necessidade quando? Critério.
6. **Plano de saúde como entidade**: criar tabela `health_plans` e relacionar user→plan? Ou string solta?
7. **Receita digital**: integrar com Memed / receitor digital? Grande tema regulatório.
8. **Notificações de SAÚDE PÚBLICA**: campanha vacina, alerta surto. Opt-in? Não-spam?

---

## 18. Próximos passos imediatos

1. **Você revisa este plano** e marca ✓/✗/edit em cada seção
2. Definimos sprint atual (provável S1) com escopo travado
3. Crio migrations das tabelas novas (S1.1)
4. Implemento `query_user_360` + atualizo system prompt da Sara pra usar (S1.2)
5. Smoke test ponta-a-ponta no simulador
6. Deploy + monitoramento

---

## Apêndice A: Patterns inspirados em Hermes Agent v0.3 (mar/2026)

Do release notes / docs:
- **3-tier architecture**: User interfaces (WhatsApp, web), Core agent logic (LLM + tools), Execution backends (workers + DB)
- **Growing agent**: skills geradas automaticamente após task completion
- **Cross-session memory**: estado persiste entre conversas
- **Sub-agents pra paralelo**: spawn de sub-agentes pra tarefas independentes (ex: contactar 5 farmácias em paralelo já fazemos via processInboundSupplier — esse é exatamente o pattern)
- **Agent Client Protocol (ACP)**: padronização da comunicação user↔agent (não vamos adotar literal, mas o conceito de "single ingestion point" já temos via uazapi webhook)
- **OpenAI-compatible LLM provider**: agnóstico de provedor (OpenRouter já é isso)

---

## Apêndice B: Patterns inspirados em Letta/Zep/Mem0

- **Letta two-tier memory (main context + external recall + external archival)**: nossa arquitetura de 5 camadas mapeia 1:1 — working = main, recall = msgs recentes, archival = memory_cards_index
- **Zep temporal knowledge graph (Graphiti)**: nosso `entity_relations` com `since`/`until` é a versão simplificada
- **Mem0 community-driven**: pattern de "fact extraction async pós-turno" — já fazemos via profile-enricher, expandir
- **LangMem 3 memory types (episodic, semantic, procedural)**: exatamente nosso modelo

---

> **Esse doc é vivo**. Cada sprint, atualizamos.
> Última edição: aprovação pendente. Próxima edição: pós-S1.
