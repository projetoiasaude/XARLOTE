# Qualidade de código, testes, observabilidade, build e deploy

> Relatório integral do especialista (auditoria read-only de 21–22/09/2026, base `b981a3d`). Consolidação e priorização cruzada em [`00-CONSOLIDADO.md`](00-CONSOLIDADO.md).

---

# Auditoria de qualidade/plataforma — Xarlote (`fix/auditoria-set` @ `b981a3d`, 22/09/2026)

## 1. Visão geral

O código que está em produção é sólido nos pontos que já doeram (locks por usuário e por cron, dedup de envio, timeout+retry+breaker na LLM, redação de PII com guarda de UUID, auth fail-closed no admin/app, rotas destrutivas trancadas em prod) e a suíte de 2.191 testes puros roda em 6 s sem flaky. O que está frágil é a **plataforma em volta do código**: os 84 commits que rodam em produção existem só neste Mac (nenhum remoto os contém), o CI só roda em `main` (parado em 03/08) e o deploy é `railway up` do working tree — ou seja, nada gateia produção. No produto, achei dois bugs invisíveis no `/prompts` (um toggle apaga os outros overrides; e o service worker nunca lê o arquivo, então o freio de lembretes do dashboard não freia), um padrão sistêmico de escritas no Supabase com erro descartado (~203), webhooks que abrem quando o segredo falta, e o `pnpm dev` do CLAUDE.md apontando workers para o banco de produção. Nas dependências: Next 14 com 2 RCE críticos sem patch na linha 14, e 65 altas das quais a maioria fecha com bumps minor (axios/ws/form-data).

**Placar**

| Item | Resultado |
|---|---|
| `pnpm typecheck` | ✔ 9/9 workspaces (api, web, mobile, core, db, integrations, llm, shared, whatsapp) — 11 s |
| `pnpm lint` | ✘ falha em `apps/web` (`next lint` abre prompt interativo — sem config ESLint); api/packages **não têm lint**; mobile nunca chega a rodar (first-fail) |
| `CI=true pnpm test` | ✔ **2191/2191** em 122 arquivos, **5,8 s** (2 execuções idênticas; 0 skip/todo/only; nenhum teste >5 s — o mais lento é `lab-portal-mock.e2e` 4,5 s/5 testes, pulado se não há Chromium) |
| `pnpm audit --prod` | **3 críticas · 65 altas · 36 moderadas · 3 baixas** (107). Obs.: com o heap padrão o pnpm 9.15.9 morre em OOM; só rodou com `--max-old-space-size=12288` |
| Commits à frente de `main` | **84** (407 arquivos, +67.788/−1.485) · `main` à frente de HEAD: 0 · **HEAD não está em nenhum branch remoto** |
| Lockfile | ✔ em sincronia com os 10 `package.json` (verificado importer a importer) |
| Node | local v24.14 · CI 20 · `engines >=20` · sem `.nvmrc` · prod (nixpacks) não fixado |

---

## 2. Achados

### P0

**1. O código de produção existe só neste Mac** · RISCO/BUILD · `git branch -r --contains HEAD` → vazio; `git branch -vv` → `fix/auditoria-set` sem upstream; commit mais novo no GitHub: `origin/fix/auditoria-04-08` 06/08 e `origin/main` 03/08.
Consequência: 7 semanas de produção (exames v2, cuidador, farmácia 15/09, glm) sem cópia fora do disco; o CI nunca viu nada disso. Correção: `git push -u origin fix/auditoria-set` hoje; PR → `main`. Esforço P · confiança alta.

**2. Next.js 14.2.35 com 2 RCE críticos sem patch na linha 14** · RISCO · `pnpm audit`: `GHSA-p293-qw3h-jr36` e `GHSA-2xp9-vwfh-vxw4` ("Unauthenticated Remote Code Execution", vulnerável `<15.5.24`, patched `>=15.5.24`), +8 altas (DoS, SSRF, middleware bypass) — via `apps/web > next@14.2.35`. `apps/web` serve xarlote.com.br (app, dashboard, página do médico).
Correção: migrar para Next ≥15.5.24 (React 18 é suportado no 15) — o `pnpm outdated` mostra 16.3.5; conferir se a Vercel mitiga na borda enquanto isso. Esforço M/G · confiança alta na vulnerabilidade, média na explorabilidade.

### P1

**3. Um toggle no dashboard apaga todos os outros overrides do `/prompts`** · BUG · `apps/api/src/config/prompts.ts:136-141`:
```ts
export function savePrompts(data: Partial<PromptsConfig>): PromptsConfig {
  const current = loadPrompts();
  const updated = { ...current, ...data };   // data traz 15 chaves === undefined
  writeFileSync(PROMPTS_FILE, JSON.stringify(updated, null, 2), 'utf-8');
```
`routes/admin.ts:324-340` passa `undefined` explícito em toda chave ausente do body; o dashboard manda **uma** chave por toggle (`app/(dash)/prompts/page.tsx:238` `body: JSON.stringify({ xarlote_enabled: next })`, `:263` `{ [key]: next }`). Spread de `undefined` sobrescreve e `JSON.stringify` descarta → o arquivo fica só com a chave tocada (`node -e` reproduz: `{"xarlote_enabled":false}`).
Consequência: Xarlote OFF + toggle de qualquer fluxo → Xarlote **volta a ON em silêncio**; `llm_api_key`, `llm_model`, `sara_suffix`, `vision/audio_model`, `tts_*` revertem para env/defaults. Correção: filtrar `undefined` antes do spread + teste unitário de `savePrompts`. P · alta.

**4. Config e kill-switches do `/prompts` nunca chegam ao service worker** · BUG/OBSERVABILIDADE · `prompts.ts:4` `PROMPTS_FILE = join(__dirname, '../../data/prompts.json')` (disco local do container); `server.ts:71-75` ROLE `api`/`worker` em 2 services (PROJECT_STATE §2 "2 services no Railway"; volume `apps/api/data` ainda "pendência do founder", PROJECT_STATE:29). Quem lê no worker: `reminder-dispatcher.worker.ts:138` (`reminders_enabled`), `nudge-stalled-flows.worker.ts:189`, `open-intent-chaser.worker.ts:240`, `order-followup.worker.ts:176`, `profile-enricher.worker.ts:36` e `conversation-compactor.worker.ts:25` (modelo + API key), `handlers/outbound.ts:140` (TTS).
Consequência: o "freio de emergência" de lembretes do dashboard não freia em produção; só `REMINDERS_ENABLED=false` no env do worker funciona — e ninguém é avisado. Correção: config de runtime em tabela (`runtime_config`, cache 10 s) ou Redis pub/sub; até lá, o dashboard deve avisar que os 4 switches de fluxo só valem no env do worker. M · alta (mecanismo).

**5. Webhooks fail-open sem segredo; rota uazapi legada segue registrada** · RISCO · `routes/webhook.uazapi.ts:28-31`:
```ts
const expectedSecret = process.env['UAZAPI_WEBHOOK_SECRET'];
if (expectedSecret && (...)) return reply.code(401)...   // sem env → aceita tudo
```
mesmo padrão em `webhook.zpro.ts:99-107`; `server.ts:132-133` registra as duas incondicionalmente, embora `/health` diga que as duas pernas são zpro.
Consequência: se `UAZAPI_WEBHOOK_SECRET` não estiver no Railway (provedor abandonado), um POST forjado em `/webhook/uazapi/x` vira turno real da Xarlote → mensagem WhatsApp para o número que o atacante escolher, custo de LLM, conversas poluídas. Correção: em `NODE_ENV=production`, segredo vazio → 503 no boot da rota; registrar `webhookRoute` só se `providerFor(SARA|AGENT) === 'uazapi'`. P · alta (padrão); estado do env desconhecido.

**6. `pnpm dev` (1º comando do CLAUDE.md) sobe workers contra o banco de produção** · RISCO · `.env` local (só nomes/flags, sem valores): `SUPABASE_URL` contém o ref `niqmxiybiwrfkvdfojcq` (prod), `WHATSAPP_MODE=uazapi`, `UAZAPI_SARA_TOKEN` preenchido, `APP_ENV` ausente; `server.ts:71` `ROLE ?? 'all'` → `start-all.ts:66-70` liga `dispatchReminders` a cada 30 s.
Consequência: o dispatcher local faz claim otimista em lembretes reais (`.eq('next_run_at', …)`, `reminder-dispatcher.worker.ts:271-278`) e tenta enviar pela instância uazapi antiga → paciente sem lembrete; enricher/compactor gravam memória a partir da máquina local. Correção: `dev` = `ROLE=api WHATSAPP_MODE=simulator` (como já faz `dev:app`) + trava no boot (`NODE_ENV!=='production' && SUPABASE_URL contém ref de prod && ROLE!=='api'` → recusar). P · alta.

**7. ~203 escritas no Supabase descartam `error` (supabase-js não lança)** · BUG sistêmico · contagem por arquivo: `inbound-user.ts` 23, `routes/simulate.ts` 22, `tool-executor.ts` 21, `admin.ts` 13, `inbound-supplier.ts` 13, `agent-clinic.ts` 13, `tool-executor-v2.ts` 12, `reminder-dispatcher.worker.ts` 8… Caso crítico `red-flag-handler.ts:270-278`:
```ts
try {
  await db.from('red_flag_pending').update({ status: newStatus, user_response: buttonLabel, ... }).eq('id', pending.id);
} catch {}   // PostgREST devolve {error}; o catch nunca dispara
```
Consequência: se o update falhar, a linha segue `pending` e o escalator avisa o contato de emergência **depois** de o paciente dizer "foi engano". O `db` Proxy (`packages/db/src/client.ts:44`) não usa `throwOnError`. Correção: helper `mustWrite()`/`.throwOnError()` começando por red-flag, claim de lembretes e `messages` de saída. M · alta.

**8. Bucket `xarlote-media` (fotos/PDFs de pacientes via WhatsApp) admitidamente público** · RISCO/LGPD · `handlers/media-host.ts:29-34`: "`xarlote-media` foi criado à mão e continua marcado `public` — nunca apareceu em migration nenhuma"; `grep` em `infra/supabase` confirma zero menções; uploads em `inbound-user.ts:1387`, `:1417`, `:1493`. Correção: migration `update storage.buckets set public=false where id='xarlote-media'` (o código já emite signed URL de 10 min). P · média (não verifiquei o flag real — sem chamar prod).

### P2

**9. 65 altas, a maioria com fix barato** · RISCO · axios 1.15.1 (8 altas + 10 moderadas; `packages/integrations` e `packages/whatsapp` pedem `^1.7.0` → `pnpm up axios` para ≥1.16); form-data (transitiva); ws (via `@supabase/supabase-js` 2.104→2.116); `fast-uri` 14 altas via fastify 4 (resolve com `pnpm.overrides`); fastify 4.29.1 EOL (fix só em 5.7.2 → migração v5); playwright 1.49.1→≥1.55.1; @sentry/node. O job `security.yml` (`pnpm audit --audit-level critical`) hoje falharia com 3 críticas — e `pnpm audit` estoura o heap nesta versão do pnpm. M · alta.

**10. Nada gateia produção** · BUILD/DEPLOY · `.github/workflows/ci.yml` e `security.yml`: `on: push/pull_request: branches: [main]`; deploy = `railway up` (PROJECT_STATE:231 "o projeto não tem GitHub conectado ao Railway") do working tree; `RAILWAY_GIT_COMMIT_SHA` (usado como `release` em `observability/sentry.ts:17`) inexistente nesse modo. Correção: workflows em `branches: ['**']`; `scripts/deploy.sh` que recusa working tree sujo e roda `typecheck+test` antes do `railway up`. P · alta.

**11. `railway.toml`: `restartPolicyMaxRetries = 3`** · BUILD/DEPLOY · após 3 crashes seguidos o service fica parado até redeploy manual; sem `healthcheckTimeout`; `/health` é liveness puro (correto), mas o UptimeRobot segue pendente (PROJECT_STATE:29) e o Sentry é `SENTRY_DSN`-gated (também pendente) → crash-loop silencioso. Correção: `restartPolicyMaxRetries = 10`/`always` + monitor externo em `/ready`. P · alta.

**12. Banco 100% sem tipos** · QUALIDADE · `packages/db/src/client.ts:31` `createClient(url, key, {...})` sem generic; `packages/db/src/types.ts` **não existe** (o comando do CLAUDE.md gera para lá) → toda row é `any`; 51 `as unknown as` (12 em `tool-executor.ts`, 9 em `routes/app/reminders.ts`), 39 `any` (14 em `admin.ts`). Erro de nome de coluna só aparece em produção. Correção: `supabase gen types` + `createClient<Database>`, tabelas quentes primeiro. M · alta.

**13. Envios que furam a fila outbound (regra 5)** · RISCO · `inbound-user.ts:556` e `:657` (menu de consentimento), `red-flag-handler.ts:171` (menu) e `:409` (texto ao contato de emergência) chamam `sendMenu/sendText` direto; a fila já suporta `kind:'menu'` (`outbound.queue.ts:327`). Sem rate-limit por instância, sem `sendDedupKey`, sem carimbo de entrega. Correção: `dispatchOutbound({kind:'menu'…})`; red-flag com prioridade. P · alta.

**14. Correlação morre nos crons** · OBSERVABILIDADE · 5 workers disparam WhatsApp sem `traceId`: `consultation-feedback`, `inventory-tracker`, `open-intent-chaser`, `order-followup` (0 ocorrências de `traceId`), `reminder-dispatcher.worker.ts:966` grava `{ traceId: undefined }`. O trace nasce no webhook e chega até `outbound.queue.ts` (14 pontos) — mas só para turnos. Correção: `traceId = randomUUID()` por tick e por lembrete. P · alta.

**15. Cobertura: só funções puras** · TESTES · 99/207 arquivos-fonte importados por algum teste; **0 `vi.mock`**, 0 testes com Redis/Supabase (nem mock), **1** teste HTTP (`erro-upload.test.ts` via `inject`), **0 smoke pós-deploy** em `scripts/`. Sem teste direto: `concurrency/user-lock.ts`, `middleware/cron-lock.ts`, `routes/webhook.zpro.ts`/`webhook.uazapi.ts`, `workers/reminder-dispatcher.worker.ts` (1.088 linhas — só `reminder-guards`/`rrule` puros são testados), `handlers/forget-me.ts` (só `lgpd-plan`), `media-host.ts`, `middleware/auth.ts`/`patient-auth.ts`/`rate-limit.ts`, `red-flag-handler.ts`, `inbound-supplier.ts`, `quote-consolidation.ts`, `workers/lgpd.worker.ts`, `config/prompts.ts`. Correção: `scripts/smoke.ts` (GET `/health`+`/ready`, POST webhook com segredo → `skipped`), `inject` nos 2 webhooks (401/dup/rate-limit), teste do bug 3. M · alta.

**16. `processInboundUserInner` é uma função de 2.413 linhas** · QUALIDADE · `inbound-user.ts:413-2825`: 46 `db.from`, 5 chamadas LLM, 10 envios, 68 `writeLog`, 24 helpers aninhados; `tool-executor.ts` 3.208 linhas / 23 handlers. Ver §4. G · alta.

**17. `tests/` nunca passa pelo `tsc`** · TESTES · nenhum dos 10 tsconfigs inclui `tests/` (comentário em `vitest.config.ts:4` diz que é de propósito); vitest transpila com esbuild. Um tsconfig de rascunho (fora do repo) achou 21 erros — ~7 reais: `tests/adesao-entregue.test.ts:25,95,98` (`'m.content' is possibly 'null'`, `Property 'startsWith' does not exist on type 'string | ChatContent[]'`), `share-grants.test.ts`; o resto é ruído de config (`import.meta`, extensões). Correção: `tsconfig.tests.json` + `tsc --noEmit -p` no CI. P · alta.

### P3

**18. Scripts que mentem/perigosos** · DOCS/RISCO · `scripts/apply-migrations.ts:44` e `apply-migration-file.ts:88` chamam `POST /rest/v1/rpc/exec_sql` — RPC que **não existe** em nenhuma migration (`scripts/prod_rest.py:5` diz o mesmo) → sempre "falham", mas apontam para o `.env` de produção sem confirmação; `prod_rest.py` tem `delete()/patch()` em prod sem `--yes`/dry-run e caminho absoluto `/Users/hiagovieira/…` hardcoded. Correção: apagar os `.ts`; `prod_rest.py` imprime contagem e exige confirmação antes de PATCH/DELETE. P.

**19. Dead code** · QUALIDADE · `packages/core/src/orders/index.ts` (`shouldConsolidate`, `buildConsolidationMessage`, 52 linhas, 0 importadores; `core` inteiro = 26 linhas de LGPD usadas só por `inbound-user.ts:3` → fundir em `shared` e apagar o pacote); `chatWithTools` (`llm/client.ts`); 8 helpers em `db/queries.ts:26-137` (`updateUser, createOrder, updateOrder, getOrderWithQuotes, createQuote, updateQuote, upsertSupplier, findSupplierByWhatsApp`); `setPresence/checkWhatsApp/getInstanceStatus` (`whatsapp/client.ts`); `ADAPTERS` (`lab-portals/registry.ts`). 67 exports do `shared` só usados por testes (seams legítimos — marcar). P.

**20. Legado uazapi/Capacitor** · QUALIDADE · `native/` (119 arquivos, Capacitor jun/2026, fora do workspace pnpm, com `package-lock.json` próprio) superado por `apps/mobile`; `apps/web` ainda depende de 5 `@capacitor/*` + `components/xarlote/CapacitorBridge.tsx`; `site/assets` duplica `apps/web/public` (2 mp4 = 1,1 MB); `packages/whatsapp/src/simulator.ts` é vivo (`isSimulatorMode`), ok. Decisão do fundador. P.

**21. Duplicação web↔mobile e dentro da API** · QUALIDADE · 18 basenames iguais (`use-chat.ts` 208 vs 421 linhas, `OrbNav.tsx` 210 vs 485, `glass-{card,button,badge,input}`, `br-data.ts` vs `br-format.ts`, `texto.ts`, `format.ts`); `apps/web` não importa `@iasaude/shared` (0×; mobile 9×). Proposta: `packages/ui-logic` headless (máquina de estado do chat, formatação BR, `medico/numeros+texto`) — componentes visuais ficam separados (DOM vs RN). Na API: `normalizePhone/isValidPhone/findAppUser` copiados de `routes/app.ts:21-27` para `routes/app/auth.ts:42-48`; `hourBRT` ×2, `check5min` ×2, `loadModels` ×2, `runOnce` ×8 (cron sem abstração). M.

**22. Docs drift** · DOCS · CLAUDE.md: "Sara" 4×; áudio "gpt-4o-audio-preview" vs default `elevenlabs/scribe_v1` (`transcription.ts:44`, `prompts.ts:77`); "modelo padrão gpt-4.1-mini" vs `z-ai/glm-5.2` (`prompts.ts:69`); regra 8 manda atualizar "§11" mas o log é o **§9**; `supabase gen types … > packages/db/src/types.ts` aponta para arquivo inexistente; `pnpm lint` não funciona. PROJECT_STATE.md = 125 KB, §2 intitulado "2026-06-08" com o estado real só nas linhas 190-194 do §9. README.md é de abril ("MVP funcional no simulador", uazapi 9×). `docs/PLAN.md` (83 KB, abril) segue como "documento de verdade #2". `docs/PLANO_XARLOTE_QUE_FUNCIONA.md` (354 KB) não commitado. P.

**23. `loadPrompts()` faz I/O síncrono a cada chamada** · QUALIDADE · `prompts.ts:126-131` (`existsSync+readFileSync+JSON.parse`), 31 call-sites, vários por turno. Cache por mtime. P.

**24. Node 20 EOL** · BUILD · CI `node-version: 20`, `engines >=20.0.0`, sem `.nvmrc`; local 24.14; versão em prod não fixada no `nixpacks.toml`. Correção: `engines`/`.nvmrc` = 22 + `NIXPACKS_NODE_VERSION`. P.

**25. Build do nixpacks emite `dist/` que ninguém usa** · BUILD · `nixpacks.toml` `build = pnpm -r build` (tsc com emit) mas `start = tsx src/server.ts` e todos os packages têm `main: ./src/index.ts`; `apps/api/tsconfig.json` usa `moduleResolution: "Node"` (node10, deprecado; outdated já lista TS 7.0.2). Serve só como gate de tipos — trocar por `tsc --noEmit`. P.

---

## 3. Mapa de cobertura

| Módulo | Testado por | Crítico? | Veredito |
|---|---|---|---|
| `routes/webhook.zpro.ts` / `webhook.uazapi.ts` | — (só `zpro-normalize` puro em `lab-portais`/outros) | **sim** | sem teste de rota (auth, dup, rate-limit, roteamento agent/sara) |
| `concurrency/user-lock.ts` · `middleware/cron-lock.ts` | — | **sim** | sem teste; lógica correta por leitura (SET NX PX + release Lua) |
| `queues/outbound.queue.ts` | `outbound-redis-fallback`, `send-idempotency` | **sim** | parcial (pacing, dedup); envio real não coberto |
| `workers/reminder-dispatcher.worker.ts` (1.088 l) | — (puros: `reminder-guards`, `rrule`, `reminder-body`, `reminder-fadiga`) | **sim** | claim otimista não testado |
| `routes/app/auth.ts` · `lib/otp.ts` · `lib/refresh-token.ts` · `lib/app-jwt.ts` | `otp-verify`, `refresh-rotation`, `app-jwt` | **sim** | libs cobertas; rota (OTP demo, rate) não |
| `middleware/auth.ts` · `patient-auth.ts` · `rate-limit.ts` | — | **sim** | sem teste |
| `handlers/media-host.ts` · `audio-host.ts` | — (`media-sniff` sim) | sim (LGPD) | sem teste |
| `handlers/lab-fetch.ts` · `lib/lab-vault.ts` · `lab-portals/*` | `lab-portais`, `lab-portal-mock.e2e` (Playwright real) | sim | bom (cofre, recusas, e2e falso) |
| `handlers/forget-me.ts` · `workers/lgpd.worker.ts` | — (`lgpd-plan` puro sim) | sim | orquestração não testada |
| `handlers/red-flag-handler.ts` · `red-flag-escalator` | `consent-redflag` (padrões) | **sim** | handler/escalator não |
| `handlers/inbound-user.ts` | 4 (só helpers exportados: `detectContactClaim`, `looksLikeImage`, `blocoDeDocumento…`) | **sim** | mega-função não testável |
| `handlers/tool-executor.ts` / `-v2.ts` | 1 (`autorizouBuscaNoPortal`) / 0 | **sim** | 23 handlers sem teste direto |
| `inbound-supplier.ts`, `quote-consolidation.ts`, `consultation-consolidation.ts`, `outbound.ts` | — / — / — / — (puros em `shared/pharmacy` 123 testes) | sim | orquestração não |
| `config/prompts.ts` | — | sim | bug 3 passaria em silêncio |
| `routes/health.ts` · `server.ts` · `lifecycle.ts` | — | sim | sem teste/sem smoke |
| `packages/shared/src/*` (46 módulos) | 100% dos módulos com teste | — | ✔ é onde vive a lógica |
| `packages/db` (`audit`, `memory`, `redact`) | `audit-actor-type`, `redact` via vários | — | `queries/user360/skills/push-tokens` não |
| `packages/llm/client.ts` | `fallback`/`turnoTemImagem`/`resolveToolName` | sim | chamada real não (ok) |
| Integração (Redis/Supabase reais ou mocks) | **nenhum** | — | — |
| Smoke pós-deploy | **nenhum** (`scripts/` = 2 migradores mortos + `prod_rest.py`) | — | — |

Números: 207 arquivos-fonte em `apps/api/src` + `packages/*/src`; 99 com import direto de teste; 108 sem.

---

## 4. Proposta de modularização (sem mudar comportamento)

### `handlers/tool-executor.ts` (3.208 l) — índice
| Linhas | Bloco | Efeitos |
|---|---|---|
| 50-142 | `MidiaDoTurno`, `ToolContext` (74 l), `ToolResult` | tipos |
| 143-380 | `handleToolCall` — `switch` de 34 tools | db 2 · log 3 |
| 395-492 | `handleSaveProfileFact` | db 9 |
| 493-564 · 611-699 | `handleParsePrescription` · `handleSaveExamResult` | db 3 · send 2 |
| 715-826 | `cancelActiveOrder` · `handleCancelOrder` | db 5 |
| 827-990 | `handleSaveAddress` | db 12 · send 2 |
| 991-1329 | `handleStartPharmacyOrder` | db 5 · **send 9 · log 18** |
| 1330-1852 | consts de env + `enrichPharmacyCandidate`, `topUpIfDeadAir`, `launchNextBackup`, `startPharmacyDiscovery` (299 l) | db 14 · send 3 |
| 1853-2023 | `handleGetOrderStatus` · `handleExpandPharmacySearch` | db 4 · send 3 |
| 2024-2236 | `handleMessageSupplier` | db 4 |
| 2270-2763 | `handleCreateReminder` (286 l) · `handleCancelReminders` (173 l) | db 10 · send 5 · log 17 |
| 2788-3048 | `handleConfirmOrder` · `buildPaymentMessage` | db 4 · send 2 |
| 3070-3179 | `handleFetchLabResults` | db 6 |

Módulos propostos (`handlers/tools/`): `context.ts` (tipos) · `dispatch.ts` (`handleToolCall` vira `Record<ToolName, Handler>` — mesma ordem de `case`) · `profile.ts` · `prescription-exam.ts` · `address.ts` · `pharmacy-order.ts` (start/discovery/topup/expand/status/cancel/confirm+payment) · `supplier-messaging.ts` · `reminders.ts` · `lab.ts` · e os de `-v2` viram `treatment.ts`, `consultation.ts`, `emergency-contact.ts`. Passo mecânico: mover função + imports, `export`, re-export no `tool-executor.ts` atual para não tocar `inbound-user.ts`; testes existentes (`lab-portais` importa `autorizouBuscaNoPortal`) continuam passando.

### `handlers/inbound-user.ts` (2.885 l) — índice de `processInboundUserInner` (413-2825)
| Linhas | Etapa (comentário original) |
|---|---|
| 425-526 | 1-2 find/create user + conversation |
| 527-688 | 5-6 consent flow · forget-me |
| 689-1173 | 7-8 contexto em paralelo (F2.G2), memória, prontidão lab (837-870), guardas de negativo/intenção (1056-1173) |
| 1174-1536 | 9 montagem da mensagem: texto/áudio/imagem/documento/localização + ingestão (1209-1330) |
| 1537-1699 | 10-11 escolha de modelo, chamada LLM, execução de tools |
| 1700-2394 | LOOP AGÊNTICO (ReAct) + rodada de correção do claim-guard (1753) + estado fresco (1972) |
| 2395-2799 | 12 resolução do texto: turno só-tool, "uma voz", mentira sobrevivente (2577), promessa sem tool (2594), honestidade de dose (2695), produto sem prova (2713) |
| 2800-2825 | 13 enricher async + persistência |

Módulos propostos (`handlers/inbound/`): `identify.ts` · `consent.ts` · `context.ts` · `message-builder.ts` · `llm-turn.ts` · `agent-loop.ts` · `response-guards.ts` · `finalize.ts`, costurados por um `TurnState` explícito (hoje são ~60 `let` compartilhados) e um `processInboundUserInner` de ~80 linhas que só chama as etapas na mesma ordem. Helpers já exportados (`detectContactClaim`, `looksLikeImage`, `trechoDeTranscript`) migram para `packages/shared`. Prova de equivalência: gravar a sequência de `writeLog(category)` + tool calls de 5 turnos do simulador antes e depois.

---

## 5. O que verifiquei e está OK

- Locks: `user-lock` (SET NX PX + release compare-and-delete em Lua, fail-open explícito) e `cron-lock` por janela; claim otimista de lembrete (`.eq('next_run_at')`) torna ticks sobrepostos seguros.
- Dedup de envio (`sendDedupKey` por `messageId`/`sendToken`, Redis + fallback local); fila com `attempts: 5`, backoff exponencial.
- LLM: todas as chamadas `fetch` de api/packages têm `AbortSignal`/timeout; retry com backoff e `CircuitBreaker` por tentativa (`llm/client.ts:403-427`); `JSON.parse` 15/15 guardados.
- Redação: `maskString` protege UUID/hex antes de mascarar telefone/CPF/e-mail/coord; pino HTTP com `redact` (4 headers) + máscara de dígitos na URL; `console.*` = 25 (nenhum imprime objeto de paciente).
- Auth: `/admin` e `/app` fail-closed em prod sem token; `requirePatient` fail-closed sempre; OTP fail-closed sem `OTP_PEPPER` (`auth.ts:150,215`); `/api/simulate` 404 em prod; `/admin/reset-dev` trava tripla.
- Sentry inicializado no `main()` (vale para api e worker), `beforeSend` sem PII, `trace_id` como tag; graceful shutdown em ordem (http → flush fornecedor → workers → outbound → redis → sentry); SSE fecha o subscriber Redis no `close`.
- DB com timeout global (`SUPABASE_TIMEOUT_MS`, validado contra NaN/0).
- Repo: `.gitignore` cobre `.env*`, `dist/`, `.next/`, `*.rdb`, `tsbuildinfo`, `prompts.json`; gitleaks configurado; lockfile em sincronia; 0 `@ts-ignore`, 0 `process.exit` fora do boot/lifecycle, 0 TODO/FIXME reais, 0 `.only/.skip`; dependências entre pacotes formam DAG (`core/db/integrations/llm/whatsapp → shared`, sem ciclos); nenhum handler chama `zproCall`/provider direto (fachada respeitada).
- `tsconfig.base.json`: `strict` + `noUncheckedIndexedAccess` + `noImplicitOverride` (sem `exactOptionalPropertyTypes`).

---

## 6. Perguntas em aberto

1. `UAZAPI_WEBHOOK_SECRET` e `ZPRO_WEBHOOK_SECRET` estão setados no Railway? (decide se o achado 5 é P1 ou P0).
2. Existe volume montado em `apps/api/data` no service da API? (sem ele, além do achado 4, cada deploy zera o `/prompts`).
3. O bucket `xarlote-media` está mesmo `public=true` hoje no Supabase?
4. Que Node o nixpacks está usando em produção (log de build)? `engines >=20` deixa a escolha para o builder.
5. As migrations `0008-0010` e `0027` (ausentes em `infra/supabase/migrations`) foram aplicadas via MCP sem arquivo, ou nunca existiram? O `schema.sql` (última mudança 08/07) reflete o banco?
6. O job semanal `security.yml` no GitHub está vermelho? (não tenho `gh` nesta máquina para conferir.)
7. `native/` (Capacitor) e os `@capacitor/*` do `apps/web` podem ser removidos, dado que o app é o Expo?

Arquivos de apoio (só leitura, fora do repo): `/private/tmp/claude-501/-Users-hiagovieira-IA-da-saude/90495a35-56cc-4b5e-af5f-c09ca0e2c7b7/scratchpad/agente-qualidade/` — `typecheck.txt`, `test.txt`, `test.json`, `audit2.txt`, `outdated.txt`, `coverage.txt`, `index-tool.txt`, `index-inbound.txt`, `tests-typecheck.txt`.
