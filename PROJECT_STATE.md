# PROJECT_STATE.md — IA da Saúde

> Leia sempre este arquivo antes de tocar em qualquer código.

---

## 1. O que é o projeto

**IA da Saúde** — concierge de saúde por WhatsApp.
- **Sara** (persona): conversa com o usuário via WhatsApp
- **Agente** (persona): negocia com farmácias via WhatsApp
- **MVP**: usuário pede medicamento → Sara coleta localização → busca 5 farmácias reais (Google Places) → agente negocia em paralelo → consolida top-3 → envia preço/Pix ao usuário

---

## 2. Estado atual — 2026-05-28

> ### 🚀 Xarlote 2.0 — Fases 0-8 implementadas, banco migrado, código commitado
>
> **Persona renomeada Sara → Xarlote em todo o código** (constante `SARA_INSTANCE` e env `UAZAPI_SARA_TOKEN` mantidas por compat de deploy).
>
> **Supabase (projeto `niqmxiybiwrfkvdfojcq`): 10 migrations aplicadas via MCP** — 34 tabelas. Audit hardening (REVOKE anon nas SECURITY DEFINER, search_path fixo, RLS nas órfãs) aplicado.
>
> **Git**: branch `main`, **55 commits à frente do `origin`** (NÃO foram pushados). Último: `6db2e29`.
> **Produção (Railway)**: rodando deploy `e1f0e5c` (Fases 4-8 base). **6 commits de fixes pendentes de `railway up`** (`7d7d3ed`→`6db2e29`).
>
> | Capacidade nova (2.0) | Código | Prod |
> |---|---|---|
> | **Auditoria** (`audit_log`+`event_log`+RPCs) + 7 pontos integrados | ✅ | ✅ |
> | **Timeline ao vivo** `/admin/timeline` (audit+event+logs unificados) | ✅ | ⏳ deploy |
> | **Tratamentos** + inventário + adesão (workers 6h/24h) | ✅ | ✅ |
> | **Consulta médica**: discovery Places (geocode cidade + telefone=canal), agent-clinic, consolidação, feedback | ✅ | ⏳ deploy |
> | **Simulador de clínica** (`CLINIC_OUTBOUND_MODE`=sim por padrão; painel no /simulator) | ✅ | ⏳ deploy |
> | **Knowledge graph** (`entity_relations`) + **skills** (`agent_skills`) workers | ✅ | ✅ |
> | **Red flag com BOTÕES WhatsApp** + escalonamento 60s pro contato de emergência | ✅ | ⏳ deploy |
> | **`set_emergency_contact`** tool + `users.emergency_contact_*` | ✅ | ⏳ deploy |
> | **Anomaly detector** (10min) + **metrics aggregator** (1h → `daily_metrics`) | ✅ | ✅ |
> | **Dashboard**: 5 páginas novas (`/treatments /consultations /clinics /audit /metrics`) | ✅ | local/Vercel |
> | **TTS**: saudação sem vírgula + "o que posso fazer por você hoje?" | ✅ | ⏳ deploy |
> | **Histórico LLM inclui áudio** (transcript) — corrige saudação repetida | ✅ | ⏳ deploy |
> | **Cidade no perfil** (`users.home_city`) — confirma em vez de perguntar | ✅ | ⏳ deploy |
>
> **13 workers no processo da API**: reminder-dispatcher (30s), profile-enricher (queue), conversation-compactor (1h), inventory-tracker (6h), adherence-scorer (24h), consultation-feedback (1h), consultation-dispatcher (30s, resgata cotações órfãs), kg-builder (6h), skill-extractor (24h), anomaly-detector (10min), metrics-aggregator (1h).
>
> **⏳ PENDENTE PRA 100% EM PRODUÇÃO**: `railway up` (6 commits) + decidir `CLINIC_OUTBOUND_MODE=real` quando validar o simulador de clínica.

### Base MVP (mantida, funcionando)

| Item | Status |
|---|---|
| **Fluxo end-to-end (WhatsApp real → Xarlote → cotação 5 farmácias)** | ✅ **FUNCIONANDO em produção** |
| LLM (OpenRouter) | ✅ Modelo `deepseek/deepseek-v4-flash` + fallback chain (`gpt-4.1-mini`, `gpt-4o-mini`) — sem trava em 429 upstream |
| uazapi (instância Sara — usuários) | ✅ Conectada · `VEDACIL-HIAGO` · número `+55 62 9834-5024` |
| uazapi (instância Agente — farmácias) | ⏳ **Não conectada** · respostas simuladas via dashboard |
| Webhook uazapi | ✅ `POST /webhook/uazapi/VEDACIL-HIAGO` configurado no painel |
| Mensagem inicial LGPD (botões Aceitar/Recusar) | ✅ uazapi `/send/menu` |
| Comando `@teste` (reset total via WA) | ✅ Funciona |
| Localização (botão 📍 WhatsApp) | ✅ **Corrigido** — extrai de `message.content.degreesLatitude/Longitude` (formato real Baileys), não de `message.latitude/longitude` |
| Localização por endereço texto | ✅ Nominatim + ViaCEP fallback |
| Google Places (busca farmácias) | ✅ Legacy Nearby Search — 5 farmácias reais por raio (3/5/8 km) |
| Consolidação de cotações | ✅ 3min/5min com modo eager |
| **Chat manual de farmácia no dashboard** | ✅ botão "Responder como farmácia" em cada quote do `/orders/[id]` (drawer com realtime + composer) |
| Dashboard local | ✅ porta **3002** · aponta `NEXT_PUBLIC_API_URL` pra produção (Railway) |
| Dashboard — anon key Supabase | ✅ Corrigida (estava com `iat:1755…` em vez de `1775…`) + RLS policies `anon_read_*` aplicadas |
| API Railway | ✅ `https://ia-da-saude-api-production.up.railway.app` · health 200 |
| **Memória persistente evolutiva** (estilo Hermes) | ✅ pgvector + `memory_cards_index` + 4 kinds (fact/episode/preference/affect) + decay temporal por tipo + retrieval semântico top-K=8 antes de cada turn |
| **Profile Enricher worker** | ✅ async post-turn, extrai fatos confidence ≥ 0.7, popula `user_*` + `memory_cards_index` (com embedding `text-embedding-3-small`) |
| **Conversation Compactor** | ✅ cron 1h condensa conversas >50 msgs em memory cards `episode` |
| **Áudio nativo (transcrição)** | ✅ `gpt-4o-audio-preview` via OpenRouter chat-with-audio (input_audio na content array) — OpenRouter NÃO expõe Whisper, gpt-4o-audio é o caminho |
| **Imagem nativa (multimodal vision)** | ✅ canal real `image_url` do protocolo OpenAI (não mais base64-em-string) — Sara enxerga foto de receita / embalagem / exame / qualquer coisa direto |
| **Interruptor mestre Xarlote (on/off)** | ✅ toggle no `/prompts` — quando off, webhook descarta msgs sem chamar LLM |
| **Controles de modelo no dashboard** | ✅ `/prompts` com dropdowns: LLM principal, modelo de visão, modelo de áudio, persistidos em `apps/api/data/prompts.json` |
| **Página Perfil 360** | ✅ `/users/[id]` com memória agrupada por kind, badges de origem (`auto`/`usuário`), confidence bars, lembretes ativos |
| **Reverse geocode (botão 📍)** | ✅ Nominatim primário (rua + setor + CEP) + Google fallback (a key do Google Maps tem só Places liberado, Geocoding nega) |
| **API + Worker no mesmo processo** | ✅ healthcheck Railway exigia 1 processo único — workers (reminder-dispatcher, profile-enricher, compactor) movidos pra `apps/api/src/workers/` |

**uazapi instância Sara**: `WHATSAPP_MODE=uazapi`, `UAZAPI_SERVER_URL=https://criate.uazapi.com`, `UAZAPI_SARA_TOKEN` configurado. Nome da instância lido via `UAZAPI_SARA_INSTANCE` (padrão `sara`).

**Webhook URL** (configurar no painel uazapi → "Configurar webhook"):
`https://ia-da-saude-api-production.up.railway.app/webhook/uazapi/VEDACIL-HIAGO`

---

## 3. Para rodar localmente

```bash
pnpm --filter api dev    # API → :3001
pnpm --filter web dev    # Dashboard → :3002
# Abrir: http://localhost:3002/simulator
```

---

## 4. Stack (travada)

| Camada | Escolha |
|---|---|
| Backend | Node 20 · TS 5 · Fastify 4 · BullMQ 5 |
| LLM | **OpenRouter** (`openai/gpt-4.1-mini` padrão) — configurável em runtime via `apps/api/data/prompts.json` sem reiniciar |
| Banco | **Supabase** — projeto `niqmxiybiwrfkvdfojcq` (schema aplicado) |
| Filas | Redis 7 + BullMQ |
| Frontend | Next.js 14 App Router + Tailwind + shadcn/ui |
| WhatsApp | uazapi — instâncias `sara` (usuários) e `agent` (farmácias) |
| Geolocalização | Google Places Legacy Nearby Search ✅ · Nominatim (OSM) para geocoding por texto ✅ |
| Hospedagem | Railway (api + worker + Redis) · Vercel (web) |

---

## 5. Arquitetura resumida

```
Usuário → uazapi "sara" → Fastify API → [inline / BullMQ worker]
                                              ↓
                                    inbound-user.ts (Sara LLM)
                                    tool-executor.ts → start_pharmacy_order
                                              ↓
                                    Google Places → 5 farmácias
                                              ↓
                                    initiatePharmacyNegotiation × 5
                                              ↓
                              uazapi "agent" → Farmácias (WA)
                                              ↓
                                    inbound-supplier.ts (Agent LLM)
                                    record_quote_price → finalizeQuote
                                              ↓
                                    consolidateQuotes → Sara → Usuário
```

---

## 6. Arquivos críticos

| Arquivo | Função |
|---|---|
| `apps/api/src/handlers/inbound-user.ts` | Processa mensagem do usuário, chama Sara LLM |
| `apps/api/src/handlers/tool-executor.ts` | Executa tools da Sara (start_pharmacy_order, geocoding, etc.) |
| `apps/api/src/handlers/inbound-supplier.ts` | Processa resposta da farmácia, chama Agent LLM |
| `apps/api/src/handlers/outbound-agent.ts` | Envia mensagem do agente para farmácia (simulator: só salva no DB) |
| `apps/api/src/handlers/quote-consolidation.ts` | Consolida cotações e envia top-3 ao usuário |
| `apps/api/src/routes/simulate.ts` | Endpoints do simulador (inbound, pharmacy-reply, active-order, etc.) |
| `packages/llm/src/prompts/agent-pharmacy.system.ts` | Prompt do agente — **árvore de decisão explícita** para chamar tools |
| `packages/llm/src/prompts/sara.system.ts` | Prompt da Sara |
| `packages/integrations/src/google-places.ts` | Google Places Legacy Nearby Search |
| `packages/integrations/src/geocoding.ts` | Geocoding — **PRECISA migrar para Nominatim** |
| `apps/api/data/prompts.json` | Config runtime: model + API key (sem reiniciar) |
| `apps/web/components/simulator/WhatsAppSim.tsx` | Simulador — aba Usuário + aba Farmácias |

---

## 7. Modelo de dados (resumo)

Tabelas principais: `users`, `conversations`, `messages`, `orders`, `quotes`, `suppliers`, `assistant_tasks`, `system_logs`, `consent_events`, `reminders`, `prescriptions`.

RLS ativa em tudo. Backend usa service role. Dashboard usa anon + `is_staff()`.

---

## 8. Glossário

| Termo | Significado |
|---|---|
| **Sara** | IA que fala com o usuário |
| **Agente** | IA que fala com farmácias |
| **Order** | Pedido (ex: Dipirona 500mg) |
| **Quote** | Cotação de uma farmácia dentro de uma Order |
| **Supplier** | Farmácia |
| **Tool call** | Função chamada pela LLM (OpenAI function calling) |
| **Trace ID** | UUID que correlaciona toda a cadeia de um evento |

---

## 9. Log de mudanças

| Data | Mudança |
|---|---|
| 2026-06-07 | **F1.B2 — trace_id ponta-a-ponta (código pronto, deploy pendente).** Antes o traceId nascia DENTRO de `processInboundUser`/`processInboundSupplier` (randomUUID interno) — então os logs de borda do webhook (rate-limit, "desligada", idempotência) não tinham id, e **erros do processamento async (`setImmediate`) morriam num `req.log.error` invisível, sem ir pro Sentry**. Agora o traceId NASCE no webhook (ingresso): aceita `x-trace-id` de entrada (correlação distribuída) ou gera UUID, volta no **header `x-trace-id` da resposta** e é passado aos handlers (assinaturas ganharam `traceId` opcional, default randomUUID p/ compat com simulate/testes). Erros async agora vão pro **Sentry COM o trace** (`captureError({traceId, phase})`), e `captureError` promove `traceId` a **tag filtrável**; o enricher captura falhas com o trace. Filas (outbound + enricher) e workers já carregavam o id → trilha completa webhook→fila→worker→resposta. Validado: typecheck+build+31 testes; smoke do header (gera UUID quando ausente, ecoa quando fornecido). **Falta deploy** (additivo, seguro em service único). |
| 2026-06-07 | **F2.G2 — latência: matar o N+1 do inbound (código pronto, deploy pendente).** O caminho quente de toda mensagem (`inbound-user.ts`) montava o contexto em **série**: histórico → user360 → pedido ativo → embed → retrieval de memória → skills = ~6-8 round-trips ao banco em sa-east-1 (cada ~150ms do compute US-West) ≈ **1-2s de rede morta ANTES de a LLM começar**. Reescrito pra **`Promise.all`** (essas leituras só dependem de user.id/conversation.id) → custo vira o round-trip mais lento, não a soma. Também: persistência da msg + bump de `last_message_at` paralelos; a query de contagem do voice-intro agora só roda quando o áudio-intro é de fato possível (pula no caso comum). **Economia estimada ~0.7-1.2s/msg.** Comportamento 100% preservado (mesmas expressões, fallbacks e logs — só reordenadas). **Pooling/PgBouncer da DoD é N/A:** acesso é todo `@supabase/supabase-js` (PostgREST/HTTP), sem driver PG direto → não há pool client-side; pooling é server-side. Validado: typecheck + build + 31 testes verdes. **Falta deploy** (seguro em service único `ROLE=all`, não depende da separação F1.A1). |
| 2026-06-07 | **F1.A1 — separação API/workers (código pronto, deploy pendente de aprovação).** Os 12 workers + filas outbound viviam DENTRO do processo HTTP (`server.ts`) → um leak/loop em qualquer cron derrubava o inbound inteiro (causa-raiz da fragilidade do 02/06). Refatorado pra **entrypoint único com env `ROLE`** (`all` default = api+workers no mesmo processo, comportamento idêntico ao de hoje · `api` = só HTTP · `worker` = só workers). Novo `apps/api/src/workers/start-all.ts` (fonte única do que roda em background, com guarda de idempotência + disposers de shutdown). `server.ts` registra rotas de negócio só em role `api`; `/health`+`/ready` em todos os roles (Railway/UptimeRobot batem até no worker). **Deletado o `apps/worker` legado** — footgun real: só tinha 3 dos 12 workers e fazia `pnpm dev` rodar reminder/enricher/compactor EM DOBRO localmente; lockfile regenerado (frozen ok). Scripts root ajustados (`dev` sem double-run; `dev:worker`/`start:prod` exercitam a separação por porta). **Validação:** typecheck (8/8) + build + 31 testes verdes; **smoke de runtime nos 2 roles** — `ROLE=api`: `/health` 200, `/webhook` responde, log "Workers: OFF"; `ROLE=worker`: `/health` 200, `/webhook` 404 (não existe), log "Workers ON" (12+outbound). **Deploy NÃO muda nada em prod** enquanto `ROLE` ficar `all`. **⏳ PENDENTE founder (afeta prod/billing — aguardando OK):** criar 2º service Railway (`worker`, `ROLE=worker`) compartilhando o repo, depois flipar a API pra `ROLE=api`. Ordem segura: subir worker primeiro → depois flipar api (sem janela sem workers). |
| 2026-06-02 (noite) | **F0/F1/F2 DEPLOYADOS em prod + hotfix de entrega + CI verde + 🔴 achado de segurança.** Deployei o código novo via **`railway up`** (NÃO `--from-source` — o projeto não tem GitHub conectado ao Railway; `redeploy --from-source` só redeploya a imagem antiga). Setei `ADMIN_API_TOKEN` + `CORS_ORIGINS`; verifiquei F0.2 (/admin 401 sem token), F0.3 (/simulate 404), F0.4 (CORS ok), /ready. **Regressão pega e corrigida (commit 9769939):** com Redis AUSENTE em prod, a fila outbound (F0.7) travava o `queue.add` (BullMQ `maxRetriesPerRequest:null` = retry infinito) e o fallback de envio direto não disparava → Xarlote ficava muda pós-consentimento (que vai por sendMenu direto, por isso só ele chegava). Fix: `Promise.race` com timeout de 2s no `queue.add` → cai pro envio direto. Entrega validada pelo founder. **CI/CD ATIVADO + VERDE:** token novo da conta `projetoiasaude` (escopo `repo`+`workflow`) guardado no keychain; corrigi pnpm/action-setup (`version` vs `packageManager`), audit `high→critical` (DoD), gitleaks allowlist de prompts.json. **🔴 SEGURANÇA PENDENTE:** gitleaks achou a **API key do OpenRouter no histórico PÚBLICO** (`apps/api/data/prompts.json`, 3 commits pré-gitignore) → **ROTACIONAR** (revogar no OpenRouter + nova key no Railway `OPENROUTER_API_KEY` + dashboard). **PENDENTE founder:** rotacionar key; OK explícito pra criar **Redis** (rate-limit/memória/−2s latência — guardrail barrou auto-criação por ser recurso pago); UptimeRobot no /health; backup Supabase. Prod roda o código novo. **Redis PROVISIONADO + conectado** (`railway add --database redis` + `REDIS_URL=${{Redis.REDIS_URL}}` na API via rede privada) → `/ready` all-green (db+redis+llm ok); rate-limit/proteção-de-ban + memória ativos, latência normalizada (sem os 2s de fallback). **Key do OpenRouter ROTACIONADA** — nova key validada (GET /key 200) + setada no Railway `OPENROUTER_API_KEY` + live em prod (`/ready` llm ok); a key vazada no histórico foi revogada pelo founder. **Pendentes founder (baixa prioridade): UptimeRobot no /health, backup Supabase.** |
| 2026-06-02 | **Produção caiu (trial Railway expirou) + decisão de infra via conselho.** `/health`→404 "Application not found"; serviço `Failed`, deployments `REMOVED`; `railway redeploy` cuspiu "Your trial has expired". Última atividade no banco 30/05. NÃO foi código (nada deployado). **Decisão (conselho LLM, 5 ângulos + revisão por pares):** ficar no **Railway pago** — pra este workload I/O-bound o host NÃO é o gargalo de escala; o lever real é código (F1/F2) + custo de LLM. Restaurar via `railway redeploy` (código antigo, sem migração; nota: deploy é nixpacks, NÃO há Dockerfile). **Achados do conselho adicionados ao roadmap:** F1.B6 (monitor de uptime externo + alerta de billing — a causa REAL da queda), F1.C7 (Dockerfile/portabilidade), F2.F6 (co-localizar compute em região BR — Railway US-West × Supabase sa-east-1 ≈ 2-3s de rede morta/msg), + anotações em F1.A1 (resiliência≠host), F2.G2 (N+1 é a cura real da latência, co-localização só mascara), F2.H1 (ban uazapi = teto existencial), F3.K4 (soberania de dados/LGPD). **Pendente:** founder selecionar plano Railway → rodar `railway redeploy`. |
| 2026-05-29 | **Sessão de hardening F0→F2 (código) + push destravado.** (0) **F0.8**: 60 commits locais finalmente pushados pro `origin/main` (era a credencial `diretoria-criate` sem write; resolvido aceitando o convite de colaborador). (1) **CI/segurança** (F1.C2/D1/D4): `ci.yml` (typecheck+test+build, frozen lockfile) + `security.yml` (gitleaks OSS + pnpm audit) **ESTACIONADOS na branch `ci-workflows`** (push exige escopo `workflow` no PAT); `dependabot.yml` pushado e ativo; pin `packageManager=pnpm@9.15.9`. (2) **F1.A5 graceful shutdown**: `lifecycle.ts` (SIGTERM/SIGINT → drena HTTP, fecha 3 Workers BullMQ + crons + Redis, timeout duro); client ioredis compartilhado em `queue-config.ts`. (3) **F1.B5+F0.1 health**: `/health` liveness barato (Railway) + `/ready` readiness (DB+Redis críticos→503; ping LLM via `GET /key` detecta 401 sem custo de token, cache 5min). (4) **F1.B1 Sentry** env-gated (`SENTRY_DSN`), scrub de PII, flush no shutdown. (5) **F2.G5 rate-limit** por usuário no webhook (Redis, janela 25/20s, fail-open). (6) **F1.C6 Zod** na resposta do OpenRouter (`client.ts`, lenient). (7) **F1.C1 testes**: vitest no root + 31 testes (redact/PII, consentimento, esquece-me, red-flag keywords) verdes. **Commits `7a88aa4`→`1b34ca1` na main. NÃO deployado** — pendências do founder: deploy Railway + env vars + volume, backup banco (F0.9), branch protection, token com escopo `workflow`, `SENTRY_DSN`. |
| 2026-05-28 | **Xarlote 2.0 — Fases 0-8 + fixes de teste (sessões 20-24).** (0.A) **Rename Sara→Xarlote** em todo o código (perl word-boundary), mantendo `SARA_INSTANCE`/`UAZAPI_SARA_TOKEN`. (0.B) **Auditoria**: `audit_log`+`event_log`+RPCs `write_audit/write_event` (SECURITY DEFINER), helpers TS, 7 pontos integrados (consent, forget-me, onboarding, LLM completion, tool calls, memory, prompts admin, TTS). (1) **Migrations 0002-0010** aplicadas via MCP no projeto `niqmxiybiwrfkvdfojcq` (34 tabelas): treatments, medication_inventory, medication_log, prescribers, clinics, consultations, consultation_quotes, symptoms_log, entity_relations, agent_skills, feedback_events, daily_metrics, red_flag_pending + colunas em users (home_city, emergency_contact_*, adherence_score_30d, communication_prefs) + enums (`order_status_t`+completed, `conversation_party_t`+clinic). 6 SQL functions (calc_adherence_score, medications_running_low, find_clinics, pharmacy_history, add_or_refresh_relation, query_user_360). **Hardening segurança** (0008): REVOKE EXECUTE anon/authenticated das SECURITY DEFINER, `SET search_path`, policies nas tabelas RLS-sem-policy. (2) **query_user_360 + formatUser360ForPrompt** no prompt. (3) **Tratamentos**: 9 tools, handlers em tool-executor-v2, workers inventory-tracker (6h) + adherence-scorer (24h). (4) **Consulta médica**: clinic-discovery (geocode da cidade quando sem lat/lng + telefone do Places como canal de contato), agent-clinic (handler+tools+prompt B2B), consultation-consolidation (timers 5/10min + ranking), consultation-feedback worker (24h), **consultation-dispatcher worker (30s, resgata cotações órfãs pós-restart)**. (5) **Knowledge graph** (kg-builder 6h popula entity_relations) + **skills emergentes** (skill-extractor 24h, 4 padrões) + loadUserSkills no prompt. (6) **Dashboard**: 5 páginas (`/treatments /consultations /clinics /audit /metrics`) + endpoints admin + **`/admin/timeline`** (auditoria ao vivo unificada audit+event+logs, refresh 3s). (7) **Red flag**: tool `red_flag_check` dedicada com **BOTÕES WhatsApp** [Ligar emergência / Avisar contato / Foi engano] + **escalonamento automático 60s** pro `emergency_contact` (migration 0007) + tool `set_emergency_contact`; removida `send_emergency_orientation` (redireciona pra red_flag_check). anomaly-detector (10min, 5 detectores) + metrics-aggregator (1h→daily_metrics). **Telegram removido do red flag** (só WhatsApp+SAMU). (8) **Simulador de clínica**: `sendOutboundToClinic` com `CLINIC_OUTBOUND_MODE` (default=simulação, nunca manda WhatsApp real pra médico sem ativar); endpoints `/simulate/clinic-*`; painel flutuante `ClinicSimPanel` no /simulator. **FIXES de teste E2E**: (a) **bug histórico crítico** — `messagesToHistory` filtrava `content_type==='text'`, apagando a saudação em áudio do histórico → Xarlote repetia "Prazer X!" e ignorava áudio; agora inclui transcript (áudio/imagem/location). (b) **saudação TTS** sem vírgula ("Prazer Hiago!") + fechamento caloroso. (c) **set_emergency_contact bugava** porque API rodava build velho sem a tool; reforçado prompt anti-"não sei salvar". (d) **red flag não disparava botões** porque LLM chamava a tool velha `send_emergency_orientation`; removida + prompt com tabela de gatilhos. (e) **clínica não achava** (sem lat/lng + exigia whatsapp pré-cadastrado) → geocode cidade + telefone como canal. (f) **cotações órfãs** (setTimeout morre no restart) → worker dispatcher. **DEPLOY**: produção roda `e1f0e5c`; 6 commits de fix (`7d7d3ed`→`6db2e29`) pendentes de `railway up`. Build+typecheck monorepo limpos. |
| 2026-05-08 | **Redesign Liquid Glass do dashboard inteiro** (sessão 19). Comportamento intacto — realtime, fetch, API contracts, schema, persona inalterados. (1) **Foundation**: `tailwind.config.ts` com tokens `ink/glass/accent/aurora`, `backdrop-blur-glass=40px`, shadows `glass`/`glass-lg`/`glow-*`, keyframes orbs (60s loop) + shimmer + fadeUp + pulseRing; `globals.css` com utilities `.glass`/`.glass-spec`/`.glass-hi`/`.glass-lo` respeitando `prefers-reduced-transparency`/`-motion`; `AmbientBackground` com 3 orbs (azul/roxo/pink) em radial gradients animados + vinheta + grain SVG; `framer-motion@11` instalado. (2) **Biblioteca `components/ui/`** com 12 primitivos drop-in: GlassCard/GlassPanel, GlassButton (5 variants), GlassInput/Textarea, GlassBadge (7 tones com pulse-ring), StatusPing, Avatar (gradient determinístico por hash), SectionHeader, Tabs (Framer layoutId estilo iOS), EmptyState, Skeleton (shimmer), Stat, Drawer. (3) **Layout shell**: Sidebar refeita como painel flutuante de vidro com pill nav-active animada (`layoutId`), logo "X" gradient azul→roxo, footer com badge `useXarloteStatus()` ao vivo; `template.tsx` aplica page transition fade-up. (4) **10 páginas migradas**: Overview com hero "Cockpit da Xarlote" + 6 cards com glow; conversations/users lists com cards lo; perfil 360 com hero stats + seção Memória agrupada por kind com tints próprios + confidence bars; orders detail com quote cards 3-col preço big tabular; /prompts com hero switch glow-success + sticky save bar; /logs com StatusPing por nível + expand animado; /suppliers com Tabs filter; /simulator shell apenas (WhatsAppSim 944 linhas intacto, paleta `wa-*` preservada). (5) **Microanimações**: stagger 0.04s, whileHover lift, whileTap 0.96 com spring, sticky save bar AnimatePresence. (6) Hook novo `lib/hooks/use-xarlote-status.ts` lê `/admin/prompts` poll 30s. Build limpo (87KB shared, 11 rotas), dev em `npx next dev --port 3003`. |
| 2026-05-08 | **Memória evolutiva + áudio + imagem multimodais** (sessão 18). (1) Migration `0001_memory_pgvector.sql`: extension `vector`, tabela `memory_cards_index` (kind/confidence/source/embedding 1536-d), função SQL `match_user_memory` com decay temporal por kind (fact/affect nunca; episode 90d half-life; preference 180d), coluna `messages.transcript`. (2) **Profile enricher worker** (`apps/api/src/workers/profile-enricher.worker.ts`): consome queue `PROFILE_ENRICHER` post-turn, LLM extratora com confidence ≥ 0.7, popula `user_*` (source='inferred') e `memory_cards_index` com embeddings via OpenRouter `text-embedding-3-small`. (3) **Conversation compactor** cron 1h. (4) **Áudio**: webhook baixa via uazapi `/message/download` com `id` longo (não `messageid` curto) → segue `fileURL` → buffer; transcrição via `gpt-4o-audio-preview` no `/chat/completions` (formato `input_audio`) — OpenRouter NÃO expõe `/audio/transcriptions`, esse foi o caminho que funcionou. (5) **Imagem**: `client.ts` ChatMessage.content vira `string \| ChatContent[]`, helpers `userContentWithImage` + `dataUrl`. Sara enxerga foto direto via canal `image_url`. (6) **Sara prompt** ganha seções "ÁUDIO E IMAGEM — você ENXERGA e OUVE" + "Como usar a memória" (transparência + esquecimento elegante). (7) **Dashboard /prompts** com dropdowns vision_model + audio_model. (8) **Página /users/[id]** com memória agrupada por kind, badges `auto`/`usuário`, confidence bars, lembretes ativos. (9) **Deploy**: workers movidos pra `apps/api/src/workers/` (mesmo processo Node) — concurrently quebrava o healthcheck do Railway, mascarando deploys. (10) Bugs descobertos no caminho: (a) `downloadMedia` usava `messageid` curto e formato `{base64}` — uazapi exige `id` longo e devolve `{fileURL,mimetype}`; (b) `buildConfig` resolvia token via nome real da instância webhook (`VEDACIL-HIAGO`) em vez de `SARA_INSTANCE` ('sara'); (c) `pnpm -r build` no nixpacks tentava buildar o `apps/web` que falha sem env de Supabase em build-time — agora `pnpm --filter '!@iasaude/web' -r build`. |
| 2026-04-19 | Plano completo criado em `docs/PLAN.md` |
| 2026-04-20 | Código MVP completo: todos os packages + apps/api + apps/web. Schema Supabase aplicado. LLM migrado Gemini → OpenRouter. |
| 2026-04-21 | **Fluxo farmácias funcionando end-to-end**: Google Places real (Legacy API), simulador duas abas, Agent prompt reescrito (árvore de decisão → record_quote_price funciona), consolidação automática, Xarlote retorna top-3 com preço/Pix. Geocoding por texto ainda quebrado (API GCP desabilitada). |
| 2026-04-26 | **Geocoding por texto corrigido (sessão 1)**: faltava export no index. **Bug real (sessão 2, validado E2E)**: havia DUAS `geocodeAddress` — uma em `geocoding.ts` (nova, Nominatim) e outra duplicada em `google-places.ts` (antiga, axios). O `export *` de `google-places.js` (que vinha primeiro no index) sobrescrevia a nova. Removida a duplicata. **Adicionado** normalização BR de endereços (R.→Rua, St.→Setor, remove Qd/Lt/Bl/Apto, preserva CEP) com fallbacks (raw → normalizado → CEP isolado → cidade/UF). **Prompt da Xarlote** reforçado com árvore de decisão explícita: ao receber endereço durante cotação, DEVE chamar `start_pharmacy_order` imediatamente (LLM antes chamava `save_user_profile_fact` com payload vazio). **Verificado E2E** com endereço "R. 14, 201 - Qd. B8, Lt. 20 - St. Oeste, Goiânia - GO, 74120-070" → geocodificado → 5 cotações reais criadas. |
| 2026-04-27 (sessão 7) | **UX completa da cotação**: (1) Idempotência: `start_pharmacy_order` re-chamado quando há order ativa não reinicia — só atualiza status. (2) Status incrementais ao usuário: pós-discovery "Achei N farmácias e já contatei", cada quote chegando "Boa, recebi a Nº cotação (X)", 3min nudge, 5min consolidação forçada (substitui cap 10min). (3) `get_order_status` ativo: força consolidação com 1+ cotações, ou avisa "ainda aguardando". (4) Mensagem à farmácia sem emojis, com setor/bairro real do usuário, tom natural pós-preço ("vou confirmar com o cliente e já volto"), pergunta frete se silente (1 ciclo). (5) Política do agent prompt: endereço só setor+rua; produto responde se sabe, senão volta ao usuário. (6) `payment_method` incorporado: Sara pede junto com endereço (3 perguntas em bullets), persistido em `orders.payment_method`, passado à farmácia na abertura e confirmação. Migration aplicada via MCP. |
| 2026-04-27 (sessão 8) | **3 correções**: (1) **Bug confirmação à farmácia**: suppliers criados pelo Google Places não têm `whatsapp_e164`/`phone_e164`, causando skip silencioso do `sendOutboundToSupplier`. Corrigido em `tool-executor.ts` com mesmo fallback de phone fake já usado em `initiatePharmacyNegotiation`. (2) **Botão "Zerar tudo"** no simulador: endpoint `POST /api/simulate/reset-all` deleta todos os dados de teste (todas as tabelas, todos os números); botão vermelho escuro na sidebar do WhatsAppSim. (3) **Nova lógica de timeout/consolidação** em `quote-consolidation.ts`: 3min → se ≥3 cotações consolida, senão silêncio; 5min → se ≥1 cotação consolida, se 0 ativa "modo eager" (`status_5min_done=true`); modo eager → qualquer cotação que chegar dispara consolidação imediata. Remove nudge de "ainda aguardando". |
| 2026-04-26 (sessão 6) | **ViaCEP + extração de logradouro**: descoberto que Nominatim NÃO indexa CEPs BR (testado, retorna `[]`). Adicionado fallback via ViaCEP que resolve CEP → logradouro/bairro/cidade/UF, daí monta queries estruturadas no Nominatim. `extractMainStreet` extrai "Avenida X" / "Rua Y" do texto cru parando em stopwords (esquina/com/qd/lt) — resolve "Avenida Interligação esquina com a rua 5". Cadeia: raw → normalized → ViaCEP×3 → mainStreet+cityState → cityState. Prompt Sara: pedir CEP, e em caso de falha pedir CEP/📍 em vez de variações. |
| 2026-04-26 (sessão 5) | **Geocoding com confiança + persona humana**: (1) `geocoding.ts` agora retorna `confidence: 'precise' \| 'low'`; matches que caem só em cidade/UF (último fallback) viram `low` e o tool-executor pede refinamento ao usuário em vez de buscar farmácias no centro errado. Caso real: "Setor Recanto das Emas, Goiânia" (bairro de outra UF) gerava match em Goiânia-centro. (2) Prompt do agente farmácia (cotação + confirmação) reescrito: Xarlote fala como humana no WhatsApp, proibido mencionar IA/bot/agente/sistema. Mensagens hardcoded em `inbound-supplier.ts` e `tool-executor.ts` reescritas no mesmo tom. |
| 2026-04-26 (sessão 4) | **Localização por pedido + reset**: (1) safety net em `tool-executor.ts` — se `location.address` veio nos args, geocodifica sempre (ignora lat/lng do LLM, que vinha reaproveitando coords do histórico). Lat/lng direto só de `ctx.inbound.location` (botão 📍 atual). (2) Prompt Sara com regra "NÃO REUTILIZE LOCALIZAÇÕES DO HISTÓRICO". (3) Endpoint `POST /simulate/reset { phone }` + botão "Resetar simulação" no WhatsAppSim apaga tudo do número (user/conversas/orders/quotes/perfil). **Migration `orders.delivery_address text` aplicada em prod via MCP Supabase.** |
| 2026-04-29 (sessão 10) | **Deploy Railway**: projeto `ia-da-saude-api` criado, todas as env vars configuradas, nixpacks.toml controla install (pnpm --no-frozen-lockfile) e start (tsx). API em `https://ia-da-saude-api-production.up.railway.app`. Webhook URL para uazapi: `/webhook/uazapi/VEDACIL-HIAGO`. |
| 2026-04-29 (sessão 14) | **Chat manual de farmácia no dashboard** (provisório, enquanto a 2ª instância uazapi não conecta): novo `PharmacyChatDrawer` em `apps/web/components/chat/`. Botão "Responder como farmácia" em cada quote do `/orders/[id]` abre drawer com mensagens realtime (filter por `quotes.conversation_id`) e composer que posta em `POST /api/simulate/pharmacy-reply` → `processInboundSupplier` → LLM responde. `outbound-agent.ts` agora também trata "AGENT_TOKEN ausente" como simulado (só persiste a mensagem). `apps/web/.env.local`: `NEXT_PUBLIC_API_URL` aponta pra Railway. **PROJECT_STATE atualizado**. |
| 2026-04-29 (sessão 13) | **Bug fix CRÍTICO — localização vinha 0,0**: payload real da uazapi tem lat/lng em `message.content.degreesLatitude/Longitude` (formato Baileys), mas `normalize.ts` lia de `message.latitude/longitude` (campos inexistentes) → `?? 0` virava 0,0 → backend respondia "coordenadas inválidas". Corrigido: lê de `content.*` primeiro, fallback pra campos planos; também detecta location via `mediaType === 'location'`. Coords inválidas viram texto sinalizado em vez de buscar farmácia em (0,0). Validado com payload real do banco: `-16.6867, -49.2617` (Goiânia). **Fluxo end-to-end agora 100% operacional** — confirmado E2E via dashboard mostrando 5 quotes geradas a partir da localização real do usuário. |
| 2026-04-29 (sessão 12) | **2 fixes de infra LLM/dashboard**: (1) **Chave OpenRouter renovada** (a antiga retornava 401 "User not found" → toda mensagem caía no fallback "Tive um probleminha"). Modelo trocado pra `deepseek/deepseek-v4-flash` + fallback chain (`models: [primário, gpt-4.1-mini, gpt-4o-mini]`) pra OpenRouter rotear automaticamente em 429 upstream (DeepInfra free tier saturava). Backoff em 429 subiu pra 8s/tentativa. (2) **Dashboard mostrando "Nenhuma conversa"**: anon key do Supabase em `apps/web/.env.local` estava errada (`iat:1755…` vs correta `iat:1775…` — uma troca de dígito). Além disso, RLS policies só permitiam `is_staff()` — adicionadas policies `anon_read_*` em `conversations`/`messages`/`users`/`orders`/`quotes`/`suppliers`/`system_logs` (dashboard é localhost-only). |
| 2026-04-29 (sessão 11) | **uazapi format fix (CRÍTICO)**: a integração uazapi NÃO usa formato Baileys como o código original presumia. Capturado payload real e descoberto: (1) Webhook envia `EventType` (não `event`), `instanceName` (não `instance`), e `message.{text,messageid,sender,fromMe,wasSentByApi,type}` (não `data.key.{remoteJid,id}`/`data.message.conversation`). (2) Endpoint outbound é `/send/text` (não `/message/sendText/{instance}`). (3) Filtra `fromMe`/`wasSentByApi` para não processar echo. **Validado E2E**: webhook simulado → Xarlote respondeu → mensagem persistida + enviada via uazapi (echo recebido). Agora basta o usuário mandar mensagem real. |
| 2026-04-28 (sessão 9) | **Integração real uazapi (instância Sara)**: (1) `.env` atualizado com `UAZAPI_SERVER_URL`, `UAZAPI_SARA_TOKEN`, `WHATSAPP_MODE=uazapi` — mensagens enviadas pelo usuário real chegam via webhook e respostas da Xarlote vão de volta pelo WhatsApp. (2) `client.ts` atualizado: `buildConfig` lê `UAZAPI_${INSTANCE}_INSTANCE` env var para usar o nome real da instância no uazapi (evita hardcoded `'sara'`). (3) `inbound-user.ts`: comando `@teste` detectado antes do LLM — executa reset completo (todos os dados) e confirma ao usuário, equivalente ao botão "Zerar tudo" do simulador. Farmácias continuam simuladas (segunda instância pendente). Webhook URL: `POST /webhook/uazapi/sara`. |
| 2026-04-26 (sessão 3) | **3 ajustes de qualidade no fluxo de cotação**: (1) **Filtro de farmácias** em `google-places.ts` — blocklist por nome (`pet`, `veterinár`, `agropecuári`, `animal`, `ração`, `aquári`) + tipos (`pet_store`, `veterinary_care`), `keyword=farmácia` adicionado ao Nearby Search. Resolve o caso "Pet Ville Premium Pet Shop" aparecendo nos resultados. (2) **Timeout 10min**: novo `scheduleQuoteTimeout` em `quote-consolidation.ts`; ao criar pedido em `tool-executor.ts`, agenda `setTimeout(10min)` que marca quotes não-terminais como `timeout` e força consolidação. (3) **Prompts base visíveis no /prompts** (Opção B, sem breaking change): novo endpoint `GET /admin/prompts/base`; UI mostra prompt base read-only (Sara + agente cotação + agente confirmação) acima do editor de customização. **Bug latente corrigido**: `agent_override` estava no schema desde sempre mas não era aplicado em `inbound-supplier.ts` — ligado nos 2 spots (handler de msgs + opening). |
