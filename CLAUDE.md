# CLAUDE.md — Instruções para IA neste projeto

> Leia **sempre** este arquivo + `PROJECT_STATE.md` antes de tocar em qualquer código.

## Projeto
**IA da Saúde** — concierge de saúde por WhatsApp (persona: Sara). MVP = fluxo de compra de medicamento em farmácia. Backend Node/TS + Fastify + BullMQ + Supabase + **OpenRouter (LLM)**. Frontend Next.js (dashboard dev). WhatsApp via uazapi (2 instâncias).

## Documentos de verdade (nesta ordem)
1. [`PROJECT_STATE.md`](PROJECT_STATE.md) — estado atual, credenciais, roadmap de bootstrap, log de mudanças.
2. [`docs/PLAN.md`](docs/PLAN.md) — plano operacional completo (SQL, prompts, fluxos, arquitetura).

## Regras inegociáveis
1. **Nunca** comite `.env`, tokens, chaves de API, service_role keys, ou qualquer segredo.
2. **Nunca** finja que a Sara é humana se perguntada — transparência é regra de produto.
3. **Nunca** deixe dados sensíveis (telefone, CPF, endereço, lat/lng, Pix, dados clínicos) em logs de nível ≥ info sem `pino-redact`.
4. **Nunca** suba código que chame a LLM (OpenRouter) sem timeout e retry.
5. **Nunca** envie mensagens WhatsApp sem passar pela fila `outbound-whatsapp:*` (rate limit é crítico para evitar ban).
6. **Sempre** use `service role` só no backend; o frontend usa `anon` + RLS.
7. **Sempre** registre tool calls em `assistant_tasks` e eventos de LGPD em `consent_events`.
8. **Sempre** atualize `PROJECT_STATE.md` §11 (log) ao encerrar uma sessão que mudou estado/código.

## Stack travada
Node 20 · TS 5 · Fastify 4 · BullMQ 5 · Redis 7 · **OpenRouter** (modelo padrão: `openai/gpt-4.1-mini`; configurável em `/prompts`) · Supabase · Next.js 14 · pnpm workspaces · Railway (api+worker+redis) · Vercel (web).

## LLM — notas importantes
- **Provider**: OpenRouter (`https://openrouter.ai/api/v1`) — API OpenAI-compatible.
- **API key e modelos** (chat, vision, audio) são lidos de `apps/api/data/prompts.json` (runtime, sem reiniciar) ou do `.env` como fallback.
- **`packages/llm/src/client.ts`**: usa `fetch` nativo (sem SDK). Formato de messages: `{role, content}`. `content` aceita `string | ChatContent[]` (multimodal). Tools: `{type:'function', function:{name, description, parameters}}`.
- **Imagem**: passe via `userContentWithImage(text, [dataUrl])` — protocolo `image_url` do OpenAI. NÃO embuta base64 em string.
- **Áudio**: NÃO existe `/audio/transcriptions` no OpenRouter. Use `gpt-4o-audio-preview` via `/chat/completions` com `input_audio` na content array (`packages/integrations/src/transcription.ts → transcribeWithChatAudio`). Whisper só funciona via OpenAI direta (`OPENAI_API_KEY` separada).
- **Embeddings**: `openai/text-embedding-3-small` (1536-d) via `packages/llm/src/embeddings.ts` — usado pelo enricher e pelo retrieval.
- **Histórico** (`trim-history.ts`): role `'user'` para msgs in, role `'assistant'` para msgs out (era `'model'` no Gemini).
- Google Gemini API key ainda existe em `.env` como fallback opcional pra áudio/visão (`gemini/...` em audio_model).

## Memória persistente — princípios
- **Fonte canônica** dos memory cards: `conversations.memory_cards` JSONB (LGPD/portabilidade).
- **Espelho indexado**: `memory_cards_index` com embedding `vector(1536)`, função SQL `match_user_memory(user_id, query_emb, k, min_sim)`. Decay temporal: `fact`/`affect` nunca decai; `episode` 90d half-life; `preference` 180d.
- **Profile enricher** (`apps/api/src/workers/profile-enricher.worker.ts`) é a ÚNICA via que escreve memória. Roda async post-turn via queue `PROFILE_ENRICHER`. Confidence ≥ 0.7. Marca `source='inferred'` (vs `'self_reported'` quando o user dita explicitamente).
- **Sara**: usa cards recuperados (top-K) no system prompt, agrupados por kind. Quando memória influencia ação, fala em voz alta (*"Lembrei que você é alérgico a dipirona…"*). Se confidence baixa, pergunta antes de assumir.
- **Forget-me**: cascata via FK `on delete cascade` no `memory_cards_index` + `deleteUserMemory()` chamada no fluxo CONFIRMO APAGAR.

## WhatsApp — DUAL-PROVIDER (sara=zpro/oficial, agent=uazapi)
- **Fachada única**: `packages/whatsapp/src/client.ts` exporta `sendText/sendMenu/sendImage/sendAudio/fetchInboundMedia/...` e despacha por **provider** (`provider.ts` → `providerFor(instance)`). Decisão por env `WHATSAPP_PROVIDER_<INSTANCE>` (`zpro`|`uazapi`); auto-detecta quando vazio. **Nunca** chame um provider direto fora do client — use a fachada (mantém os call-sites agnósticos).
- **zpro (API Business oficial)** — leg `sara` (Xarlote). Contrato de SAÍDA confirmado (OpenAPI oficial): base `POST {ZPRO_BASE_URL}/v2/api/external/{ZPRO_<I>_API_ID}` + suffixes `/url`, `/base64`, `/voice`, `/sendButtonWABA`; auth `Authorization: Bearer`; número só-dígitos com DDI. **Botões WABA exigem `ticketId`** (vem do webhook de entrada → flui via `NormalizedInbound.providerTicketId` → `sendMenu`). Voz só por URL (`/voice`); Buffer cai pra `/base64`.
- **zpro ENTRADA é NÃO-DOCUMENTADA**: `zpro-normalize.ts` é tolerante/provisório (tenta N chaves candidatas). A rota `webhook.zpro.ts` captura o payload redatado em `webhook_events`/system_logs — **finalize o parser contra o payload real capturado**, não invente o shape.
- **Mídia recebida**: use `fetchInboundMedia(inbound, SARA_INSTANCE)` (agnóstico). zpro = a `inbound.mediaUrl` é uma URL do Meta (`lookaside.fbsbx.com`) PROTEGIDA → exige `ZPRO_SARA_META_TOKEN` (token do WhatsApp Business) como Bearer; uazapi = `/message/download` com o **`id` LONGO** (`556298345024:3A...`, não o `messageid` curto). Sempre passe `SARA_INSTANCE` como chave de config (não o nome cru da instância do webhook, ex. `VEDACIL-HIAGO`).
- **zpro GOTCHAS (aprendidos ao vivo, NÃO re-tropeçar):** (1) **`externalKey` é OBRIGATÓRIO** em todo envio (randomUUID/envio) — sem ele 400. (2) `/url` exige **`body` não-vazio** (mande `' '`) — 400 "body is a required field". (3) **`/voice` NÃO funciona no WABA** (`ERR_CHANNEL_NOT_SUPPORTED`) — áudio de saída vai por `/url` com URL pública. (4) `zproCall` trata `200 {success:false}` como erro (senão falha em silêncio). (5) shape de entrada: `msg.text.body`/`msg.id`/`ticket.id` (ver `zpro-normalize.ts`).
- **Áudio de SAÍDA (voice note)**: TTS ElevenLabs em **MP3** hospedado no Supabase Storage (bucket `xarlote-audio`) e enviado por `/url`. **PTT-waveform (bolinha-microfone) NÃO é entregável via zpro no WABA** (precisa `voice:true` que o zpro não expõe) — fica como áudio tocável. Fallback p/ texto se o envio falhar.

## Dashboard — rotas
- **Prod:** https://web-jade-ten-53.vercel.app — **exige LOGIN** (senha em `DASHBOARD_PASSWORD` no Vercel). O token de admin NÃO fica no bundle; só é entregue pós-login via `/api/auth/token` (cookie httpOnly assinado). `AdminAuthGate` injeta `x-admin-token`. `/app` (cliente) segue público. Deploy web = `npx vercel --prod --yes` de `apps/web` (7 env vars de projeto no Vercel). Local: `http://localhost:3002`.
- `http://localhost:3002/simulator` — simulador WhatsApp
- `http://localhost:3002/conversations` — conversas em tempo real
- `http://localhost:3002/prompts` — interruptor on/off + API key + modelo chat + modelo visão + modelo áudio + prompts dos agentes
- `http://localhost:3002/users` + `/users/[id]` — perfil 360 com memória agrupada por kind, lembretes, badges de origem
- `http://localhost:3002/logs` — logs do sistema

## Dashboard — design (Liquid Glass)
- Dark mode only. Background com 3 orbs animados azul+roxo+pink (`components/layout/AmbientBackground.tsx`).
- Tokens: `ink-base`, `accent`, `aurora-blue/purple/pink` em `tailwind.config.ts`.
- Utilities: `.glass`, `.glass-spec` (specular highlight), `.glass-hi`, `.glass-lo` em `globals.css`.
- 12 primitivos drop-in em `components/ui/` (GlassCard, GlassButton, GlassBadge, Tabs com layoutId, Drawer, Avatar, etc) — **use sempre** em vez de `bg-wa-panel border ...`.
- Animações com `framer-motion@11` — spring physics em hover/tap, stagger 0.04s em listas, page transition fade-up no `template.tsx`.
- Respeita `prefers-reduced-transparency` (cai pra opaco) e `prefers-reduced-motion` (para animações).
- Paleta `wa-*` legacy mantida só pra `WhatsAppSim.tsx` (944 linhas, não refatorado nessa sprint).

## Persona Sara (resumo do tom)
Empática, intimista, concisa (ritmo WhatsApp, 1-3 linhas), PT-BR natural, nunca diagnostica, nunca ajusta dose, confirma antes de agir, orienta SAMU 192 em sinais de emergência.

## Quando em dúvida
Pergunte ao fundador em vez de assumir. Não invente endpoints da uazapi — confirme na documentação oficial. Não invente schema de resposta do OpenRouter — valide com Zod.

## Comandos úteis (após bootstrap)
```bash
pnpm dev              # sobe api (ROLE=all: HTTP + workers) + web local
pnpm --filter api dev # só a API (ROLE=all por padrão = HTTP + workers no mesmo processo)
pnpm dev:worker       # API em ROLE=worker (só os workers, porta 3010) — testar a separação F1.A1
pnpm --filter web dev
pnpm test
pnpm lint
pnpm typecheck
npx supabase db push
npx supabase gen types typescript --linked > packages/db/src/types.ts
```

## Estrutura de commits
Convencional: `feat(api): ...`, `fix(worker): ...`, `chore(db): migration 0005`, `docs(plan): ...`.
