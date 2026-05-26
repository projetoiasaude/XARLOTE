# Xarlote 2.0 — Guia de Deploy

> Status: **Fases 0-8 implementadas e commitadas. Build limpo, typecheck OK.**
> Migrations 0002-0006 pendentes de aplicação manual no Supabase.

---

## ✅ O que ficou pronto (fases 0-8 completas)

### Fase 0.A — Rename Sara → Xarlote
- Arquivos movidos: `sara.system.ts → xarlote.system.ts`, `sara-tools.ts → xarlote-tools.ts`
- Símbolos: `saraTools → xarloteTools`, `buildSaraSystemPrompt → buildXarloteSystemPrompt`
- Comentários atualizados; mantidos por compat: `SARA_INSTANCE` (constante uazapi) + `UAZAPI_SARA_TOKEN` (env)

### Fase 0.B — Auditoria
- Tabelas `audit_log` + `event_log`, RPCs `write_audit()`, `write_event()` (SECURITY DEFINER)
- Helpers TS: `writeAudit/writeEvent/auditToolCall/auditUserStateChange/auditMemoryWrite/auditOrderTransition`
- 7 pontos críticos integrados (consent, forget-me, onboarding, LLM completion, tool calls, memory cards, prompts admin, TTS)
- Endpoints: `GET /admin/audit`, `/admin/audit/summary`, `/admin/events`

### Fase 1 — Schema novo (migrations 0003-0004)
- 11 tabelas novas: `treatments`, `medication_inventory`, `medication_log`, `prescribers`, `clinics`, `consultations`, `consultation_quotes`, `symptoms_log`, `entity_relations`, `agent_skills`, `feedback_events`
- 6 functions SQL: `calc_adherence_score`, `medications_running_low`, `find_clinics`, `pharmacy_history`, `add_or_refresh_relation`, `query_user_360`

### Fase 2 — User 360 no prompt
- `packages/db/src/user360.ts`: `queryUser360()` + `formatUser360ForPrompt()`
- `inbound-user.ts` integra com fallback gracioso pras queries antigas
- Prompt da Xarlote ganha tratamentos+inventário+sintomas+consultas+farmácias+skills

### Fase 3 — Tratamentos + inventário + adesão
- 9 tools: `start_treatment_from_order`, `log_medication_taken`, `update_treatment_status`, `log_symptom`, `query_my_addresses`, `set_default_address`, `start_consultation_search`, `confirm_consultation_selection`, `cancel_consultation`
- Workers: `inventory-tracker.worker.ts` (6h) + `adherence-scorer.worker.ts` (24h)
- Red flag detection inline em `log_symptom`

### Fase 4 — Fluxo completo de consulta médica (NOVA)
- **Migration 0005**: adiciona `'clinic'` ao enum `conversation_party_t` + coluna `clinic_id` em `conversations`
- **Discovery**: `clinic-discovery.ts` busca clínicas via Google Places (`type=doctor`, keyword=specialty) + cache via `find_clinics` RPC
- **Tools agente clínica**: `agent-clinic-tools.ts` com 6 tools (`record_clinic_ack`, `record_clinic_unavailable`, `record_consultation_quote`, `request_clarification`, `finalize_clinic_contact`, `record_appointment_confirmation`)
- **System prompt B2B profissional**: `agent-clinic.system.ts` com árvore de decisão (horário+preço+plano)
- **Handler**: `agent-clinic.ts` espelha `inbound-supplier.ts` mas com `consultation_quotes`
- **Consolidação**: `consultation-consolidation.ts` com timers 5min/10min (clínicas demoram mais) e ranking por score (horário + rating + preço)
- **Wiring**: `tool-executor-v2.handleStartConsultationSearch` agora descobre clínicas, cria quotes paralelas, agenda timer
- **Confirmação**: `handleConfirmConsultation` agenda consulta + cria reminders (1d antes + 2h antes) + avisa clínica
- **Cancelamento**: cancela reminders + avisa clínica
- **Roteamento**: webhook detecta `party_type='clinic'` e dispatcha pra `processInboundClinic`
- **Feedback pós-consulta**: worker `consultation-feedback.worker.ts` (1h) — pede rating 24h após consulta

### Fase 5 — Knowledge Graph + Skills emergentes (NOVA)
- **knowledge-graph-builder worker** (6h): popula `entity_relations` a partir de `user_medications`, `user_health_conditions`, `user_allergies`, `treatments`, `orders.selected_quote`, `consultations`, `symptoms_log` via RPC `add_or_refresh_relation`
- **skill-extractor worker** (24h): detecta padrões N≥3 em audit_log + tabelas. Skills V1:
  - `preferred_reminder_time` (hora mais frequente em treatments)
  - `preferred_pharmacy` (supplier mais selecionado)
  - `routine_medication_timing` (período do dia mais comum)
  - `preferred_plan` (plano de saúde mais usado em consultas)
- **Skills no prompt**: `loadUserSkills() + formatSkillsForPrompt()` em `@iasaude/db`. Anexa ao system prompt da Xarlote. High confidence → aplica direto; medium → pergunta antes.

### Fase 6 — Dashboard novo (NOVA)
- **5 páginas novas** em `apps/web/app/(dash)/`:
  - `/treatments` — lista tratamentos com aderência, inventário low
  - `/consultations` — lista consultas (em andamento / agendadas / realizadas)
  - `/clinics` — diretório de clínicas (filtro por especialidade/cidade)
  - `/audit` — viewer de audit_log com filtros + auto-refresh 5s + expansão JSON
  - `/metrics` — KPIs diários + breakdown LLM + custos + red flags + histórico 14d
- **Sidebar** atualizada com novos links + ícones
- **5 endpoints admin novos**: `GET /admin/treatments`, `/admin/consultations`, `/admin/clinics`, `/admin/metrics`, `/admin/skills` (futuro)

### Fase 7 — Anomaly + observabilidade (NOVA)
- **red_flag_check tool dedicada** (Xarlote chama quando detecta risco real):
  - 10 categorias (`self_harm`, `suicide_ideation`, `chest_pain`, `stroke_signs`, `overdose`, `severe_bleeding`, `breathing_difficulty`, `allergic_reaction_severe`, `child_emergency`, `other_critical`)
  - Resposta pré-formatada (SAMU 192 / CVV 188 conforme categoria)
  - Audit critical + Telegram alert
- **telegram-alerter.ts**: envia pra `TELEGRAM_BOT_TOKEN` + `TELEGRAM_ALERT_CHAT_ID`. Throttling 1msg/min por throttleKey; severity 'critical' bypassa.
- **anomaly-detector worker** (10min):
  1. Red flags sem follow-up nas últimas 1h
  2. >10 tool.failed em 10min
  3. LLM p95 >30s em 30min
  4. Conversas com inbound há >2h sem outbound
  5. Order failure rate >30% em 24h
- **metrics-aggregator worker** (1h): agrega `event_log + audit_log + orders + consultations` em `daily_metrics` (migration 0006)

### Fase 8 — Hardening
- **Typecheck monorepo OK**: 9 pacotes, 0 erros
- **Build monorepo OK**: api/web/db/llm/integrations/whatsapp/shared/core compilam
- 19 rotas Next.js no dashboard
- Workers em produção (single process):
  - reminder-dispatcher (30s)
  - profile-enricher (queue)
  - conversation-compactor (1h)
  - inventory-tracker (6h)
  - adherence-scorer (24h)
  - consultation-feedback (1h)
  - kg-builder (6h)
  - skill-extractor (24h)
  - anomaly-detector (10min)
  - metrics-aggregator (1h)

---

## 🚦 O que falta pra estar 100% em produção

### CRÍTICO — fazer AGORA

#### 1. Aplicar as 5 migrations no Supabase (ORDEM IMPORTA)

**Caminho A (recomendado — CLI):**
```bash
cd /Users/hiagovieira/IA_da_saude
npx supabase db push
```

**Caminho B (manual — SQL Editor, na ordem):**
1. `infra/supabase/migrations/0002_audit_log.sql`
2. `infra/supabase/migrations/0003_xarlote_v2_schema.sql`
3. `infra/supabase/migrations/0004_xarlote_v2_functions.sql`
4. `infra/supabase/migrations/0005_clinic_conversations.sql`
5. `infra/supabase/migrations/0006_daily_metrics.sql`
6. `infra/supabase/migrations/0007_emergency_contact_red_flag_buttons.sql` ⚠️ NOVA — botões + escalonamento

> Tudo é aditivo. `ALTER TYPE ... ADD VALUE IF NOT EXISTS` é compat com PG 12+.

#### 2. Configurar variáveis de ambiente novas

**Railway env (opcional mas recomendado):**
```bash
# Telegram alerter (pra red flags + anomalies)
TELEGRAM_BOT_TOKEN=...        # cria via @BotFather
TELEGRAM_ALERT_CHAT_ID=...    # seu chat_id ou de um grupo

# Já existentes (não mexer):
ELEVENLABS_API_KEY=sk_xxx
OPENROUTER_API_KEY=sk_xxx
SUPABASE_SERVICE_ROLE_KEY=eyJ...
GOOGLE_MAPS_API_KEY=AIza...
UAZAPI_SARA_TOKEN=...
UAZAPI_AGENT_TOKEN=...
```

#### 3. Deploy no Railway
```bash
railway login                  # token expira
cd /Users/hiagovieira/IA_da_saude
railway up --detach
curl https://ia-da-saude-api-production.up.railway.app/health
```

#### 4. Deploy no Vercel (frontend)
```bash
cd /Users/hiagovieira/IA_da_saude/apps/web
vercel --prod
```

#### 5. Smoke test ponta-a-ponta

```bash
export API=https://ia-da-saude-api-production.up.railway.app

# Endpoints novos
curl -s "$API/admin/audit?limit=5" | jq '.[0]'
curl -s "$API/admin/treatments?status=active&limit=5" | jq
curl -s "$API/admin/consultations?status=active&limit=5" | jq
curl -s "$API/admin/clinics?limit=5" | jq
curl -s "$API/admin/metrics?days=7" | jq
```

#### 6. Testes funcionais no WhatsApp

- **Fluxo de tratamento**:
  - Pedir "Losartana 50mg 1 caixa, manda pra casa"
  - Confirmar pedido → Xarlote pergunta horário
  - Responder "8h" → `start_treatment_from_order` cria treatment + inventory + reminder
  - Em 7 dias, inventory-tracker oferece reposição automaticamente

- **Fluxo de consulta** (NOVO):
  - Pedir "preciso marcar um cardiologista pra essa semana"
  - Xarlote chama `start_consultation_search(specialty="cardiologista", urgency="72h", plan="particular")`
  - Sistema descobre 5 clínicas via Google Places
  - 5 conversas WhatsApp em paralelo com clínicas (instância agent)
  - Em 5-10min, consolidação apresenta top 3 ao paciente
  - Paciente escolhe → `confirm_consultation_selection` → reminder 1d e 2h antes
  - 24h após consulta → worker pede feedback

- **Red flag**:
  - Dizer algo como "tô com dor no peito muito forte"
  - Xarlote deve chamar `red_flag_check(category="chest_pain", severity="high")`
  - Resposta padronizada com SAMU 192
  - Audit + Telegram alert disparado

---

## 📊 Sprint roadmap pós-deploy

| Sprint | Conteúdo | Tempo |
|---|---|---|
| **Beta interno** | 5-10 usuários do círculo do fundador, feedback estruturado, monitorar anomaly-detector | 1 sem |
| **Beta externo** | 20 usuários reais, alerta Telegram crítico, ajustes no prompt | 2 sem |
| **GA limitado** | 100 primeiros usuários | 1 mês |
| **GA** | aberto | — |

---

## 🔍 Como auditar e melhorar a Xarlote depois (uso prático)

### Dashboard
- `http://localhost:3002/audit` — todos os audit_log com filtros (action/red_flag/tool.failed)
- `http://localhost:3002/metrics` — KPIs do dia (LLM p95, custo, red flags, orders)
- `http://localhost:3002/treatments` — aderência por paciente
- `http://localhost:3002/consultations` — funil de consultas

### CLI
```bash
# Ver mudanças de estado de um paciente
curl -s "$API/admin/audit?user_id=UID&limit=50" | jq '.[] | {ts: .occurred_at, action, reason, before, after}'

# Erros de tool
curl -s "$API/admin/audit?action=tool.failed&limit=20" | jq

# Red flags detectados (críticos)
curl -s "$API/admin/audit?action=red_flag.detected&limit=20" | jq

# Latência média de TTS
curl -s "$API/admin/events?event_name=tts.synthesized&limit=100" | jq '[.[].duration_ms] | add/length'

# Trace inteiro (todos os eventos com mesmo trace_id)
curl -s "$API/admin/audit?trace_id=TRACE_UUID"
curl -s "$API/admin/events?trace_id=TRACE_UUID"

# Sumário de ações por dia
curl -s "$API/admin/audit/summary?days=7" | jq

# Métricas diárias
curl -s "$API/admin/metrics?days=14" | jq
```

---

## 📚 Arquivos novos criados nessa sessão (Fases 4-8)

```
infra/supabase/migrations/
├── 0005_clinic_conversations.sql        # ADD 'clinic' enum + clinic_id col
└── 0006_daily_metrics.sql               # daily_metrics aggregation table

packages/db/src/
└── skills.ts                            # loadUserSkills, formatSkillsForPrompt

packages/integrations/src/
└── google-places.ts                     # +findNearbyClinics

packages/llm/src/
├── tools/agent-clinic-tools.ts          # 6 tools clínica
└── prompts/agent-clinic.system.ts       # system prompt B2B clínica

apps/api/src/
├── handlers/
│   ├── clinic-discovery.ts              # Google Places + cache clinics
│   ├── agent-clinic.ts                  # processInboundClinic + initiateClinicNegotiation
│   ├── consultation-consolidation.ts    # timers 5/10min + ranking score
│   ├── red-flag-handler.ts              # 10 categorias + SAMU/CVV
│   └── telegram-alerter.ts              # Telegram + throttle
└── workers/
    ├── consultation-feedback.worker.ts  # 1h — rating 24h pós-consulta
    ├── knowledge-graph-builder.worker.ts # 6h — popula entity_relations
    ├── skill-extractor.worker.ts        # 24h — detecta padrões N>=3
    ├── anomaly-detector.worker.ts       # 10min — 5 detectores
    └── metrics-aggregator.worker.ts     # 1h — daily_metrics

apps/web/app/(dash)/
├── audit/page.tsx                       # viewer audit_log
├── metrics/page.tsx                     # KPIs + histórico 14d
├── treatments/page.tsx                  # lista treatments
├── consultations/page.tsx               # lista consultas
└── clinics/page.tsx                     # diretório clínicas
```

---

## ⚠️ Cuidados pra produção

- **Migrations são aditivas** — não destroem dados existentes
- **Workers fazem graceful degrade** — se RPC não existe, silenciam
- **Audit nunca derruba fluxo** — falhas de auditoria viram event_log
- **inbound-user.ts já trata fallback do queryUser360 + loadUserSkills** — se RPC ou tabela não existe, cai pras queries antigas
- **Telegram opcional** — sem `TELEGRAM_BOT_TOKEN`, os alerts apenas logam
- **Não comitar** `apps/api/data/prompts.json` (gitignored, tem keys)
- **anomaly-detector + telegram-alerter** podem fazer Telegram lotar de alertas no início. Recomendado começar com threshold mais alto via env futuro.

---

## 🔐 Princípios travados (não regredir)

1. **Audit-first**: cada mudança de estado tem evidence em `audit_log`. Se falhar audit, vira `event_log` silent.
2. **Idempotência**: tools rotuladas com guard (existing active order/consultation).
3. **Single process workers**: BullMQ + setInterval no mesmo container Railway. Sem worker separado.
4. **Naming**: Xarlote é o nome do produto. `SARA_INSTANCE` constant fica pra compat uazapi.
5. **Graceful degrade everywhere**: RPC missing → fallback queries. Telegram missing → log only. Audit missing → event_log.
6. **Red flags > tudo**: `red_flag.detected` audit + Telegram critical + SAMU pre-formatado nunca pode falhar.
7. **LGPD**: forget-me cascata + memory soft-delete + audit imutável (8 anos retenção).
