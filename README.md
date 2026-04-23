# XARLOTE — IA da Saúde 💙

> Concierge de saúde por WhatsApp. O usuário fala com a **Xarlote** e ela resolve: entende o medicamento, geolocaliza, negocia em paralelo com farmácias via WhatsApp, consolida cotações e devolve as melhores opções com Pix direto.

---

## O que é este projeto

**IA da Saúde** é um produto de saúde conversacional onde a persona **Xarlote** — uma assistente de IA especialista em farmácia e medicamentos — atua via WhatsApp como concierge de saúde.

O MVP cobre o vertical **farmácia**:
1. Usuário pede um medicamento (texto, áudio ou foto de receita)
2. Xarlote entende, confirma, geolocaliza o usuário
3. Contata várias farmácias próximas em paralelo via WhatsApp (instância "Agente")
4. Consolida as cotações recebidas
5. Apresenta as melhores opções com preço, frete, ETA e método de pagamento
6. Usuário escolhe → Xarlote confirma com a farmácia → envia dados de pagamento (Pix)

**Tudo sem intermediação financeira** — o dinheiro vai direto do usuário para a farmácia.

---

## Estado atual (MVP funcional)

✅ Fluxo completo end-to-end funcionando no simulador  
✅ Xarlote: especialista profunda em farmácia (tarja vermelha/preta, genéricos, marcas, dosagens, interações)  
✅ LGPD via link — qualquer mensagem após ver o link = consentimento  
✅ Receitas controladas: Xarlote NÃO bloqueia, informa que farmácia coleta receita na entrega  
✅ Geocoding por endereço de texto → Nominatim (OpenStreetMap, sem API key)  
✅ Google Places Legacy Nearby Search → farmácias reais  
✅ Agente LLM negocia com farmácias e registra cotações  
✅ Consolidação automática → top-3 apresentadas ao usuário com chave Pix  
✅ Fluxo pós-cotação: usuário escolhe → Xarlote chama `confirm_order_selection` → sistema contata farmácia → envia Pix ao usuário  
✅ Modo de confirmação: farmácia responde → agente usa `record_order_confirmation`  
✅ Simulador duas abas: "Usuário (Xarlote)" + "Farmácias (N)"  
✅ Logs em tempo real no dashboard `/logs`

---

## Arquitetura

```
┌──────────────┐     ┌──────────────────┐     ┌──────────────┐
│   Usuário    │◀───▶│  uazapi          │◀───▶│   Farmácias  │
│  (WhatsApp)  │     │  Instância "sara"│     │  (WhatsApp)  │
└──────────────┘     └────────┬─────────┘     └──────┬───────┘
                              │ webhook               │
                              ▼                       │
                     ┌────────────────┐               │
                     │  Fastify API   │               │
                     │  (apps/api)    │               │
                     └────────┬───────┘               │
                              │                       │
                              ▼                       │
                     ┌────────────────┐               │
                     │  OpenRouter    │               │
                     │  gpt-4.1-mini  │               │
                     └────────┬───────┘               │
                              │                       │
                     ┌────────▼───────┐               │
                     │   Supabase     │               │
                     │  (Postgres +   │               │
                     │   Realtime)    │               │
                     └────────────────┘               │
                                                      │
                     ┌────────────────┐               │
                     │  uazapi        │◀──────────────┘
                     │  Instância     │
                     │  "agent"       │
                     └────────────────┘
```

### Dois números WhatsApp

| Instância | Papel | Conversa com |
|---|---|---|
| `sara` | Xarlote (persona do usuário) | Usuários finais |
| `agent` | Agente de cotação | Farmácias |

---

## Stack

| Camada | Tecnologia |
|---|---|
| **Runtime** | Node.js 20 + TypeScript 5 |
| **API** | Fastify 4 |
| **LLM** | OpenRouter (`openai/gpt-4.1-mini`, configurável sem restart) |
| **Banco** | Supabase (Postgres + Realtime) |
| **WhatsApp** | uazapi (2 instâncias) |
| **Geocoding** | Nominatim (OpenStreetMap) — primário; Google Geocoding — fallback |
| **Farmácias** | Google Places Legacy Nearby Search |
| **Frontend** | Next.js 14 App Router + Tailwind + shadcn/ui |
| **Monorepo** | pnpm workspaces |
| **Deploy** | Railway (api) + Vercel (web) |

---

## Estrutura do repositório

```
ia-da-saude/
├── apps/
│   ├── api/                    # Fastify: webhooks, simulação, handlers
│   │   ├── src/
│   │   │   ├── server.ts
│   │   │   ├── routes/
│   │   │   │   ├── webhook.ts          # POST /webhook/uazapi/:instance
│   │   │   │   ├── simulate.ts         # Rotas do simulador
│   │   │   │   └── logs.ts
│   │   │   ├── handlers/
│   │   │   │   ├── inbound-user.ts     # Fluxo Xarlote ↔ usuário
│   │   │   │   ├── inbound-supplier.ts # Fluxo Agente ↔ farmácia
│   │   │   │   ├── tool-executor.ts    # Executa tool calls da LLM
│   │   │   │   ├── quote-consolidation.ts # Consolida cotações → apresenta top-3
│   │   │   │   ├── outbound.ts         # Envia mensagens ao usuário
│   │   │   │   └── outbound-agent.ts   # Envia mensagens às farmácias
│   │   │   └── config/
│   │   │       └── prompts.ts          # Carrega prompts.json em runtime
│   │   └── data/
│   │       └── prompts.json            # API key, modelo, sufixo de prompt (editável sem restart)
│   │
│   └── web/                    # Next.js dashboard
│       ├── app/
│       │   ├── simulator/      # Simulador WhatsApp (2 abas)
│       │   ├── conversations/  # Conversas em tempo real
│       │   ├── logs/           # Logs do sistema em tempo real
│       │   ├── prompts/        # Configura API key, modelo, prompts
│       │   └── suppliers/      # Gerenciar farmácias
│       └── components/
│           ├── simulator/
│           │   └── WhatsAppSim.tsx  # UI do simulador (usuário + farmácias)
│           └── layout/
│               └── Sidebar.tsx
│
├── packages/
│   ├── shared/                 # Tipos e constantes compartilhadas
│   │   └── src/
│   │       ├── types.ts        # NormalizedInbound, OrderItem, Message, etc.
│   │       └── constants.ts    # ONBOARDING_CONSENT_MESSAGE, SARA_INSTANCE, etc.
│   │
│   ├── db/                     # Cliente Supabase + tipos gerados
│   │   └── src/
│   │       ├── client.ts       # Service role client
│   │       ├── helpers.ts      # findOrCreateConversation, getConversationMessages, etc.
│   │       └── types.ts        # Tipos gerados do Supabase
│   │
│   ├── llm/                    # Wrapper OpenRouter + prompts + tools
│   │   └── src/
│   │       ├── client.ts       # chat() — fetch nativo, OpenAI-compatible
│   │       ├── prompts/
│   │       │   ├── sara.system.ts           # Prompt da Xarlote (especialista farmácia)
│   │       │   └── agent-pharmacy.system.ts # Prompt do Agente (negocia com farmácias)
│   │       ├── tools/
│   │       │   ├── sara-tools.ts            # Tools da Xarlote
│   │       │   └── agent-tools.ts           # Tools do Agente
│   │       └── utils/
│   │           ├── messages-to-history.ts
│   │           └── trim-history.ts
│   │
│   ├── whatsapp/               # Normalização de webhooks uazapi
│   │   └── src/
│   │       ├── normalize.ts    # Payload uazapi → NormalizedInbound
│   │       └── simulate.ts     # buildSimulatedInbound para o simulador
│   │
│   ├── integrations/           # APIs externas
│   │   └── src/
│   │       ├── google-places.ts  # Nearby Search Legacy
│   │       └── geocoding.ts      # Nominatim + Google fallback
│   │
│   └── core/                   # Lógica de negócio pura
│       └── src/
│           └── lgpd/
│               └── consent.ts  # buildConsentEvent, isForgetMeRequest
│
├── infra/
│   └── supabase/
│       └── migrations/         # Arquivos SQL de migração
│
├── docs/
│   └── PLAN.md                 # Plano operacional completo
│
├── CLAUDE.md                   # Instruções para a IA neste projeto
├── PROJECT_STATE.md            # Estado atual, o que funciona, próximos passos
├── pnpm-workspace.yaml
├── tsconfig.base.json
└── .env.example
```

---

## Fluxos principais

### 1. Onboarding LGPD
```
Usuário envia 1ª mensagem
  → Xarlote envia link de privacidade (iadasaude.com/privacidade)
  → Qualquer mensagem seguinte = aceite de consentimento
  → Xarlote pergunta como prefere ser chamado(a)
  → onboarding_status: not_started → consent_pending → profiling → active
```

### 2. Pedido de medicamento
```
Usuário pede remédio (texto/áudio/foto de receita)
  → Xarlote confirma itens, dosagem, quantidade
  → Xarlote pede localização (texto ou pin)
  → Geocoding: endereço → lat/lng
  → Google Places: farmácias num raio de 3-8km
  → Agente contata 3-5 farmácias em paralelo via WhatsApp
  → Farmácias respondem com preço, frete, ETA
  → Consolidação: top-3 apresentadas ao usuário
  → Usuário escolhe → confirm_order_selection
  → Agente confirma com a farmácia escolhida
  → Xarlote envia dados de pagamento (Pix) ao usuário
```

### 3. Negociação com farmácias (Agente)
```
Agente se apresenta como IA da Saúde
  → Pergunta disponibilidade + preço dos itens
  → Coleta: total, frete, ETA, métodos de pagamento, chave Pix
  → Chama record_quote_price → status: quoted
  → Consolidação verifica se já tem 3+ cotações ou timeout
```

---

## Como rodar localmente

### Pré-requisitos
- Node.js 20+
- pnpm 9+
- Conta Supabase com projeto criado
- Conta OpenRouter com API key
- (Opcional) Conta uazapi com 2 instâncias para WhatsApp real

### Setup

```bash
# 1. Instalar dependências
pnpm install

# 2. Variáveis de ambiente
cp .env.example apps/api/.env

# Preencher:
# SUPABASE_URL=
# SUPABASE_SERVICE_ROLE_KEY=
# OPENROUTER_API_KEY=
# OPENROUTER_MODEL=openai/gpt-4.1-mini
# GOOGLE_MAPS_API_KEY=  (opcional, fallback geocoding)
# UAZAPI_SERVER_URL=    (só se usar WhatsApp real)
# UAZAPI_SARA_TOKEN=
# UAZAPI_AGENT_TOKEN=

# 3. Aplicar migrations do banco
npx supabase db push

# 4. Rodar
pnpm --filter api dev    # API na porta :3001
pnpm --filter web dev    # Dashboard na porta :3002
```

### Dashboard
| Rota | O que é |
|---|---|
| `localhost:3002/simulator` | Simulador WhatsApp (aba usuário + aba farmácias) |
| `localhost:3002/conversations` | Conversas em tempo real |
| `localhost:3002/logs` | Logs do sistema em tempo real |
| `localhost:3002/prompts` | Configurar API key, modelo LLM, sufixo de prompt |
| `localhost:3002/suppliers` | Farmácias cadastradas |

---

## Configuração do LLM em runtime

O arquivo `apps/api/data/prompts.json` permite alterar a API key e o modelo **sem reiniciar**:

```json
{
  "llm_api_key": "sk-or-...",
  "llm_model": "openai/gpt-4.1-mini",
  "sara_suffix": "",
  "agent_suffix": ""
}
```

Acesse `localhost:3002/prompts` para editar via interface.

---

## Variáveis de ambiente

```bash
# ─── Supabase ─────────────────────────────────────────
SUPABASE_URL=https://xxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=...
SUPABASE_ANON_KEY=...

# ─── OpenRouter (LLM) ─────────────────────────────────
OPENROUTER_API_KEY=sk-or-...
OPENROUTER_MODEL=openai/gpt-4.1-mini

# ─── Google APIs ──────────────────────────────────────
GOOGLE_MAPS_API_KEY=...    # Places Legacy + Geocoding fallback

# ─── uazapi (WhatsApp) ────────────────────────────────
UAZAPI_SERVER_URL=https://...
UAZAPI_SARA_INSTANCE=sara
UAZAPI_SARA_TOKEN=...
UAZAPI_AGENT_INSTANCE=agent
UAZAPI_AGENT_TOKEN=...
UAZAPI_WEBHOOK_SECRET=...
```

---

## Arquivos críticos

| Arquivo | Função |
|---|---|
| `packages/llm/src/prompts/sara.system.ts` | Prompt da Xarlote — especialista em farmácia |
| `packages/llm/src/prompts/agent-pharmacy.system.ts` | Prompt do Agente — negocia cotações |
| `packages/shared/src/constants.ts` | Mensagem de consentimento LGPD, constantes |
| `apps/api/src/handlers/inbound-user.ts` | Fluxo completo: LGPD → Xarlote → tools |
| `apps/api/src/handlers/inbound-supplier.ts` | Fluxo do Agente com farmácias |
| `apps/api/src/handlers/quote-consolidation.ts` | Consolida cotações + apresenta ao usuário |
| `apps/api/src/handlers/tool-executor.ts` | Executa tools: cotar, confirmar pedido, etc. |

---

## Banco de dados (Supabase)

Tabelas principais:

| Tabela | Função |
|---|---|
| `users` | Usuários finais (pacientes) |
| `conversations` | Threads de conversa (usuário ↔ Xarlote ou Agente ↔ farmácia) |
| `messages` | Todas as mensagens de todas as conversas |
| `orders` | Pedidos de medicamento |
| `quotes` | Cotações por farmácia (uma por order por farmácia) |
| `suppliers` | Farmácias descobertas/cadastradas |
| `consent_events` | Log imutável de consentimento LGPD |
| `system_logs` | Logs de sistema (observabilidade) |
| `user_addresses` | Endereços do usuário |
| `user_medications` | Medicamentos em uso |
| `user_health_conditions` | Condições de saúde declaradas |
| `user_allergies` | Alergias declaradas |

---

## Roadmap (próximos passos)

- [ ] **Deploy Railway + Vercel** — API e dashboard em produção
- [ ] **Integrar uazapi real** — WhatsApp com números reais
- [ ] **OCR de receita** — Gemini Pro para leitura de fotos de receita
- [ ] **Lembretes de medicação** — worker cron + rrule
- [ ] **Perfil 360** — worker que enriquece perfil a partir das conversas
- [ ] **Piloto beta** — 5-10 usuários reais + 3-5 farmácias parceiras
- [ ] **v2: Pagamento intermediado** — Stripe/Asaas
- [ ] **v2: Agendamento de consultas**

---

## Segurança e LGPD

- Consentimento explícito registrado em `consent_events` com evidência (id da mensagem)
- Direito ao esquecimento: `"esquecer meus dados"` → hard delete de todos os dados do usuário
- Dados sensíveis nunca em logs
- Service role Supabase apenas no backend
- Frontend usa Anon key + RLS

---

## Licença

Proprietário — © 2025 IA da Saúde. Todos os direitos reservados.
