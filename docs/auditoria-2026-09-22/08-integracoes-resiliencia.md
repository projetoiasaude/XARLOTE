# Integrações externas e resiliência

> Relatório integral do especialista (auditoria read-only de 21–22/09/2026, base `b981a3d`). Consolidação e priorização cruzada em [`00-CONSOLIDADO.md`](00-CONSOLIDADO.md).

---

## Relatório — Auditoria de integrações e confiabilidade (read-only, 21/09/2026, HEAD `b981a3d`)

### 1. Visão geral

Li inteiros `packages/whatsapp/src/*`, `packages/integrations/src/*` (incl. `pharmacy-platforms/*`, `lab-portals/*`), a fila outbound, os dois webhooks, `outbound*.ts`, `lab-fetch.ts`, `ingestao-de-exame.ts`, `template-registry.ts`, alertas, Sentry, `health.ts`, `server.ts`/`lifecycle.ts`, e os call-sites relevantes em `inbound-user.ts`, `red-flag-handler.ts`, `reminder-dispatcher.worker.ts` e `anomaly-detector.worker.ts`. Nada foi editado, nada foi chamado.

O que está bom: **toda** chamada externa tem timeout; a fila outbound tem rate-limit global, trava anti-duplicata com fail-open consciente e fallback direto com espaçamento; webhooks são idempotentes por constraint única; a mídia do paciente passa por allowlist de bytes; o lab-fetch respeita os quatro princípios e prova prontidão. É uma base que já pagou muitos incidentes e registrou o aprendizado no código.

O que não está bom se concentra em **três famílias**: (a) **falha ambígua do zpro (5xx/timeout/rede) vira mensagem perdida em silêncio** — a trava anti-duplicata, correta para o caso "entregou e a resposta não voltou", barra também a retentativa do caso "nunca saiu", o job completa como `duplicate`, o lembrete fica `delivered` otimista e o detector de falhas de envio nem vê (só conta `level=error`); (b) **texto livre fora da janela de 24h em vários caminhos que a perna do estabelecimento já consertou** — o mais grave é o aviso ao contato de emergência, que hoje quase certamente não entrega e ainda diz "avisei"; (c) **o processo que fala com o paciente não é durável nem observado**: o turno do WhatsApp roda em `setImmediate` e morre em todo deploy; o worker morto não gera alerta nenhum, e o alerta primário depende exatamente da integração que ele vigia. Há ainda um zumbi de Chromium possível no lab-fetch e uma linha `rodando` que ninguém resgata.

---

### 2. Achados

#### P0

**#1 — Erro 5xx/timeout/rede do zpro = mensagem perdida em silêncio (e lembrete carimbado `delivered`)** · BUG · `apps/api/src/queues/outbound.queue.ts:236-246, 259-267, 187-192, 527-544`
```ts
// rawSend
if (!(await claimSend(job))) return 'duplicate';          // :236
try { await sendClaimed(job); return 'sent'; }
catch (err) { if (provesNothingWasSent(err)) await releaseSend(job); throw err; }   // :245
// provesNothingWasSent — só 4xx e success=false libertam a trava (:262,:265); 5xx/timeout/ENOTFOUND mantêm
// worker: outcome 'duplicate' → não carimba nada (:527-529); failed não-terminal = 'warn' (:537-541)
```
Cenário concreto: zpro responde `502`/`503` (ou `timeout of 15000ms`, `ECONNREFUSED`, `ENOTFOUND` — `zpro-client.ts:40` e `:68` repropagam cru). Tentativa 1 lança → BullMQ agenda retry (2 s) e emite `failed` **não-terminal = warn**. Tentativa 2 → `claimSend` acha a chave (`SET NX` null, `claimLocal` já marcado) → devolve `'duplicate'` → o processor **completa**. Nada sai, nada é carimbado `failed`, o `messages.delivery_status` fica `queued` (paciente) ou **`delivered`** (lembrete: `reminder-dispatcher.worker.ts:708-713` carimba otimista contando que "o WORKER da fila re-carimba o RESULTADO REAL… um envio que falha (ex.: HTTP 500) ficava 'delivered' mentiroso" — mas nesse caminho o worker nunca re-carimba). O `detectSendFailureSpike` (`anomaly-detector.worker.ts:249-259`) só conta `level='error'` → **nenhum alerta**. Uma queda de 10 min do zpro perde 100% das mensagens do período, inclusive doses de anti-hipertensivo, com o dashboard dizendo entregue. O teste `tests/outbound-redis-fallback.test.ts:36-45` descreve a intenção ("um 500 na 1ª tentativa deixava a chave de pé… retentativa passa") mas só exercita `releaseLocal` isolado; o código de produção não libera em 500.
Correção sugerida (idiomática): (1) `externalKey` **estável por mensagem lógica** — derivar de `sendDedupKey(job)` em vez de `randomUUID()` por chamada (`zpro-client.ts:173,212,236,265,288,350`); confirmar com o zpro se `externalKey` deduplica server-side — se sim, a trava pode ser liberada em **qualquer** erro e a retentativa fica segura por construção; (2) enquanto isso, classificar `ECONNREFUSED`/`ENOTFOUND`/`EAI_AGAIN`/`ECONNRESET antes de request` como "nada saiu" (liberar) e, no ambíguo (5xx/`ECONNABORTED`), **não** devolver `'duplicate'` na retentativa e sim falhar o job terminalmente com `stampDelivery(...,'failed')` + `writeLog('error')` + evento `outbound.ambiguous` para o detector; (3) no dispatcher de lembrete, carimbar `queued` e deixar só o worker escrever `delivered`. Esforço: M (1 dia + testes de `rawSend` com 500/timeout). Confiança: alta (lido linha a linha; comportamento do BullMQ com `attempts` é o padrão).

**#2 — Escalonamento de emergência: aviso ao contato vai como texto livre fora da janela e "avisei" é dito com base no aceite do zpro** · BUG (vida) · `apps/api/src/handlers/red-flag-handler.ts:409, 333-336, 251; :43-45`
```ts
await sendText(SARA_INSTANCE, u.emergency_contact_phone_e164, msg);   // :409 — texto livre, número da Xarlote
// :333 → `Como você não respondeu, avisei ${notified.contactName} agora pelo WhatsApp 💙`
// :251 → `✅ Avisei ${notified.contactName} agora pelo WhatsApp 💙`
```
O contato de emergência, por definição, quase nunca escreveu para a Xarlote nas últimas 24 h → no WABA oficial a Meta **rejeita** texto livre (a própria base documenta isso em `outbound-agent.ts:36-51` e no `template-registry.ts`). Dois desfechos, ambos ruins: se o zpro devolve `success:false`/4xx, `notified.ok=false` (honesto, mas ninguém foi avisado); se o zpro aceita e a Meta recusa depois (a resposta de envio é só aceite — `zpro-client.ts:73-76`: `{ success, data:{ message, ticketId } }`, sem wamid), o paciente lê "avisei fulano" e **ninguém foi avisado**. Não existe template de emergência no registro (`grep` em `template-registry.ts`: só `pharmacy_quote`, `clinic_outreach`, `general`, reengage, OTP). Adicionalmente, os botões `'🚨 Ligar emergência'` (22 bytes) e `'📞 Avisar meu contato'` (23 bytes/21 UTF-16) excedem os 20 do WABA — o fallback para texto "1/2/3" existe (`:176-181`), mas a memória registra que os botões nunca funcionaram e o código segue igual.
Correção: template HSM de utilidade **"contato_emergencia"** ({{1}} nome do contato, {{2}} nome do paciente) com `reengageTemplateEnabled()`-style gate; enviar pela fila com `messageId` e só dizer "avisei" quando o eco `delivered` chegar (o `extractZproDeliverySignal` já existe) — senão "tentei avisar X; se ele não te procurar em 5 min, liga 192"; encurtar botões (`'Ligar 192'`, `'Avisar contato'`, `'Foi engano'`). Esforço: M (template precisa aprovação da Meta). Confiança: alta no defeito; média sobre qual dos dois desfechos ocorre hoje (depende do zpro devolver `success:false` na hora ou não).

#### P1

**#3 — O turno do WhatsApp não é durável: morre em todo deploy, e a retentativa do zpro é descartada como duplicata** · RISCO SOB CARGA/BUG · `apps/api/src/routes/webhook.zpro.ts:111-120, 233-238` · `apps/api/src/lifecycle.ts:36-47` · `apps/api/src/handlers/inbound-user.ts:383-389`
```ts
if (dupError?.code === '23505') return reply.send({ ok: true, skipped: 'duplicate' });   // :118-119, ANTES de processar
setImmediate(() => processInboundUser(normalized, traceId).catch(...));                  // :233 — fire-and-forget
// lifecycle: for (const d of disposers) await d.fn(); … process.exit(0);                 // nada espera turnos em voo
```
Railway manda SIGTERM em cada redeploy (várias vezes por dia neste projeto). O webhook já respondeu 200, o turno (até 75 s de loop agêntico) está em `setImmediate`; o shutdown drena só o HTTP e sai. O turno some; se o zpro reentregar, cai em `skipped: 'duplicate'`. Bônus: o lock de turno no Redis (TTL 300 s) fica preso e a próxima mensagem do paciente espera 150 s (`TURN_LOCK_WAIT_MS`). A migration `0029` prova que "mensagens que só existiam em `webhook_events`" já aconteceram (187). `isShuttingDown()` existe (`lifecycle.ts:14`) e **ninguém usa**.
Correção: o mesmo desenho já pronto para o app — `app-inbound.queue.ts` (job com `jobId = external_event_id`, `attempts: 3`): o webhook só normaliza + enfileira + 200; o worker roda `processInboundUser`. Enquanto isso: contador de turnos em voo e `onShutdown` que espera até N s; devolver 503 quando `isShuttingDown()` para o zpro retentar; marcar `webhook_events.processed_at` e reprocessar os órfãos no boot. Esforço: M. Confiança: alta.

**#4 — Lab-fetch: Chromium zumbi no timeout de `abrirPortal`, linha `rodando` presa para sempre e credencial que sobrevive** · BUG · `apps/api/src/handlers/lab-fetch.ts:307-309, 329, 399, 444-452, 512-541` · `apps/api/src/workers/lab-fetch.worker.ts:74, 82-86` · `apps/api/src/queues/lab-fetch.queue.ts:28`
```ts
function comRelogio<T>(trabalho, ms, aoEstourar) { return Promise.race([trabalho, new Promise(r => setTimeout(() => r(aoEstourar), ms))]); }
const aberto = await comRelogio(abrirPortal(linha), RECON_TIMEOUT_MS, {...});   // :329 e :399
```
Se `abrirPortal` estoura o relógio, a `Promise.race` devolve `timeout` **mas `abrirPortal` continua**, lança o Chromium, resolve `ok:true` mais tarde e ninguém segura o `browser` → processo Chromium órfão no container do worker (o cabeçalho do arquivo diz que isso "é vazamento de memória até o healthcheck derrubar o serviço"). Segundo defeito: `status='rodando'` (`:444`) → entre isso e o `try/finally` há `decifrarCredenciais` e `falar(...)` (`:452`, um `sendOutbound` que faz insert no banco); se o worker morre (SIGTERM com `SHUTDOWN_TIMEOUT_MS=25 s` contra um job de até 120 s; OOM do Chromium) ou `falar` lança, a linha fica `rodando` com `credenciais_cifradas` preenchida; `attempts:1` + `removeOnFail:true` → nunca reexecuta; o despachante só resgata `agendada` vencida e `reconhecendo` >2 min (`:512-541`); `executarLabFetch` recusa `rodando` (`:439`). A pessoa nunca ouve nada e a promessa "credencial apagada em todo desfecho" quebra. Terceiro: `JOB_TIMEOUT_MS` 60 s (abrir) + 60 s (trabalho) > `lockDuration` 90 s → job vira "stalled" com o navegador ainda vivo.
Correção: `comRelogio` recebe um `AbortSignal`/callback de limpeza e, ao estourar, aguarda `abrirPortal` e fecha o browser (ou passa o `browser` por referência para fechar no timeout); `finally` global em `executarLabFetch` que garante `apagarCredenciais` + `status` terminal; despachante trata `rodando` com `started_at < now()-5 min` como `falhou` (apaga credencial, avisa a pessoa com `mensagemDeParada('erro_interno')`); `lockDuration ≥ 150 s`. Esforço: P–M. Confiança: alta.

**#5 — Workers proativos mandam texto livre ao paciente fora da janela de 24 h (a mesma classe do Ciro/Rita de 03/08, agora na perna do paciente)** · BUG · `apps/api/src/workers/consultation-feedback.worker.ts:69` · `inventory-tracker.worker.ts:75` · `order-followup.worker.ts:223` · `nudge-stalled-flows.worker.ts:240` · `open-intent-chaser.worker.ts:152, 226` · `apps/api/src/handlers/outbound.ts:53-113`
```ts
await sendOutbound(row.conversation_id, `+${userPhone}`, msg, crypto.randomUUID());   // feedback 24h DEPOIS da consulta
// depois: preferences: { ...prefs, _feedback_asked_at: … }   → marcado como perguntado
```
`sendOutbound` não conhece janela (só o `reminder-dispatcher` e o `founder-alerter` conhecem). O feedback sai por definição >24 h após a consulta; o rastreio de estoque roda a cada 6 h; o chaser/nudge mira gente que **parou de responder**. A Meta rejeita, o job falha terminal (4xx → `failed`, `error` no log), mas cada worker já gravou a própria flag ("já perguntei") e nunca volta. Regra de ouro 152: mensagem que o paciente nunca recebeu não é conversa.
Correção: extrair de `outbound-agent.ts` um `deliverToPatient()` (janela → texto; fechada → `buildReengageTemplate` com `reengageCooldownElapsed`; senão `window_blocked`) e usar nos cinco workers; só gravar a flag quando o desfecho não for `window_blocked`. Esforço: M. Confiança: alta.

**#6 — Worker morto ou em crash-loop = Xarlote muda, sem nenhum alerta; e o alerta primário depende do zpro que ele vigia** · RISCO · `railway.toml:5-7` · `apps/api/src/server.ts:73, 170` · `apps/api/src/routes/health.ts:83-108` · `apps/api/src/handlers/founder-alerter.ts:177-190` · `telegram-alerter.ts:29-32` · `inbound-user.ts:1584-1590`
```toml
restartPolicyType = "on_failure"
restartPolicyMaxRetries = 3
```
Só o serviço `worker` consome `outbound-whatsapp:*` (ROLE=api não chama `startAllWorkers`). Se ele cai três vezes (OOM de Chromium, por exemplo), o Railway **para de reiniciar**; a API segue 200 no `/health`, `dispatchOutbound` enfileira com sucesso e carimba `queued`, e todas as mensagens ficam no Redis. O `anomaly-detector` roda **dentro do worker** — não pode alertar sobre a própria morte. O `/health` da API não prova worker vivo (só `lab_fetch_ready`, e só com a feature ligada). Quando o alerta existe, o canal primário é WhatsApp via zpro (`sendFounderAlert` → `dispatchOutbound`): zpro 401 (token rotacionado) = falha de envio **e** falha do alerta; o Telegram não tem token (memória 04/08). Faltam detectores para: fila `waiting` crescendo/`active` parado, `queued` há >5 min, OpenRouter 401/402 (o texto ao paciente promete "já estou avisando o time" em `:1584` e ninguém é avisado), modo simulador em produção (`isSimulatorMode()` vira `true` em silêncio se `ZPRO_SARA_TOKEN` sumir — `simulator.ts:52`).
Correção: heartbeat do worker no Redis (`worker:alive`, TTL 90 s) exposto em `/health` da API (`worker_alive`) para o UptimeRobot; detector na **API** (cron leve) para `messages.delivery_status='queued'` com `created_at < now()-5min`; `restartPolicyMaxRetries` maior ou `always`; configurar `TELEGRAM_BOT_TOKEN` (grátis) como canal independente do zpro; alerta em `[AUTH]`/`[SEM CRÉDITO]` do LLM e em `whatsapp_mode=simulator` com `NODE_ENV=production`. Esforço: P–M. Confiança: alta.

**#7 — Bucket `xarlote-media` público com laudos/PDFs, caminho do arquivo logado em `info`, e senha de portal em texto puro no histórico** · SEGURANÇA · `apps/api/src/handlers/media-host.ts:29-34, 39` · `apps/api/src/handlers/inbound-user.ts:1390, 1421` · `packages/db/src/redact.ts:44-72`
```ts
// media-host.ts:29 — "⚠️ FALTA A OUTRA METADE: `xarlote-media` … continua marcado `public`"
await writeLog('info', 'media', `documento do paciente hospedado pra encaminhamento (${hosted.path})`, { traceId });  // :1421
```
Com o bucket público, `inbound/<data>/<uuid>.pdf` é uma URL permanente sem assinatura; o caminho vai para `system_logs` (visível em `/logs`), o que transforma o log em índice de laudos com nome/CPF. O `redactPII` mascara telefone/CPF/e-mail/coordenadas, **não senha**: a mensagem em que o paciente dita login/senha do laboratório fica em `messages.content` e em `webhook_events.raw` (item já no backlog — "senha em texto puro no exame do Glauber").
Correção: migration `update storage.buckets set public=false where id='xarlote-media'` (o código já usa `createSignedUrl`); rebaixar os dois logs para `debug` ou logar só o `uuid`; redigir credenciais no inbound quando a tool `fetch_lab_results` foi chamada no mesmo turno (reusar `redigirCredenciais`). Esforço: P. Confiança: alta (o próprio arquivo afirma o estado do bucket — confirmar no Supabase).

**#8 — Webhook do zpro sem segredo obrigatório: se `ZPRO_WEBHOOK_SECRET` não estiver setado, é SSRF autenticado com o token do zpro** · SEGURANÇA (condicional ao env) · `apps/api/src/routes/webhook.zpro.ts:91-99` · `packages/whatsapp/src/client.ts:313-323, 325-332, 257-262`
```ts
const expectedSecret = process.env['ZPRO_WEBHOOK_SECRET'];
if (expectedSecret) { … 401 … }                           // sem env → rota pública
// client.ts: URL com ?token= → baixa sem checar host (:314); URL não-Meta → 1ª sem auth, em 401/403 repete COM o Bearer do zpro (:260, :330)
```
Um POST forjado com `msg.type:'image'` e `msg.image.url:'https://atacante/x?token=1'` faz o servidor baixar de qualquer host; sem `?token=`, o host do atacante responde 401 e recebe o `ZPRO_SARA_TOKEN` na retentativa. Também alcança `10.x`/`169.254.x` (não há allowlist como em `fetchWebsiteHtml`, `google-places.ts:303-307`).
Correção: `ZPRO_WEBHOOK_SECRET` obrigatório em `NODE_ENV=production` (falhar o boot); allowlist de host em `fetchInboundMedia` (Meta `lookaside.fbsbx.com`/`*.fbcdn.net`, host do `ZPRO_BASE_URL`, host do Supabase) e nunca mandar Bearer para host fora dela. Esforço: P. Confiança: alta no código; desconhecido se o env está setado.

#### P2

**#9 — Download de mídia de entrada sem teto de tamanho (o teto de 10 MB só vale depois de baixar tudo)** · RISCO SOB CARGA · `packages/whatsapp/src/client.ts:255-256` · `apps/api/src/lib/media-sniff.ts:47,73`
```ts
axios.get<ArrayBuffer>(url, { responseType: 'arraybuffer', timeout: 30_000, headers });   // sem maxContentLength
```
Documento de 100 MB (WhatsApp permite) → buffer inteiro na memória + `base64` → OOM do processo da API (que serve os webhooks). Correção: `maxContentLength: MAX_BYTES` (10 MiB) + `HEAD`/`content-length` antes; no lab-fetch, `page.request.get` idem (`lab-fetch.ts:164`). Esforço: P. Confiança: alta.

**#10 — Entrada zpro: vídeo vira silêncio (ou vira "texto" só com a legenda), lote de eventos perde os demais, `externalId` de fallback colide** · BUG/UX · `packages/whatsapp/src/zpro-normalize.ts:93-94, 302-353, 225` · `apps/api/src/routes/webhook.zpro.ts:103`
```ts
text: ['msg.text.body', …, 'msg.video.caption', …]     // legenda do vídeo entra como texto puro
// não há ramo 'video'/'unsupported'/'reaction' → sem legenda cai em `return null` (:353)
const body = Array.isArray(rawBody) ? rawBody[0] : rawBody;   // eventos 2..N descartados
const externalId = pickStr(payload, P.externalId) ?? `zpro-${phoneE164}-${timestamp ?? ''}`;  // sem id e sem timestamp → mesma chave sempre → tudo "duplicate"
```
Vídeo de uma ferida/erupção sem legenda = dead air; com legenda, o modelo responde à legenda sem saber que havia vídeo. Correção: ramo `video` → `contentType:'text'` com `"[O usuário enviou um vídeo (não consigo assistir); legenda: …]"`; `reaction`/`unsupported` → ignorar explicitamente com log `debug`; processar todos os itens do array (ou provar pelo `webhook_events` que o zpro nunca manda array); fallback de id com `randomUUID()` quando não há timestamp. Esforço: P. Confiança: alta.

**#11 — Eco de status `failed`/erro da Meta é descartado: a rejeição assíncrona (janela, número sem WhatsApp, limite de marketing) é invisível** · BUG (observabilidade) · `packages/whatsapp/src/zpro-normalize.ts:148-156, 173-183` · `webhook.zpro.ts:129-145`
`extractZproDeliverySignal` só reconhece `delivered/read/sent`; um eco com `status:'failed'`/`errors[]` cai em `skipped: 'status_echo'` com `describeShape` no log. Como a resposta de envio é só aceite (#2), este eco é a **única** prova de falha real, e hoje ela some. Correção: capturar `status ∈ {failed,error,rejected}` + `errors[0].code/title`, carimbar `delivery_status='failed'` na última outbound do número (mesma atribuição de `stampLastOutboundDelivered`) e `writeLog('error','outbound',…)` para o detector contar. Esforço: P (depende de capturar um eco real). Confiança: média (shape não documentado).

**#12 — Sentry: `beforeSend` não raspa `exception.values[].value`/`extra` (a mensagem de erro do zpro embute o corpo da resposta), sem handler de `unhandledRejection`, `captureError` só em webhooks/enricher** · SEGURANÇA/QUALIDADE · `apps/api/src/observability/sentry.ts:19-32, 41-49` · `packages/whatsapp/src/zpro-client.ts:59-66` · `apps/api/src/server.ts` (sem `process.on`)
`zproCall` lança `zpro /url HTTP 400: ${JSON.stringify(response.data).slice(0,400)}` — o corpo de erro do zpro costuma ecoar `number`; isso vai para o Sentry como `exception.value` sem redação (só as **chaves** do contexto são raspadas). Erros de worker fora de `try/catch` não chegam ao Sentry, e uma rejeição não tratada derruba o processo (Node 20) sem rastro. Correção: no `beforeSend`, passar `redactPII` em `event.message`, `exception.values[].value` e `extra`; `process.on('unhandledRejection'/'uncaughtException')` → `captureError` + log + saída controlada; `captureError` nos `failed` handlers das filas. Esforço: P. Confiança: alta.

**#13 — Geocoding: até 7 chamadas sequenciais ao Nominatim (pior caso ~60 s) dentro do turno, sem cache, com espaçamento por chamada e User-Agent apontando para domínio de terceiro** · OTIMIZAÇÃO/RISCO · `packages/integrations/src/geocoding.ts:32-35, 314-325, 343-372`
```ts
'User-Agent': 'IA-da-Saude/1.0 (contato@iadasaude.com)',   // iadasaude.com hoje é o Radar Materno (regra 118)
await new Promise((r) => setTimeout(r, 1100)); // 1 req/s "anônimo" — por chamada, não global; dois turnos = 2 req/s
```
7 tentativas × 8 s de timeout + 6 × 1,1 s cabem em 62 s — o orçamento do turno é 75 s. Nominatim bloqueia por UA/IP quando passa de 1 req/s e o Railway sai por IP compartilhado; o contato de abuso aponta para uma empresa que não é a nossa. Correção: cache Redis por endereço normalizado (TTL 30 d), teto de 3 tentativas ou 15 s total, limiter global (Redis) de 1 req/s, UA `Xarlote/1.0 (+https://xarlote.ai; suporte@xarlote.com.br)`. Esforço: P. Confiança: alta.

**#14 — Places: `getPlaceContact` ignora `status` do corpo (a mesma classe do bug já consertado em `getPlacePhone`), e Text Search/Reverse/Details ficam fora do circuit breaker** · BUG · `packages/integrations/src/google-places.ts:276-291` vs `:341-352`; `:215-221, :230-239`
Em `OVER_QUERY_LIMIT`/`REQUEST_DENIED` o Details devolve HTTP 200 → `{phone:null, website:null}` em silêncio → farmácia "sem canal" sem ninguém saber (foi o que cegou o fluxo de consulta em 14–15/07; `tool-executor.ts:1390` usa `getPlaceContact`). Correção: mesma checagem de `status` + `console.warn`; envolver as quatro funções em `placesExec`. Esforço: P. Confiança: alta.

**#15 — Perna do fornecedor: foto vai ao modelo de visão sem `sniffMidia` (o endurecimento do incidente Vadivino só existe na perna do paciente)** · BUG · `apps/api/src/handlers/inbound-supplier.ts:1076-1100` vs `inbound-user.ts:1323-1330`
Token do Meta expirado → lookaside responde 200 com HTML → o modelo "vê" e descreve um preço (regra 136: preço sem produto). Correção: `sniffMidia(media.buffer)` antes do `dataUrl`; se `!ok`, devolver `null`. Esforço: P. Confiança: alta.

**#16 — Boot sem validação de env: provider cai em `uazapi` por default, modo simulador liga sozinho, `REDIS_URL` vira `localhost`** · RISCO · `packages/whatsapp/src/provider.ts:30-44` · `simulator.ts:46-53` · `apps/api/src/queue-config.ts:4-6` · `outbound-agent.ts:66-71`
Faltando `WHATSAPP_PROVIDER_AGENT` num serviço, o gate de janela desliga e a mensagem à clínica é **substituída** pelo texto do template (o comentário em `outbound-agent.ts:66-70` descreve exatamente essa armadilha); faltando `ZPRO_SARA_TOKEN`, `isSimulatorMode()` = true e toda saída vira `suppressed` sem alerta; faltando `REDIS_URL`, a trava de duplicata e o rate-limit ficam locais. Correção: `assertProdEnv()` no `main()` com Zod (`SUPABASE_*`, `REDIS_URL`, `ZPRO_BASE_URL/…_API_ID/…_TOKEN/…_META_TOKEN`, `WHATSAPP_PROVIDER_*`, `ZPRO_WEBHOOK_SECRET`, `LGPD_POLICY_URL`) quando `NODE_ENV=production`; `/health` com `simulator` + `NODE_ENV=production` → alerta. Esforço: P. Confiança: alta.

**#17 — Lab-fetch diz "guardei os PDFs no seu perfil mesmo assim" sem checar `arquivoGuardado`** · UX (claim sem prova) · `apps/api/src/handlers/lab-fetch.ts:483` · `ingestao-de-exame.ts:205-206`
`guardarArquivoNoProntuario` devolve `null` em falha de upload/`app_media`; o texto final não olha `r.arquivoGuardado`. Correção: contar `guardados` e adaptar a frase. Esforço: P. Confiança: alta.

**#18 — Abertura fria por template (o passo mais importante da farmácia) não passa `messageId` → nunca tem verdade de entrega no espelho** · QUALIDADE/observabilidade · `apps/api/src/handlers/outbound-agent.ts:357-371, 392-407`
```ts
await db.from('messages').insert({...});        // sem .select('id')
await dispatchOutbound({ kind: 'template', …, text: human, traceId });   // sem messageId
```
É o caso "0/10 farmácias responderam" onde não dá para dizer se o template chegou. Correção: `.select('id').single()` + `messageId` (como `deliverToEstablishment` já faz). Esforço: P. Confiança: alta.

**#19 — TTS: sem retry, sem cache por texto, bucket público sem limpeza (áudio com o nome do paciente, URL eterna)** · OTIMIZAÇÃO/LGPD leve · `packages/integrations/src/tts.ts:114-123` · `apps/api/src/handlers/audio-host.ts:1-4, 23-27`
Só a saudação inicial vai por áudio hoje, então o custo é pequeno; mas `synthesizeSpeech` tem 1 tentativa (um 5xx da ElevenLabs derruba o único momento "uau" do onboarding para texto) e o arquivo fica público para sempre em `tts/<data>/<uuid>.mp3`. Correção: 1 retry em 5xx/timeout; cron mensal apagando `tts/` com >7 d; bucket privado + signed URL (o `/url` do zpro busca na hora, 10 min bastam). Esforço: P. Confiança: alta.

#### P3

**#20 — Envios diretos fora da fila (menu de consentimento) e `kind:'menu'` morto na fila** · QUALIDADE · `apps/api/src/handlers/inbound-user.ts:556, 657` · `outbound.queue.ts:331-338`
Regra #5 do CLAUDE.md; a exceção documentada é só emergência (`outbound.queue.ts:14-15`). Nenhum call-site enfileira `kind:'menu'` (grep vazio) — o ramo da fila é código morto e, se um dia for usado, não tem fallback para texto. Correção: enfileirar o menu com `text` de fallback (como `audio`) e degradar no worker; apagar o ramo ou usá-lo. Esforço: P.

**#21 — Código que mente ou já morreu: `zproGetInstanceStatus`/`zproCheckWhatsApp` devolvem sempre "conectado/existe"; `downloadMedia`/`checkWhatsApp`/`getInstanceStatus`/`setPresence` sem nenhum call-site; uazapi alcançável por default do `providerFor`** · QUALIDADE · `packages/whatsapp/src/zpro-client.ts:364-376` · `client.ts:219-242`
Regra 106 ("código morto que MENTE é pior que código morto"): um futuro `/health` que chame `getInstanceStatus` diria "conectado" com o zpro caído. Correção: remover os exports órfãos; `zproGetInstanceStatus` devolvendo `{connected: null, reason:'not_supported'}`. Esforço: P.

**#22 — Job data com texto do paciente (e `audioBase64`) retido no Redis por contagem, não por idade** · LGPD/QUALIDADE · `outbound.queue.ts:76-77` · `outbound.ts:244`
`removeOnFail: 5000` guarda até 5.000 jobs falhos com conteúdo clínico sem expiração (o `app-inbound.queue.ts:41-44` já faz por idade). Correção: `removeOnComplete: {age: 3600, count: 1000}`, `removeOnFail: {age: 7*86400, count: 1000}`. Esforço: P.

**#23 — Telegram: escape de Markdown V2 num `parse_mode: 'Markdown'` (V1) → barras invertidas visíveis; cap diário de template do fundador em memória, por processo** · QUALIDADE · `telegram-alerter.ts:47, 82-85` · `founder-alerter.ts:48-58`
`Sev: warn` sairia `Sev\: warn`; o teto `FOUNDER_TEMPLATE_DAILY_CAP` zera a cada restart e é contado separadamente pelo `api` e pelo `worker` (efetivo 16/dia, e ilimitado num crash-loop). Correção: `parse_mode:'MarkdownV2'`; contador no Redis (`INCR` + `EXPIRE 86400`). Esforço: P.

**#24 — Ack do webhook espera 1–4 round-trips de banco/Redis antes do 200 (até 15 s no timeout do Supabase); `senderHasActiveEstablishmentNegotiation` roda 3 queries em toda mensagem de paciente** · OTIMIZAÇÃO · `webhook.zpro.ts:111-121, 176-187, 200-231`
Sob lentidão do Postgres, o zpro pode considerar o webhook falho e reentregar (a idempotência cobre, mas dobra a carga justamente no pior momento). Correção: com #3 (fila), o ack passa a ser só `insert webhook_events` + `add`. Esforço: coberto por #3.

---

### 3. Matriz de resiliência

| Integração | Função | Timeout | Retry | Idempotência | Fallback | Alerta | Veredito |
|---|---|---|---|---|---|---|---|
| zpro envio texto/imagem/áudio | `zproCall` via fila outbound | 15 s (`zpro-client.ts:40`) | BullMQ 5×, exp. 2 s; **só 4xx/`success=false` liberam a trava** — 5xx/timeout/rede viram `duplicate` | `SET NX` 15 min por `messageId`/`sendToken` + Set local; `externalKey` novo por chamada | áudio→texto; template→texto (se janela); fila fora→envio direto com pacing | só `level=error` terminal → detector 5/10 min; ambíguo = warn | **P0 #1** |
| zpro template (HSM) | `zproSendTemplate` | 15 s | idem | idem | texto se janela aberta, senão erro acionável | `error` no log + `quemFicouSemReceber` | OK, exceto abertura fria sem `messageId` (#18) |
| zpro botões WABA | `zproSendMenu` (direto, fora da fila) | 15 s | nenhum | nenhuma | texto (`inbound-user`, `red-flag`) | log | OK funcional; labels >20 (#2), fora da fila (#20) |
| zpro entrada (webhook) | `normalizeZproWebhook` | ack após 1–4 I/Os | reentrega do zpro | unique(provider,instance,external_event_id) — **antes** de processar | — | shape não normalizado → warn | **P1 #3**, #10, #11, #24 |
| Mídia Meta (lookaside) | `fetchInboundMedia` | 30 s | 1 retentativa com Bearer em 401/403 | n/a | `sniffMidia` recusa lixo (paciente); "não consegui abrir" honesto | warn/error no turno | #9 (sem teto), #8 (allowlist), #15 (fornecedor sem sniff) |
| uazapi (legado) | `apiCall` | 15 s | nenhum próprio | idem fila | `null` em download | — | alcançável por default (#16/#21) |
| Supabase (PostgREST) | `db` proxy | 15 s (`client.ts` do pacote db) | postgrest-js interno | n/a | erros voltam como `{error}` (verificado no `PostgrestBuilder`) | `/ready` 503 | OK |
| Redis/BullMQ | `queue.add`/limiter/locks | 2 s + 1 retry no `add` | — | `jobId` nas filas app/lab; sendToken no outbound | envio direto com `pacePerInstance` (teto 3 s) | log warn | OK (por processo no fallback) |
| ElevenLabs TTS | `synthesizeSpeech` | 30 s | nenhum | n/a | texto | `tts.failed` evento | #19 |
| ElevenLabs Scribe / OpenRouter áudio / Whisper / Gemini | `transcribeAudio` | 30 s (caller) / 45 s | nenhum, sem cadeia entre provedores | n/a | "[Áudio recebido mas não consegui transcrever]" honesto | error no log | OK-aceitável |
| OpenRouter chat (fora do escopo) | `chat` | 40–60 s | cadeia de fallback + breaker | — | mensagem honesta ao paciente | log `[AUTH]/[SEM CRÉDITO]` **sem alerta** | #6 |
| Google Places Nearby | `findNearby*` | 10 s | breaker 5 falhas/30 s | n/a | `[]` | log | OK |
| Google Details/Text/Reverse | `getPlaceContact` etc. | 5–10 s | sem breaker | n/a | `null` silencioso em `OVER_QUERY_LIMIT` (Contact) | `console.warn` só em `getPlacePhone` | #14 |
| Nominatim / ViaCEP | `geocodeAddress` | 8 s / 5 s por chamada | até 7 tentativas sequenciais | sem cache | `low`/pin | — | #13 |
| VTEX / Nissei / Ultrafarma | `quotePlatformBasket` | 9 s por request + deadlines 12–13 s | 1 retry (VTEX) | cache 30 min em memória | `allSettled`, rede que falha some do pool | 0 redes → log info | OK (falha parcial invisível por rede; aceitável) |
| ZenRows/RD | `quoteRDProduct` | 8–25 s | nenhum | cache | `null` | **desligada** (registry) | OK; conferir `PLATFORM_QUOTE_NETWORKS` |
| FCM push | `sendPush` | 10 s | nenhum | n/a | `sent:0`; tokens mortos apagados | `push_configured` no `/health` | OK (credencial ausente = no-op declarado) |
| Playwright / portais | `lab-fetch.ts` | 20 s nav · 30 s recon · 60 s+60 s job | `attempts:1` (por princípio) | `jobId` por (kind, linha); claim atômico no banco | mensagem honesta por motivo + lembrete de fallback | `error` só se Chromium não abre | **P1 #4**, #17 |
| Telegram | `sendTelegramAlert` | 10 s | nenhum | throttle 60 s/chave | log | — | sem token (#6), #23 |
| WhatsApp do fundador | `sendFounderAlert` | via fila | via fila | throttle + cap 8/dia | template fora da janela | `founder_alert.blocked` | depende do zpro (#6) |
| Sentry | `captureError` | 2 s flush | — | — | no-op sem DSN | — | #12 |
| Supabase Storage | `audio-host`/`media-host`/ingestão | 15 s | nenhum | uuid no path | `null` best-effort | warn | #7, #19 |

---

### 4. O que verifiquei e está OK

- **Timeouts em 100% das chamadas externas** que li (zpro 15 s; mídia 30 s; TTS 30 s; Scribe/áudio 30–45 s; Places 5–10 s; Nominatim 8 s; ViaCEP 5 s; VTEX/adapters com deadline de wall-clock; FCM/Telegram 10 s; Supabase 15 s global com `AbortSignal.any`; Playwright 20/30/60 s; healthchecks 1,5–5 s).
- Fila outbound: rate-limit global por número via `limiter` do BullMQ (`concurrency:1`, 1/1,2 s), trava distribuída + local com fail-open **consciente**, liberação em 4xx e `success=false`, 429 retentado com backoff, fallback direto com espaçamento e teto de espera, bloqueio de número placeholder, `200 {success:false}` tratado como erro, 3 desfechos distintos (`sent/duplicate/not-sent`) sem colapsar o carimbo.
- Webhooks: comparação de segredo em tempo constante; idempotência por constraint única; ecos de status ignorados e usados só como sinal **positivo** (nunca "não tem WhatsApp" por ausência); `webhook_events.raw` passa por `redactPII`; lane de estabelecimento blindada por telefone; interruptor mestre e rate-limit por usuário fail-open.
- Mídia do paciente: allowlist por bytes (`sniffMidia`) antes do modelo de visão, `MAX_BYTES` 10 MiB, mime dos bytes prevalece, hospedagem fora do caminho crítico para foto e **com await** para PDF (porque o bloco afirma "guardado"), URL assinada de 10 min para encaminhar, nome de arquivo sanitizado e nunca em log ≥ info.
- Lab-fetch: os quatro princípios estão no adapter Synapse e no genérico (CAPTCHA antes e depois, 2FA, **um** submit, "campo de senha ainda visível = não entrou", sem retry de senha via `attempts:1`); cofre AES-256-GCM com chave validada; `redigirCredenciais` antes de `assistant_tasks`; `%PDF-` pelos bytes; `concurrency:1`; prontidão provada com fonte + memória do container no log; `rodando`/`na_fila` claim atômico; reconhecimento órfão reenfileirado; browser fechado em `finally` no caminho de `trabalho` (o zumbi é só no `abrirPortal` — #4).
- Templates: contagem de slots validada, variáveis limpas (sem `\n`, teto 900/300), `copyCode` só no OTP, cooldown por dia local para crítico, teto de template por estabelecimento **fail-closed**, cap e throttle no fundador com corpo redigido.
- Places com circuit breaker no Nearby; `fetchWebsiteHtml` com anti-SSRF, limite de 400 KB e content-type; plataformas com `allSettled`, deadlines, dedup por grupo econômico e RD desligada por decisão documentada.
- Boot/shutdown: trava de staging contra banco de produção; ordem de disposers correta (HTTP → flush fornecedor → filas → Redis → Sentry) com killer de 25 s; `helmet`, CORS restrito, redação de headers e telefone na URL no logger; Supabase lazy com erro claro na primeira chamada.

---

### 5. Perguntas em aberto (precisam de você ou do zpro)

1. `ZPRO_WEBHOOK_SECRET` está setado nos dois serviços do Railway? (#8 depende só disso.)
2. O zpro **deduplica** por `externalKey`? Se sim, #1 resolve com uma linha (`externalKey = sendDedupKey(job)`) e a trava pode ser liberada em qualquer erro.
3. O zpro emite eco de status `failed` com o `error.code` da Meta (131047 janela, 131026 sem WhatsApp, 131049 limite)? Um `describeShape` de eco de falha em `system_logs` responde (#11).
4. O zpro manda **array** de eventos em algum caso? (`webhook.zpro.ts:103` só lê o primeiro — #10.)
5. `ZPRO_SARA_META_TOKEN` é token permanente de system user ou token temporário? E a perna `agent` tem `ZPRO_AGENT_META_TOKEN`/`META_WABA_ACCESS_TOKEN`? (Sem ele, áudio/foto de farmácia nunca baixa — `client.ts:268-274`.)
6. `PLATFORM_QUOTE_NETWORKS` em produção contém `drogasil`? O override ignora `enabled:false` (`registry.ts:131-135`) e cada request queima crédito ZenRows num alvo que sempre falha.
7. `xarlote-media` continua `public` no Supabase (o código diz que sim — #7)?
8. `restartPolicyMaxRetries = 3` foi decisão? Com o Chromium no worker, três OOMs seguidos deixam a Xarlote muda até alguém olhar (#6).
9. `TELEGRAM_BOT_TOKEN`/`TELEGRAM_ALERT_CHAT_ID` seguem vazios? É o único canal de alerta independente do zpro.
10. Categoria do `cotacao_medicamento_2` na Meta (Utilidade × Marketing) — já anotado na memória; relevante para o "0/10 farmácias".
