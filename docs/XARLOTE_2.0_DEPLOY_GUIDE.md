# Xarlote 2.0 — Guia de Deploy

> Status: Fases 0-3 implementadas e commitadas. Migrations pendentes de aplicação manual.
> Branch: `main` · Commits: rename → audit → schema → user_360 → tratamentos

---

## ✅ O que ficou pronto nessa sessão

### Fase 0.A — Rename Sara → Xarlote
- Arquivos movidos: `sara.system.ts → xarlote.system.ts`, `sara-tools.ts → xarlote-tools.ts`
- Símbolos: `saraTools → xarloteTools`, `buildSaraSystemPrompt → buildXarloteSystemPrompt`
- Todos os comentários "Sara" no código viraram "Xarlote"
- Mantidos por compat de deploy: `SARA_INSTANCE` (constante uazapi) + `UAZAPI_SARA_TOKEN` (env)

### Fase 0.B — Infraestrutura de auditoria
- **2 tabelas novas**: `audit_log` (mudanças de estado) + `event_log` (telemetria)
- **2 RPC functions**: `write_audit()`, `write_event()` (SECURITY DEFINER)
- **TypeScript helpers**: `writeAudit()`, `writeEvent()`, `auditToolCall()`, `auditUserStateChange()`, `auditMemoryWrite()` em `@iasaude/db`
- **Integrado em 7 pontos críticos**:
  - Consent flow (LGPD): cada transição vira audit row
  - Forget-me: 3 audit events (requested, executing, executed) + lista tabelas limpas
  - Onboarding profiling→active: rastreado
  - LLM completion: event_log com tokens/duration/cost
  - Tool calls: success + failure auditados, com duration_ms
  - Memory cards: cada save auditado
  - Prompts config (admin save): diff before/after com keys redactadas
  - TTS synthesized: event_log com latency
- **Endpoints novos**: `GET /admin/audit`, `/admin/audit/summary`, `/admin/events`

### Fase 1 — Schema novo (migrations)
**3 arquivos em `infra/supabase/migrations/`:**
- `0002_audit_log.sql` — audit_log + event_log + RPCs
- `0003_xarlote_v2_schema.sql` — 11 tabelas novas:
  - `treatments`, `medication_inventory`, `medication_log`
  - `prescribers`, `clinics`, `consultations`, `consultation_quotes`
  - `symptoms_log`, `entity_relations`, `agent_skills`, `feedback_events`
  - Expansões em `users` (adherence_score, communication_prefs, primary_doctor),
    `user_addresses` (usage_count, is_default, notes),
    `user_medications` (treatment_id, tablets_per_box, daily_consumption, etc)
- `0004_xarlote_v2_functions.sql` — 6 SQL functions:
  - `calc_adherence_score(user, days)`
  - `medications_running_low(threshold_days)`
  - `find_clinics(specialty, city, state, k)`
  - `pharmacy_history(user, months)`
  - `add_or_refresh_relation(...)` — upsert em entity_relations
  - `query_user_360(user)` — perfil rico em UM JSON pra prompt context

### Fase 2 — query_user_360 no prompt
- `packages/db/src/user360.ts`: `queryUser360()` + `formatUser360ForPrompt()`
- `inbound-user.ts` tenta usar perfil unificado; fallback gracioso pras N queries antigas
- System prompt da Xarlote agora ganha seção com tratamentos+inventário+sintomas+consultas+farmácias preferidas+skills

### Fase 3 — Tratamentos + inventário + adesão
- **9 tools novas** em `xarlote-tools.ts`:
  - `start_treatment_from_order` · `log_medication_taken` · `update_treatment_status` · `log_symptom`
  - `query_my_addresses` · `set_default_address`
  - `start_consultation_search` · `confirm_consultation_selection` · `cancel_consultation`
- **Handlers** em `tool-executor-v2.ts` — cada um com audit + graceful degrade
- **Red flag detection inline** em `log_symptom` (suicídio, dor no peito, intensidade ≥9)
- **2 workers novos**:
  - `inventory-tracker.worker.ts` (6h): detecta meds ≤7d restantes → Xarlote oferece reposição
  - `adherence-scorer.worker.ts` (24h): calcula score 30d, audita drops >20%
- **Prompt expandido** com seção "FERRAMENTAS" cobrindo critérios precisos pra cada tool

---

## 🚦 O que falta pra estar 100% em produção

### CRÍTICO — fazer AGORA

#### 1. Aplicar as 3 migrations no Supabase

**Caminho A (recomendado — CLI):**
```bash
cd /Users/hiagovieira/IA_da_saude
npx supabase db push
```

**Caminho B (manual — SQL Editor):**
1. Abre o Supabase dashboard do projeto Xarlote
2. Vai em "SQL Editor"
3. Cola e roda na ORDEM:
   - `infra/supabase/migrations/0002_audit_log.sql`
   - `infra/supabase/migrations/0003_xarlote_v2_schema.sql`
   - `infra/supabase/migrations/0004_xarlote_v2_functions.sql`
4. Verifica que rodou sem erros

> Tudo é aditivo. Sem ALTER destrutivo. Tabelas existentes ganham colunas novas com defaults.

#### 2. Deploy no Railway

```bash
railway login                  # token expirou na minha sessão
cd /Users/hiagovieira/IA_da_saude
railway up --detach
```

Depois confere:
```bash
curl https://ia-da-saude-api-production.up.railway.app/health
```

#### 3. Smoke test ponta-a-ponta

```bash
# Verifica que as novas rotas existem
curl -s "https://ia-da-saude-api-production.up.railway.app/admin/audit?limit=5" | head -c 200

# Reset um user pra testar fluxo virgem (substitua o user_id)
curl -X POST "https://ia-da-saude-api-production.up.railway.app/admin/users/SEU_UID/reset-audio-intro" \
  -H 'Content-Type: application/json' -d '{"fullFlow":true}'
```

Depois manda mensagens no WhatsApp pra testar:
- Aceitar LGPD
- Falar o nome → áudio Carla
- Pedir "Losartana 50mg 1 caixa, manda pra casa"
- Confirmar pedido → Xarlote deve perguntar horário do lembrete
- Responder "8h" → ela chama `start_treatment_from_order`
- Daí em diante o inventory-tracker vai cuidar de alertar quando acabar

---

## 📊 O que falta pra Xarlote 2.0 COMPLETA (próximas sessões)

| Fase | Conteúdo | Tempo |
|---|---|---|
| **Fase 4** | Fluxo completo de consulta médica: `clinic-discoverer` worker (Google Places + cache em `clinics`), `agent-clinic` handler (espelho de agent-pharmacy), timer 10min, integração com `start_consultation_search` que hoje é só esqueleto | 1.5 sem |
| **Fase 5** | `knowledge-graph-builder` worker (popula `entity_relations` a partir de cada enricher run); `skill-extractor` worker (detecta padrões N>=3 e cria `agent_skills`) | 1 sem |
| **Fase 6** | Páginas novas no dashboard: `/treatments`, `/consultations`, `/clinics`, `/audit`, `/events`, `/metrics`, `/skills` + aba "Saúde 360" em `/users/[id]` | 1 sem |
| **Fase 7** | `anomaly-detector` worker (palavras críticas + padrões suspeitos → Telegram alert); `red_flag_check` tool dedicada; `metrics-aggregator` worker (agrega event_log em métricas) | 0.5 sem |
| **Fase 8** | Hardening, load test 50 concurrent users, prompt slimming, smoke test pré-beta | 1 sem |
| **Beta** | 20 usuários reais com feedback estruturado | 2 sem |
| **GA** | 100 primeiros usuários | — |

---

## 🔍 Como auditar e melhorar a Xarlote depois (uso prático)

### Ver mudanças de estado de um paciente
```bash
curl -s "$API/admin/audit?user_id=UID&limit=50" | jq '.[] | {ts: .occurred_at, action, reason, before, after}'
```

### Ver erros de tool
```bash
curl -s "$API/admin/audit?action=tool.failed&limit=20" | jq '.[] | {action, metadata}'
```

### Ver latência média de TTS
```bash
curl -s "$API/admin/events?event_name=tts.synthesized&limit=100" | jq '[.[].duration_ms] | add/length'
```

### Tracear um turno inteiro (todos os eventos com mesmo trace_id)
```bash
curl -s "$API/admin/audit?trace_id=TRACE_UUID"
curl -s "$API/admin/events?trace_id=TRACE_UUID"
```

### Sumário de ações por dia
```bash
curl -s "$API/admin/audit/summary?days=7" | jq
```

---

## 📚 Arquivos novos criados

```
docs/
├── PLAN_XARLOTE_2.0.md           # roadmap completo 18 seções
└── XARLOTE_2.0_DEPLOY_GUIDE.md   # este arquivo

infra/supabase/migrations/
├── 0002_audit_log.sql             # audit + event tables + RPCs
├── 0003_xarlote_v2_schema.sql     # 11 tabelas novas
└── 0004_xarlote_v2_functions.sql  # 6 functions + materialized data

packages/db/src/
├── audit.ts                       # writeAudit, writeEvent, helpers
└── user360.ts                     # queryUser360, formatUser360ForPrompt

apps/api/src/
├── handlers/tool-executor-v2.ts   # 8 handlers das tools novas
└── workers/
    ├── inventory-tracker.worker.ts
    └── adherence-scorer.worker.ts

packages/llm/src/
├── prompts/xarlote.system.ts     # (renomeado de sara.system.ts)
└── tools/xarlote-tools.ts        # (renomeado, +9 tools novas)
```

---

## ⚠️ Cuidados

- **Não comitar** `apps/api/data/prompts.json` (gitignored agora, tem keys)
- **Migrations são aditivas** — não destroem dados existentes
- **Audit log nunca derruba fluxo** — falha de auditoria vira event_log silencioso
- **Workers fazem graceful degrade** — se RPC `medications_running_low` ou `calc_adherence_score` ainda não existe (migration pendente), o worker silencia
- **inbound-user.ts já trata fallback do queryUser360** — se RPC não existe, cai pras queries individuais antigas
