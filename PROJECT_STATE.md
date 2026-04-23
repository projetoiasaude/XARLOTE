# PROJECT_STATE.md — IA da Saúde

> Leia sempre este arquivo antes de tocar em qualquer código.

---

## 1. O que é o projeto

**IA da Saúde** — concierge de saúde por WhatsApp.
- **Sara** (persona): conversa com o usuário via WhatsApp
- **Agente** (persona): negocia com farmácias via WhatsApp
- **MVP**: usuário pede medicamento → Sara coleta localização → busca 5 farmácias reais (Google Places) → agente negocia em paralelo → consolida top-3 → envia preço/Pix ao usuário

---

## 2. Estado atual — 2026-04-21

| Item | Status |
|---|---|
| Fluxo completo farmácia | ✅ **FUNCIONANDO no simulador** |
| Google Places (Legacy Nearby Search) | ✅ **Funcionando** — retorna farmácias reais |
| Google Geocoding API | ❌ **DESABILITADA no GCP** — endereço por texto não funciona |
| Simulador WhatsApp (duas abas) | ✅ Aba "Usuário" + aba "Farmácias" em tempo real |
| Agent LLM — record_quote_price | ✅ **Corrigido** — chama tool imediatamente ao receber preço |
| Consolidação de cotações | ✅ Dispara automaticamente com 3+ quotes ou todos terminais |
| Onboarding + LGPD | ✅ Funcionando |
| Localização via botão (coordenadas) | ✅ Funcionando |
| Localização via texto (endereço digitado) | ❌ **QUEBRADO** — Geocoding API disabled |
| API local | ✅ porta **3001** |
| Dashboard local | ✅ porta **3002** |
| uazapi | ⏳ Não configurado — modo simulator |
| Redis/BullMQ | ⏳ Opcional em dev — processa inline |
| Deploy Railway/Vercel | ⏳ Pendente |

**Próximo passo imediato**: corrigir geocoding via texto usando Nominatim (OpenStreetMap, gratuito, sem API key).

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
| Geolocalização | Google Places Legacy Nearby Search ✅ · Geocoding → migrar para Nominatim |
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
| 2026-04-21 | **Fluxo farmácias funcionando end-to-end**: Google Places real (Legacy API), simulador duas abas, Agent prompt reescrito (árvore de decisão → record_quote_price funciona), consolidação automática, Sara retorna top-3 com preço/Pix. Geocoding por texto ainda quebrado (API GCP desabilitada). |
