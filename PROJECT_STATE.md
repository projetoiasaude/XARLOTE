# PROJECT_STATE.md — IA da Saúde

> Leia sempre este arquivo antes de tocar em qualquer código.

---

## 1. O que é o projeto

**IA da Saúde** — concierge de saúde por WhatsApp.
- **Sara** (persona): conversa com o usuário via WhatsApp
- **Agente** (persona): negocia com farmácias via WhatsApp
- **MVP**: usuário pede medicamento → Sara coleta localização → busca 5 farmácias reais (Google Places) → agente negocia em paralelo → consolida top-3 → envia preço/Pix ao usuário

---

## 2. Estado atual — 2026-04-29

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
| **Chat manual de farmácia no dashboard** | ✅ **NOVO** — botão "Responder como farmácia" em cada quote do `/orders/[id]` (drawer com realtime + composer) |
| Dashboard local | ✅ porta **3002** · aponta `NEXT_PUBLIC_API_URL` pra produção (Railway) |
| Dashboard — anon key Supabase | ✅ Corrigida (estava com `iat:1755…` em vez de `1775…`) + RLS policies `anon_read_*` aplicadas |
| API Railway | ✅ `https://ia-da-saude-api-production.up.railway.app` · health 200 |

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
