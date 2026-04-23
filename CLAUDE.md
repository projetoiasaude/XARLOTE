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
- **API key e modelo** são lidos de `apps/api/data/prompts.json` (runtime, sem reiniciar) ou do `.env` como fallback.
- **`packages/llm/src/client.ts`**: usa `fetch` nativo (sem SDK). Formato de messages: `{role, content}`. Tools: `{type:'function', function:{name, description, parameters}}`.
- **Histórico** (`trim-history.ts`): role `'user'` para msgs in, role `'assistant'` para msgs out (era `'model'` no Gemini).
- Google Gemini API key ainda existe em `.env` como fallback/OCR — mas **não** é mais o LLM principal.

## Dashboard — rotas
- `http://localhost:3002/simulator` — simulador WhatsApp
- `http://localhost:3002/conversations` — conversas em tempo real
- `http://localhost:3002/prompts` — configurar API key, modelo, prompts dos agentes
- `http://localhost:3002/logs` — logs do sistema

## Persona Sara (resumo do tom)
Empática, intimista, concisa (ritmo WhatsApp, 1-3 linhas), PT-BR natural, nunca diagnostica, nunca ajusta dose, confirma antes de agir, orienta SAMU 192 em sinais de emergência.

## Quando em dúvida
Pergunte ao fundador em vez de assumir. Não invente endpoints da uazapi — confirme na documentação oficial. Não invente schema de resposta do OpenRouter — valide com Zod.

## Comandos úteis (após bootstrap)
```bash
pnpm dev              # sobe api + worker + web local
pnpm --filter api dev
pnpm --filter worker dev
pnpm --filter web dev
pnpm test
pnpm lint
pnpm typecheck
npx supabase db push
npx supabase gen types typescript --linked > packages/db/src/types.ts
```

## Estrutura de commits
Convencional: `feat(api): ...`, `fix(worker): ...`, `chore(db): migration 0005`, `docs(plan): ...`.
