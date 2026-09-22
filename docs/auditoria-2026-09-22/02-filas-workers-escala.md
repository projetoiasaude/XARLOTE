# Filas, workers, crons, concorrência, shutdown e escala

> Relatório integral do especialista (auditoria read-only de 21–22/09/2026, base `b981a3d`). Consolidação e priorização cruzada em [`00-CONSOLIDADO.md`](00-CONSOLIDADO.md).

---

# Auditoria READ-ONLY — Filas, workers, crons, concorrência, memória, shutdown e escala

Base: branch `fix/auditoria-set`, HEAD `b981a3d`. Nada foi editado, executado contra produção, nem escrito no Supabase.

## 1. Visão geral

A arquitetura de filas é mais madura que a média: BullMQ com `removeOnComplete/removeOnFail` em todas as filas, `jobId` idempotente onde importa (app-inbound, lab-fetch, LGPD), rate limiter global por número, claim atômico no banco para lembretes/red-flag/lab, cron-lock por janela no Redis, trava de envio único (SET NX + rede local), timeouts em LLM/DB/zpro/push, circuit breaker no OpenRouter e shutdown ordenado com timeout duro. O problema não é ausência de proteções — é que **três delas têm furos exatamente nas costuras entre processos**:

1. **O fallback "Redis piscou → envia direto" duplica mensagens** porque o `queue.add` que "estourou o timeout" NÃO foi cancelado: fica na offline-queue do ioredis e executa quando o Redis volta, num processo diferente (worker) onde a trava local não existe e a chave do Redis nunca foi gravada. É o mecanismo mais plausível dos incidentes de 27/07 e 30/07.
2. **O turno da LLM do WhatsApp roda como `setImmediate` fire-and-forget no processo `api` e o graceful shutdown não o espera** — todo deploy mata o turno em voo; o zpro já recebeu 200, então a mensagem do paciente fica sem resposta. `isShuttingDown()` existe e nunca é usado.
3. **A fila de saída é FIFO sem prioridade e limitada a ~50 msg/min por número** (pensada pro uazapi, mantida no WABA): às 08:00 a resposta a um paciente entra atrás de todos os lembretes. A 100× isso vira 20–40 min de silêncio; o dispatcher de lembretes tem teto de 50/tick e descarta recorrentes com >45 min de atraso, então parte dos lembretes some em silêncio.

Com **2 réplicas**: o service `worker` aguenta (cron-lock + claims atômicos + limiter global); o service `api` **não** — o debounce de fornecedor, o throttle de alerta ao fundador e os timers de consolidação são in-process (o próprio código admite). Observabilidade: o worker parado é invisível (o anomaly-detector mora dentro dele e o `/health` só prova que o HTTP está vivo). Memória: vazamento real de Chromium quando `abrirPortal` estoura o relógio.

## 2. Achados

### P0

**A1 · Redis "pisca" → o MESMO envio sai duas vezes (fallback direto + job atrasado)** · BUG · alta confiança no mecanismo
`apps/api/src/queues/outbound.queue.ts:455-468, 474-509, 177-209`
```ts
const attempt = () => Promise.race([ fn(), new Promise<never>((_, reject) => setTimeout(() => reject(new Error('queue.add timeout…')), 2000)) ]);
try { return await attempt(); } catch { await new Promise((r) => setTimeout(r, 400)); return await attempt(); }
…
} catch (err) {  // dispatchOutbound
  await pacePerInstance(job.instance);
  const outcome = await rawSend(job);   // envio DIRETO
```
`Promise.race` não cancela o `fn()`: os dois `add` ficam na offline-queue do ioredis (`enableOfflineQueue: true`, `RedisOptions.js:43`) e a conexão de *Queue* do BullMQ **não** recebe `maxRetriesPerRequest: null` (só as *blocking* — `redis-connection.js:36-38`; default 20 retentativas com `retryStrategy` de até 20 s ≈ 6 min). Cenário: Redis fora por 3 s–6 min → `claimSend` falha no `SET NX` e cai na trava LOCAL do processo `api` (linha 194-207) → envia direto → o Redis volta → os `add` executam → o **worker** (outro processo, outro `localSentKeys`) faz `SET NX` numa chave que nunca existiu → envia de novo. Lembrete de remédio 2×. O comentário do próprio arquivo (linhas 484-487) descreve as 3 piscadas de 30/07.
**Correção**: (a) conexão dos *produtores* com `enableOfflineQueue: false` (em `getRedisConnection()` só para `Queue`) — o `add` falha na hora em vez de executar depois; (b) `jobId: job.sendToken` no `add` (colapsa as 2 tentativas em 1 job); (c) segunda linha independente do Redis: no processor, antes de `rawSend`, `select delivery_status from messages where id = messageId` e pular se já `delivered` (o fallback já carimba via `stampDelivery`). Esforço M.

**A2 · Deploy mata o turno da LLM em voo — paciente fica mudo, zpro não reenvia** · BUG · alta
`apps/api/src/routes/webhook.zpro.ts:233-240` · `apps/api/src/lifecycle.ts:36-47` · `apps/api/src/server.ts:157-178`
```ts
setImmediate(() => processInboundUser(normalized, traceId).catch(…));
return reply.send({ ok: true });
```
```ts
for (const d of disposers) { await d.fn(); … }
process.exit(0);
```
`app.close()` drena só requests HTTP; o turno (5–75 s, `AGENT_LOOP_BUDGET_MS`) não é rastreado. `isShuttingDown()` (`lifecycle.ts:14`) **não é chamado em lugar nenhum** (`grep`). A perna do fornecedor tem flush (`server.ts:163-165`); a do paciente não. Cenário: deploy às 14:19 com um paciente no meio de um red-flag → a mensagem dele está em `messages`, a resposta nunca sai, o webhook já respondeu 200. Mesmo padrão no `app-inbound` (worker): `worker.close()` espera o job, mas o `SHUTDOWN_TIMEOUT_MS=25 s` (`lifecycle.ts:29`) é menor que o pior turno → `exit(1)` → job stalled → re-execução → `insertMessage` viola `messages_external_idx` → 3 tentativas falham em erro, e o paciente continua sem resposta.
**Correção**: registrar turnos em voo (`Set<Promise>`) e um disposer `await Promise.allSettled(inFlight)` logo após o `http server` (com teto ~20 s); melhor ainda, mover o turno do WhatsApp para a fila `INBOUND_USER` (já existe em `QUEUE_NAMES`, nunca usada) com `jobId = externalId`, como o app já faz — resolve deploy, réplica e retry de uma vez. Esforço M (rastreio) / G (fila).

**A3 · Sem prioridade na fila de saída + teto de 50 msg/min: resposta ao paciente atrás da rajada de lembretes** · RISCO SOB CARGA (hoje P1, a 100× P0) · alta
`apps/api/src/queues/outbound.queue.ts:488, 519-531` · `apps/api/src/handlers/outbound.ts:111` · `apps/api/src/workers/reminder-dispatcher.worker.ts:711, 743`
```ts
await withQueueRetry(() => queueFor(job.instance).add('send', job));   // sem priority, sem jobId
…
{ connection, concurrency: 1, limiter: { max, duration } }  // 1 msg / 1200 ms por número
```
Cenário: N lembretes vencem às 08:00 → a resposta a quem escreve às 08:01 espera N×1,2 s (hoje ~20 s; a 1.000 lembretes, 20 min). Sem TTL no job: se o worker ficar 6 h fora, os jobs enfileirados saem todos quando ele volta ("remédio das 8h" às 14h) — o `STALE_MS` do dispatcher (linhas 156, 284-289) só vale antes de enfileirar. O limite de 1,2 s foi desenhado pro uazapi; no WABA oficial o gargalo da Meta é outro (throughput por segundo muito maior; o que limita é conversa iniciada/24 h).
**Correção**: `priority: 1` para respostas de turno (`sendOutbound`), `priority: 10` para lembretes/nudges/follow-ups; `enqueuedAt` no job e no processor descartar `kind:'text'` de lembrete com idade > 45 min (carimbando `failed`); revisar `WA_RATE_MAX/DURATION` por provedor (zpro pode subir). Esforço P/M.

### P1

**B1 · SSE segura o `app.close()` até o timeout duro → `exit(1)` e os disposers seguintes nunca rodam** · BUG · alta (mecanismo) / média (grace do Railway não confirmado)
`apps/api/src/routes/app/stream.ts:67-113` · `apps/api/src/server.ts:157` · Fastify 4.29.1 `fastify.js:206-208` (`forceCloseConnections` default `'idle'`)
Conexão SSE é *ativa*, não *idle*: `server.close()` espera ela terminar. Com 1 usuário do app conectado, todo deploy leva 25 s, sai com `exit(1)` e **`flush debounce de fornecedor`, `closeOutbound`, `closeRedisClient` não executam** (uma rajada de farmácia em debounce morre). Se o grace do Railway for < 25 s, vem SIGKILL antes.
**Correção**: `Fastify({ forceCloseConnections: true })` ou, no disposer, encerrar as SSE ativas (guardar os `reply.raw` num `Set` e `end()` antes do `app.close()`); confirmar nos logs se "✅ shutdown limpo" aparece em produção. Esforço P.

**B2 · LGPD: uma falha terminal do apagamento bloqueia PARA SEMPRE novos pedidos do mesmo paciente — e a rota responde 202** · SEGURANÇA/BUG · alta
`apps/api/src/queues/lgpd.queue.ts:47-58, 89-101` · BullMQ `addStandardJob-9.lua:90-91` + `handleDuplicatedJob.lua:22-25`
```ts
removeOnFail: false,
…
await getFilaApagar().add('account-forget', job, { jobId: `forget-${job.userId}` });
return true;
```
O BullMQ devolve o job existente (evento `duplicated`) quando a chave `bull:account-forget:forget-<userId>` existe **em qualquer estado, inclusive `failed`**. Como o failed nunca é removido, o segundo "apagar" do paciente é no-op silencioso com 202. (Também vale 30 dias após um sucesso — `removeOnComplete.age` — relevante porque o forget-me ANONIMIZA e o `userId` sobrevive.)
**Correção**: antes do `add`, `const j = await queue.getJob(id); if (j && await j.isFailed()) await j.retry()` (ou `j.remove()` + add); expor no admin o job failed. Esforço P.

**B3 · Vazamento de Chromium quando `abrirPortal` estoura o relógio; linha `rodando` órfã com credencial cifrada** · RISCO SOB CARGA / MEMÓRIA · alta
`apps/api/src/handlers/lab-fetch.ts:307-309, 329, 399, 435-460, 526-537`
```ts
function comRelogio<T>(trabalho, ms, aoEstourar) { return Promise.race([trabalho, new Promise(r => setTimeout(() => r(aoEstourar), ms))]); }
const aberto = await comRelogio(abrirPortal(linha), RECON_TIMEOUT_MS, { ok: false, motivo: 'timeout', adapter: null });
if (!aberto.ok) { …; return; }   // ninguém fecha o browser que abrirPortal ainda vai devolver
```
`abrirPortal` pode levar goto 20 s + networkidle 8 s + segundo goto 20 s + 8 s > `RECON_TIMEOUT_MS` (30 s): o race resolve com timeout e, segundos depois, `abrirPortal` retorna `{ok:true, portal}` com um Chromium aberto que nunca é fechado (os `finally` das linhas 343 e 428 só cobrem o browser já devolvido). Cada caso = um processo de ~150–300 MB no container que também despacha lembretes; `concurrency: 1` não protege disso. Além disso, worker morto no meio de `executarLabFetch` deixa `status='rodando'` (linha 444) para sempre — o varredor só resgata `reconhecendo` — e a credencial só é apagada no `finally` (457).
**Correção**: `comRelogio` recebe um `onLate` que fecha o browser se o trabalho resolver `ok` depois do timeout (ou usar `AbortController` + `browser.close()` no timeout); varredor para `rodando` com `started_at < now - 2×JOB_TIMEOUT` → `falhou` + `apagarCredenciais` + mensagem honesta. Esforço P/M.

**B4 · Worker parado é invisível; uma exceção fora de `try` derruba o processo inteiro; após 3 quedas o Railway para de reiniciar** · QUALIDADE/OBSERVABILIDADE · média-alta
`apps/api/src/routes/health.ts:83-108` · `railway.toml:6-7` · `apps/api/src/workers/consultation-dispatcher.worker.ts:27-45, 160-161` · `appointment-integrity.worker.ts:187-198` · `grep unhandledRejection` = 0 resultados
`/health` do worker só prova que o Fastify está vivo; o único sinal de worker vivo que a API enxerga é `lab_fetch_ready` (heartbeat do lab). O anomaly-detector — quem alertaria — roda **dentro** do worker. `void withCronLock(...)` sem `.catch` em `consultation-dispatcher` (as 4 chamadas antes do `try`, linhas 30-45) e `appointment-integrity`: qualquer `TypeError` vira unhandled rejection → Node 20 encerra o processo. `restartPolicyMaxRetries = 3` (semântica "fica crashed" não confirmada no repo).
**Correção**: heartbeat `worker:reminder:last_tick` (SET EX 120 s) gravado no fim de `dispatchReminders`, exposto no `/health` da API (`worker_alive`) e monitorado externamente (UptimeRobot keyword) — a API não depende do worker pra alertar; `process.on('unhandledRejection', …)` que loga e mantém o processo; `.catch` em todos os `void withCronLock`. Esforço P.

**B5 · Dispatcher de lembretes: teto de 50/tick com ~12–16 round-trips por lembrete, ticks que se sobrepõem e descarte silencioso por atraso** · RISCO SOB CARGA · alta (teto) / média (template duplo)
`reminder-dispatcher.worker.ts:142-148, 156, 271-278, 284-289, 162, 228` · `middleware/cron-lock.ts:41-42, 54-55` · `workers/start-all.ts:66-70`
```ts
.lte('next_run_at', now.toISOString()).order('next_run_at').limit(50);
…
const STALE_MS = 45 * 60_000; // recorrente atrasado > 45min = pula
```
Cada lembrete faz sequencialmente claim, 2–3 counts em `event_log`, lookup de conversa, insert do espelho, update, `lastUserInboundMs`, updates de payload/metadata, push, evento (≈0,5–1,3 s). 50 lembretes ≈ 25–65 s > 30 s do intervalo → a janela seguinte do cron-lock tem OUTRA chave e **começa enquanto a anterior ainda roda** (mesmo processo ou outra réplica). O claim no banco evita envio duplo, mas `templateSentThisTick`/`reengagedThisTick` são por invocação → dois templates pagos pro mesmo paciente no mesmo minuto ficam possíveis. A 100×: 1.000 lembretes às 08:00 levam 10–20 min só pra reclamar; acima de ~2.500, os que passam de 45 min são pulados com um `warn` — dose sumindo em silêncio.
**Correção**: guarda in-process `if (running) return` + heartbeat no lock (SET PX renovado) em vez de janela fixa; paralelizar por usuário (`Promise.allSettled` em lotes de 10 usuários distintos); mover os contadores de cap/fadiga para uma view/RPC única por usuário; quando `due.length === 50`, re-tickar imediatamente em vez de esperar 30 s. Esforço M/G.

**B6 · 2 réplicas do `api` quebram debounce de fornecedor, throttle de alerta e timers de consolidação** · RISCO SOB CARGA · alta (o código diz isso)
`apps/api/src/handlers/inbound-supplier.ts:940-952` ("se algum dia escalar horizontalmente… o double-send volta") · `handlers/founder-alerter.ts:42-49` · `handlers/quote-consolidation.ts:9` · `handlers/consultation-consolidation.ts:37` · `queues/outbound.queue.ts:415` (`lastDirectSendAt` por processo)
Cenário: rajada da farmácia (3 msgs em 8 s) cai em réplicas diferentes → dois turnos, duas respostas. Alertas ao fundador dobram. O `pacePerInstance` do fallback vira 2×/s.
**Correção**: debounce em Redis (`LPUSH` + chave `debounce:<conv>` com TTL; quem faz o `SET NX` da chave dispara o turno) ou pinar o webhook numa réplica só; throttle do alerta com `SET NX EX`. Esforço M.

**B7 · `queue.add` sem timeout em `enqueueAppInbound` e no enricher: Redis fora = request pendurado minutos, não 503** · BUG · alta
`apps/api/src/queues/app-inbound.queue.ts:64-75` (comentário promete 503) · `apps/api/src/handlers/inbound-user.ts:392-394, 2811-2816`
Com a offline-queue e 20 retentativas, o `add` só rejeita após ~6 min; `POST /app/messages` segura a conexão até lá e o turno de WhatsApp (que já respondeu) fica preso no passo 13 segurando o `turn-lock` do paciente (TTL 300 s).
**Correção**: mesma solução de A1 (`enableOfflineQueue: false` nos produtores) ou `Promise.race` com 2 s como em `withQueueRetry` — sem o fallback direto. Esforço P.

### P2

**C1 · One-shot: claim `sent` ANTES de enfileirar → crash entre claim e `dispatchOutbound` perde o aviso de consulta/quimio definitivamente** · BUG · alta
`reminder-dispatcher.worker.ts:267-278` vs `711/743`; `dispatchOutbound` nunca lança (474-510), então o dispatcher não tem como reverter. O resgate (838-865) só existe no ramo `window_blocked`.
**Correção**: estado intermediário `dispatching` + varredor que reverte `dispatching` > 5 min para `pending`. Esforço P.

**C2 · Rate-limit por usuário: `INCR` + `EXPIRE` não atômicos → chave sem TTL = paciente bloqueado até alguém apagar a chave** · BUG · média
`apps/api/src/middleware/rate-limit.ts:28-29, 52-53`. Se o `expire` falhar (piscada entre os dois comandos), `rl:user:<fone>` vive para sempre e a 26ª mensagem da vida do paciente é descartada.
**Correção**: Redis 7 → `EXPIRE key s NX` em toda chamada, ou `SET key 0 EX s NX` antes do `INCR`, ou Lua. Esforço P.

**C3 · Download de mídia sem teto de bytes: documento de 100 MB do WhatsApp entra inteiro na memória da API antes do `MAX_BYTES`** · RISCO SOB CARGA · alta
`packages/whatsapp/src/client.ts:137, 256` (`axios.get … arraybuffer` sem `maxContentLength`) · `apps/api/src/lib/media-sniff.ts:73` (checa depois) · `inbound-user.ts:1379` (`toString('base64')` = +33 %).
**Correção**: `maxContentLength: MAX_BYTES, maxBodyLength: MAX_BYTES` no axios; checar `content-length` antes. Esforço P.

**C4 · Parse de PDF (pdf.js + `inflateSync` de até 32 MB) no event loop do `api`** · OTIMIZAÇÃO · média
`apps/api/src/routes/app/media.ts:198` (dentro do request) · `packages/integrations/src/pdf-leitor.ts:52-80` · `pdf-texto.ts:99` (`MAX_TOTAL_INFLADO = 32 MB`) · `handlers/ingestao-de-exame.ts:209` (no turno do WhatsApp, processo `api`). Um laudo de 12 páginas bloqueia webhooks por 0,5–3 s; um PDF adversarial, dezenas de segundos.
**Correção**: ler o PDF no worker (a rota só sobe o arquivo e enfileira; o `app-inbound` já roda no worker) ou `worker_threads`. Esforço M.

**C5 · Dados clínicos e telefones ficam no Redis por tempo indefinido (jobs completos/falhos)** · SEGURANÇA/LGPD · média
`outbound.queue.ts:73-78` (`removeOnComplete: 1000, removeOnFail: 5000` — até 6.000 jobs com `phoneE164` + `text` da Xarlote) · `handlers/outbound.ts:244` (`audioBase64` dentro do job) · `app-inbound.queue.ts:45-46` (texto do paciente por 1 h/24 h). Não confirmado se o forget-me toca o Redis (`deleteUserMemory` é só banco).
**Correção**: `removeOnComplete: { age: 3600, count: 200 }` no outbound; nunca embutir áudio (subir ao Storage sempre, o caminho `/url` já existe); no forget-me, varrer jobs `failed` do usuário. Esforço P.

**C6 · Rota legada `POST /app/inbound` ainda processa o turno DENTRO do request (75 s)** · RISCO SOB CARGA · alta
`apps/api/src/routes/app.ts:122-154` (`await processInboundUser`), sem `requestTimeout` (default 0). Documentado como "até o F5". Enquanto estiver no ar e público (token no bundle), é a torneira de conexões que a fila `app-inbound` foi criada pra fechar.
**Correção**: 410 na rota legada ou redirecionar para `enqueueAppInbound`. Esforço P.

**C7 · Uma conexão Redis por cliente SSE** · RISCO SOB CARGA · alta
`apps/api/src/routes/app/stream.ts:80-83`. Hoje ~30 conexões nos dois processos (2 por Worker, 1 por Queue, 1 compartilhada); a 100× do app são 2–3 mil conexões só de SSE (limite típico 10 k, mas cada uma custa buffers dos dois lados).
**Correção**: um único subscriber `PSUBSCRIBE app:conv:*` por processo e fan-out em `Map<conversationId, Set<reply>>`. Esforço M.

**C8 · Variáveis obrigatórias não validadas no boot: `REDIS_URL` ausente vira `localhost` em silêncio** · QUALIDADE · alta
`apps/api/src/queue-config.ts:5` · `inbound-user.ts:393` · `stream.ts:80` · `packages/db/src/client.ts:3-7` (`requireEnv` é lazy). Em produção, `REDIS_URL` faltando = nada quebra no boot; envios caem no fallback sem limiter, crons fail-open, trava de duplicata só local — degradação silenciosa exatamente na proteção anti-ban.
**Correção**: `config/env.ts` com Zod validado em `main()` antes do `listen` (`REDIS_URL`, `SUPABASE_*`, `ZPRO_*`, `OPENROUTER_API_KEY` ou `prompts.json`); em `NODE_ENV=production`, `REDIS_URL` obrigatória. Esforço P.

**C9 · Job de saída morto entre a reivindicação e o HTTP: a re-execução é barrada como "duplicado" e a mensagem nunca sai** · BUG · média
`outbound.queue.ts:236-247`: a chave é gravada antes de `sendClaimed`; um SIGKILL (B1/OOM) entre as duas deixa o job stalled → re-run → `'duplicate'` → sem `stampDelivery`, `messages.delivery_status` fica `queued`. Raro, mas indistinguível de entrega.
**Correção**: no ramo `'duplicate'`, consultar `messages.delivery_status`; se ainda `queued`, reenviar (a chave prova apenas *intenção*, não entrega). Esforço P.

### P3

**D1 · Produção roda `tsx src/server.ts`, o `tsc` do build é descartado; `--no-frozen-lockfile`; Node só por `engines >=20`** · QUALIDADE
`apps/api/package.json:9` · `nixpacks.toml:2, 8, 16`. Deploy não reproduzível e transform em runtime.
**Correção**: `start: node dist/server.js`, `--frozen-lockfile`, `.node-version`/`NIXPACKS_NODE_VERSION=20`. Esforço P.

**D2 · `.limit(50000)` em varreduras horárias — PostgREST provavelmente capa em 1.000 linhas (não confirmado) → custo/latência subcontados em silêncio** · QUALIDADE
`anomaly-detector.worker.ts:220` · `metrics-aggregator.worker.ts:100, 124, 162`. Trocar por agregação no banco (RPC `sum/percentile_cont`). Esforço P.

**D3 · `on('failed')` classifica stall terminal como tentativa intermediária** · QUALIDADE
`outbound.queue.ts:537`: job que falha por "stalled more than allowable limit" tem `attemptsMade < attempts` → vira `warn` e não carimba `failed`. Checar `err.message` de stall. Esforço P.

**D4 · Compactor só olha as 50 conversas mais recentes; caches de plataforma sem evicção** · OTIMIZAÇÃO
`conversation-compactor.worker.ts:41-48` (a cauda longa nunca compacta a 100×) · `packages/integrations/src/pharmacy-platforms/rd-adapter.ts:116-134`, `ultrafarma-adapter.ts:115`, `nissei-adapter.ts:196` (TTL só na leitura; entradas nunca saem). Cursor por `last_compacted_at`; `Map` com tamanho máximo. Esforço P.

**D5 · Intervalos sem jitter e alguns sem disposer** · QUALIDADE
`red-flag-escalator.worker.ts:50-56` (sem `stop`, sem `unref`), `consultation-dispatcher`/`anomaly`/`metrics`… têm `stop*` que `start-all.ts:109-114` não chama. Inofensivo hoje (`process.exit`), mas o boot de N réplicas alinha todos os ticks. Esforço P.

## 3. Tabela das filas/workers

| Nome | Tipo | Concorrência | attempts / backoff | removeOnComplete / removeOnFail | cron-lock | Roda em | Risco principal |
|---|---|---|---|---|---|---|---|
| `outbound-whatsapp-sara` | Worker BullMQ | 1 + limiter 1/1,2 s (global) | 5 / exp 2 s | 1000 / 5000 | n/a | worker | A1 dup no blip · A3 sem prioridade/TTL · C5 PII no Redis |
| `outbound-whatsapp-agent` | Worker BullMQ | idem | idem | idem | n/a | worker | idem |
| `profile-enricher` | Worker BullMQ | 2 | 2 / fixed 10 s | {1 h,100} / {24 h,50} | n/a (user-lock) | worker | OK |
| `app-inbound` | Worker BullMQ | 4 | 3 / exp 2 s | {1 h,200} / {24 h,200} | n/a | worker | A2 turno 75 s × shutdown 25 s · B7 add sem timeout |
| `account-forget` | Worker BullMQ | 1 | 5 / exp 10 s | {30 d,500} / **false** | n/a | worker | B2 jobId trava re-pedido |
| `data-export` | Worker BullMQ | 2 | 3 / exp 5 s | {7 d,200} / {30 d,200} | n/a | worker | OK |
| `lab-fetch` | Worker BullMQ | 1, `lockDuration` 90 s | 1 | true / true | n/a | worker | B3 leak Chromium · `rodando` órfão |
| reminder-dispatcher | setInterval 30 s | sequencial, `limit 50` | — | — | S (janela) | worker | B5 teto/sobreposição · C1 one-shot |
| conversation-compactor | setInterval 1 h | seq | — | — | S | worker | D4 top-50 |
| consultation-dispatcher | setInterval 30 s (+45 s boot) | seq | — | — | S | worker | B4 exceção fora do try |
| red-flag-escalator | setInterval 10 s | seq, `limit 20` | — | — | **N** (claim atômico) | worker | D5 sem disposer |
| anomaly-detector | setInterval 10 min | seq | — | — | S | worker | B4 mora no worker · D2 |
| metrics-aggregator | setInterval 1 h | seq | — | — | S | worker | D2 |
| inventory-tracker | 6 h | seq | — | — | S | worker | OK |
| adherence-scorer | 24 h | seq, `limit 5000` | — | — | S | worker | OK |
| consultation-feedback | 1 h | seq | — | — | S | worker | OK |
| appointment-integrity | 20 min | seq | — | — | S | worker | B4 `void` sem catch |
| open-intent-chaser | 1 h | seq | — | — | S | worker | OK (catch interno) |
| knowledge-graph-builder | 6 h | seq | — | — | S | worker | OK |
| skill-extractor | 24 h | seq | — | — | S | worker | OK |
| nudge-stalled-flows | 15 min | seq | — | — | S | worker | OK |
| order-followup | 2 min | seq | — | — | S | worker | OK |
| lab despacho agendadas | setInterval 60 s | seq | — | — | **N** (claim + jobId) | worker | OK |
| lab heartbeat `lab-fetch:ready` | setInterval ~60 s | — | — | — | N | worker | OK |
| debounce de fornecedor | setTimeout 8 s in-process | — | — | — | **N** | api | B6 não sobrevive a réplica; B1 flush pode não rodar |
| timers de consolidação (quote/consulta) | setTimeout in-process | — | — | — | N (resgatado pelo dispatcher) | api | OK por desenho |
| turno WhatsApp (`setImmediate`) | fire-and-forget | turn-lock Redis por fone | 0 | — | — | api | **A2** |

Conexões Redis estimadas: worker ≈ 20 (2 por Worker × 7 + Queues + compartilhada), api ≈ 8 + 1 por cliente SSE.

## 4. O que verifiquei e está OK

- **Jobs longos não viram "stalled" por duração**: o BullMQ renova o lock a cada `lockDuration/2` (`worker.js:64-65`); LLM de 60 s ou Playwright de 3 min só stallam se o event loop travar > 30 s (só C4 faria isso) ou o processo morrer.
- **Limiter é global** (Redis) → 2 réplicas do worker dividem os 50/min, não dobram.
- **Cron-lock** (`cron-lock.ts`) + **claims atômicos no banco** (`reminders` 271-278, `red_flag_pending` 32-40, `lab_fetches` 521-523) → 2 réplicas do worker não duplicam envio.
- **Trava de envio único** com liberação só em 4xx/`success=false` provado (`outbound.queue.ts:259-267`) — desenho correto para stall/retry dentro do mesmo Redis vivo.
- **Timeouts em tudo que sai**: OpenRouter 30 s + 3 retries + breaker (`llm/client.ts:387-431`), Supabase 15 s via `AbortSignal` (`db/client.ts:15-26`), zpro 15 s, mídia 30 s, push 10 s, TTS 30 s, embeddings 12 s.
- **Webhooks respondem 200 depois do INSERT com dedupe** em `webhook_events` (23505) e processam async — reentrega da Meta não duplica turno.
- **Rate-limit é Redis, por telefone (não por IP)**; OTP fail-closed com `rateLimiterBlind`; `trustProxy: true`.
- **`jobId` idempotente** em app-inbound (`clientId`), lab-fetch, LGPD; índice único `messages_external_idx` como segundo cinto.
- **lab-fetch**: guarda de status (`lab-fetch.ts:438`) impede re-digitar senha num re-run stalled; `attempts: 1`; credencial fora do job.
- **rrule** com `Intl` no fuso do usuário e duas passadas para borda de DST (`rrule.ts:164-206`); Brasil sem DST.
- **Retenção**: `system_logs` podado por `pg_cron` (0011/0011b); índices parciais em `reminders(next_run_at)`, `event_log(user_id, occurred_at)`, `messages(conversation_id, created_at)`.
- **Caches in-process bounded**: `localSentKeys` ≤ 5.000, `founder-alerter` poda por 24 h, `recentRelays`/`pharmacyBackups`/`betterQuotePingSeen` podam por tempo.
- **Erros de conexão do BullMQ não derrubam o processo** (`queue-base.js:89-99` engole `emit('error')`); `postgrest-js` devolve `{error}` em vez de lançar em fetch abortado → `void writeLog()` é seguro.
- **Shutdown**: existe, é ordenado, tem timeout duro e o supplier-flush corre antes de fechar filas.

## 5. Perguntas em aberto (não confirmáveis no repo)

1. **`ROLE` real do service `api` hoje** — `outbound.queue.ts:89-91` diz que em 27/07 o `api` rodava `ROLE=all` (dois consumidores). Se ainda for `all`, dobra conexões e crons (o lock cobre), e o fallback local de A1 muda de forma.
2. **Grace period de SIGTERM no Railway** (`RAILWAY_DEPLOYMENT_DRAINING_SECONDS`?) vs `SHUTDOWN_TIMEOUT_MS=25 s`; e se `pnpm run` → `tsx` → `node` realmente repassa o sinal — procurar "🛑 SIGTERM recebido" / "✅ shutdown limpo" nos logs de um deploy.
3. **Redis do Railway**: persistência (AOF/RDB) e `maxmemory-policy`. Sem persistência, um restart do Redis apaga jobs `delayed` (retries em backoff) e `waiting`; com `allkeys-lru`, chaves `bull:*` podem ser evictadas.
4. **Semântica de `restartPolicyMaxRetries = 3`** (o service fica em "crashed" sem reiniciar?) e limite de memória do container do worker (Chromium + Node sem `NODE_OPTIONS`).
5. **`max-rows` do PostgREST** no projeto (default Supabase 1.000) — decide se D2 já mente hoje.
6. **Número de réplicas** hoje (assumi 1+1) e se há intenção real de escalar o `api` (B6 vira bloqueante).
7. **LGPD × Redis**: o forget-me remove jobs com o telefone/texto do paciente (`completed`/`failed` do outbound, `app-inbound`)? Não achei nada que toque o Redis nesse fluxo.
