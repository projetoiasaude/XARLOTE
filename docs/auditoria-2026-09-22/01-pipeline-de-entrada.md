# Pipeline de entrada (webhook → handler → LLM → tools → resposta)

> Relatório integral do especialista (auditoria read-only de 21–22/09/2026, base `b981a3d`). Consolidação e priorização cruzada em [`00-CONSOLIDADO.md`](00-CONSOLIDADO.md).

---

# Auditoria read-only — Pipeline de entrada do paciente (webhook → normalização → handler → LLM → tools → resposta)

Base: branch `fix/auditoria-set`, HEAD `b981a3d`. Tudo abaixo foi lido no código; onde eu executei algo, foi só um probe em `/private/tmp/.../scratchpad/agente-pipeline/` (compilando `pharmacy.ts` pra fora do repo). Nada foi editado, commitado ou enviado.

## 1. Visão geral

**Sólido:** a idempotência do webhook é real e durável (`unique(provider, instance, external_event_id)` no banco, insert antes de processar); a serialização por telefone existe (`lock:turn:<phone>` em Redis, SET NX PX com release compare-and-delete); o loop ReAct devolve erro de tool ao modelo (`ToolFailure`), tem teto de 4 rodadas + orçamento de 75 s, e a família de guardas anti-mentira (`claim-guard`, `verificarAnuncios`, voz única por `trace_id`) é rara de se ver tão madura; o envio passa por fila com trava de envio único (`msg:<messageId>`), fallback direto com pacing, e carimbo honesto de entrega; o histórico filtra o que o paciente nunca recebeu; consentimento LGPD exige aceite explícito; mídia é validada pelos bytes antes da visão.

**O que preocupa, em ordem:** (1) o apagamento LGPD dispara por **substring** sem estado pendente nem negação (`"não confirmo apagar"` apaga), e `quero sair` é gatilho de forget-me; (2) o aviso ao **contato de emergência** sai como texto livre num número que nunca falou com a Xarlote — no WABA isso é rejeitado fora da janela de 24h, e não existe template; (3) `resolvedElsewhere` **não enxerga negação** — "ainda não comprei o remédio" cancela o pedido vivo e responde "que bom que você já resolveu" (provado no probe); (4) o turno inteiro roda **no processo da API, em `setImmediate`, sem try/catch externo e sem fila** — qualquer exceção ou qualquer redeploy no meio de um turno deixa o paciente mudo; (5) sob carga, a fila de saída é **1 msg/1,2 s por número**, global, compartilhada com lembretes e consumida só pelo worker — 200 pacientes respondendo ao mesmo tempo esperam minutos.

---

## 2. Achados

### P0

**1. "CONFIRMO APAGAR" por substring, sem estado pendente e sem negação — e `quero sair` é pedido de esquecimento**
Severidade P0 · SEGURANÇA/LGPD + BUG · confiança **alta** (probe executado) · esforço P
- `apps/api/src/handlers/inbound-user.ts:670-687`
  ```ts
  if (inbound.text && isForgetMeRequest(inbound.text)) { … return; }        // 670
  if (inbound.text?.toLowerCase().includes('confirmo apagar')) {            // 675
    await writeAudit({ … action: 'user.forget_me.requested' … });
    await handleForgetMe(user.id, conversation.id, phoneE164, traceId);     // 685
  ```
- `packages/shared/src/constants.ts:69-76`: `FORGET_ME_PATTERNS = [ …, /quero\s+sair/i ]`
- `inbound-user.ts:2863-2885` (`handleForgetMe`): manda o adeus, **apaga `app_sessions`, revoga `share_grants` e enfileira a exclusão** — sem checar se houve um pedido antes.
- Probe (fonte compilada): `"quero sair de casa às 8h, me lembra?" → isForgetMeRequest = true`; `"não quero sair com essa dor" → true`; `"não, eu não confirmo apagar nada".includes('confirmo apagar') → true`.

Cenário: paciente escreve *"quero sair de casa às 8h, me lembra?"* → o pedido de lembrete é engolido (return na 673) e a Xarlote responde *"Pra confirmar que você quer apagar todos os seus dados, responde CONFIRMO APAGAR"* → o paciente, assustado, responde *"não! eu não confirmo apagar nada"* → sessão do app morta, links revogados, apagamento de prontuário enfileirado e irreversível (`executeForgetMe` verifica e relança até sobrar zero).

Correção: guarda pura em `packages/shared` (`decidirForgetMe(texto, pendenteDesde)`): (a) confirmação só vale com **estado pendente** (`users.metadata.forget_me_requested_at` ≤ 15 min, gravado no passo 670) **e** texto exato `^\s*confirmo apagar\s*[.!]*$` (sem "não/nao/nunca" antes); (b) `quero sair` restrito a `quero sair (do|da|desse|deste) (xarlote|app|serviço|programa|cadastro)`; testes vitest com as frases negadas.

**2. Aviso ao contato de emergência é texto livre fora da fila e fora da janela de 24h — no WABA nunca chega a quem nunca escreveu; e os botões de emergência têm título > 20 chars**
Severidade P0 · BUG (segurança de vida) · confiança **alta** (mecanismo) / **média** (comportamento exato do zpro) · esforço M
- `apps/api/src/handlers/red-flag-handler.ts:409`: `await sendText(SARA_INSTANCE, u.emergency_contact_phone_e164, msg);` — único caminho; não existe template (`config/template-registry.ts` só tem `pharmacy_quote | clinic_outreach | general | OTP | reengage`).
- A própria base documenta a regra: `packages/shared/src/waba-window.ts:2-3` *"Fora dela, texto livre é rejeitado pela Meta — só template HSM passa. Incidente Elizabet 13/07."*
- `red-flag-handler.ts:415-418`: o erro vira `{ok:false}` e o paciente lê `"o número que tenho não tá funcionando"` (linha 259-262) — mentira sobre a causa.
- Botões: `red-flag-handler.ts:43-44` — `'📞 Avisar meu contato'` = 21 unidades UTF-16 / 23 bytes; `'🚨 Ligar emergência'` = 19/22 (medido). Limite Meta de reply button = 20 caracteres (já conhecido: `ERR_WABA_BUTTON_TITLE_TOO_LONG_2`). O fallback de texto "1/2/3" funciona, mas `handleRedFlagButtonResponse` (linha 229-237) reconhece `'1'|'2'|'3'` só quando a mensagem tem ≤ 60 chars (gate em `inbound-user.ts:508`) — ok.
- Bônus no mesmo arquivo: `red-flag-handler.ts:272-278` — `catch {}` vazio ao marcar `responded_*`; se o update falha, o `red-flag-escalator` escala 60 s depois **mesmo após "Foi engano"** e avisa o contato à toa.

Cenário: paciente com contato de emergência cadastrado clica "Avisar meu contato" (ou não responde em 60 s) → zpro devolve erro de janela → ninguém é avisado → paciente lê que "o número não funciona".

Correção: template HSM aprovado de emergência (`ZPRO_TEMPLATE_EMERGENCIA`) enviado via `dispatchOutbound({kind:'template'})` com fallback de texto se a janela estiver aberta; encurtar rótulos (`'Ligar 192'`, `'Avisar contato'`, `'Foi engano'`); trocar o `catch {}` por log + retry, e fazer o escalator ler `user_response` antes de escalar.

### P1

**3. `resolvedElsewhere` ignora negação → backstop cancela pedido vivo e diz "que bom que resolveu"**
P1 · BUG · confiança **alta** (probe) · esforço P
- `packages/shared/src/pharmacy.ts:460-490`: `compraFeita = /(ja\s+)?(comprei|…|consegui|…|peguei|…)/` + `temObjeto = /(na|no|em|…)\s+\w{3,}/ || /(rem[ée]dio|…|farmacia|…)/` — nenhuma checagem de `não/nao/ainda`.
- `inbound-user.ts:2176-2199`: `resolveuPorFora → cancelIntent → handleToolCall('cancel_order', …)` e `2497-2504` a resposta vira *"Que bom que você já resolveu! Encerrei a busca…"*.
- Probe: `"ainda não comprei o remédio, tô esperando você" → true`, `"não consegui comprar na farmácia daqui, tá em falta" → true`, `"não peguei na farmácia ainda" → true`, `"nao pedi em lugar nenhum, só com você" → true`.
- `tests/resolved-elsewhere.test.ts:49-75` não tem nenhum caso negado.

Cenário: pedido em `quoted`; paciente escreve *"ainda não comprei o remédio, tô esperando você"*; o modelo só responde texto (nenhuma tool) → `calledCancel=false` → pedido cancelado, cotações congeladas, farmácia avisada se `handed_off`, e a mensagem inverte o que ele disse.

Correção: em `resolvedElsewhere`, recusar quando o verbo de compra vem precedido (≤ 3 tokens) de `n[ãa]o|nunca|nem|ainda n[ãa]o` ou quando o texto termina em `ainda`; testes com as 4 frases acima; mesma trava em `isOrderAcceptance` (`prefiro` já tem, `quero` não cobre "não quero").

**4. Sem rede de segurança externa no turno: qualquer exceção = paciente mudo; no app, o retry nunca pode ter sucesso**
P1 · BUG · confiança **alta** · esforço M
- `apps/api/src/routes/webhook.zpro.ts:233-238` e `webhook.uazapi.ts:117-122`: `setImmediate(() => processInboundUser(...).catch(err => { req.log.error; captureError }))` — só loga.
- `inbound-user.ts:396-411` / `413+`: `processInboundUserInner` não tem `try/catch`; pontos que lançam: `upsertUser` (`packages/db/src/queries.ts:22`), `findOrCreateConversation`, `insertMessage` (`queries.ts:88`), `getConversationMessages` (`queries.ts:82`) dentro do `Promise.all` de `inbound-user.ts:773`, e **todo `await writeLog`** (`queries.ts:149-161`, sem try/catch; 71 chamadas awaited em `inbound-user.ts`, 79 em `tool-executor.ts`) — um `fetch failed` em qualquer um mata o turno depois da LLM ter rodado e das tools terem agido.
- App: `apps/api/src/queues/app-inbound.queue.ts:41` `attempts: 3` + `infra/supabase/migrations/0025…sql:46-48` índice único `messages(external_id) where 'app-%'` + `queries.ts:86-90` `insertMessage` lança em erro → a 2ª tentativa **sempre** falha no insert. O retry é morto por construção; o paciente do app fica sem resposta e sem fallback.

Correção: em `processInboundUser`, `try/catch` que (1) conta `messages out` com `trace_id = traceId` depois de `llmStart` e, se zero, manda a frase honesta ("tive um problema aqui, pode repetir?") via `sendOutbound`; (2) no app, `insertMessage` idempotente por `external_id` (upsert/`maybeSingle` antes) para o retry retomar em vez de morrer; (3) `writeLog` nunca lança (try/catch interno) — ver também achado 19.

**5. Redeploy mata turnos em voo: o turno é `setImmediate` desacoplado do request, o shutdown não o espera e a fila `inbound-user` existe mas nunca foi usada**
P1 · BUG / RISCO SOB CARGA · confiança **alta** · esforço M (rastrear) / G (fila)
- `webhook.zpro.ts:233` responde 200 e solta o turno; `apps/api/src/lifecycle.ts:36-47` roda os disposers e `process.exit(0)`; `server.ts:157` só drena o HTTP (`app.close()`), que já respondeu; há `flushSupplierTurnBuffer` (server.ts:164) para a perna da farmácia e **nada** para a do paciente.
- `packages/shared/src/constants.ts:79` `INBOUND_USER: 'inbound-user'` — zero call-sites (grep). Além disso `webhook_events` já registrou o id → um retry do zpro cai em `skipped: 'duplicate'` (`webhook.zpro.ts:118-120`): a mensagem está no banco e nunca será respondida.

Cenário: `railway up` às 14:19 com um turno de foto de exame em andamento (2 chamadas de visão, ~30 s) → SIGTERM → processo morre → exame guardado pela ingestão, mas nenhuma resposta; o paciente reenvia e ouve "esse exame já está guardado".

Correção: (curto) `Set` de promessas em voo em `processInboundUser` + disposer `onShutdown('turnos em voo', () => Promise.allSettled(...))` registrado antes de `closeOutbound`, com `SHUTDOWN_TIMEOUT_MS` ≥ 90 s; (estrutural) mover o turno do WhatsApp para a fila `INBOUND_USER` consumida pelo worker, como o app já faz — resolve também o achado 17.

**6. Vazão de saída: 1 msg / 1,2 s por número, limiter global da fila, só o worker consome, lembretes na mesma fila, sem prioridade**
P1 · RISCO SOB CARGA · confiança **alta** · esforço P (config) / M (prioridade)
- `apps/api/src/queues/outbound.queue.ts:519-521`: `WA_RATE_MAX ?? 1`, `WA_RATE_DURATION_MS ?? 1200` → `{ concurrency: 1, limiter: { max, duration } }` (linha 533); `startOutboundWorkers` só em `workers/start-all.ts:96`.
- O comentário (linha 4) diz que o limite existe pelo **uazapi** ("1 número só"); em produção as duas pernas são WABA oficial.
- Reminder-dispatcher, relays de farmácia e respostas do turno compartilham `outbound-whatsapp-sara`; não há fila de prioridade.

Cenário: onda de lembretes das 08:00 (N pacientes) + 50 pacientes respondendo → cada resposta da Xarlote entra atrás dos lembretes; com 300 mensagens na fila, a última sai 6 min depois — e o `dedup` de 12 s (`outbound.ts:66`) e o `TURN_LOCK` não ajudam.

Correção: subir `WA_RATE_MAX/DURATION` para a cota WABA (ex.: 10/s) por decisão do fundador; BullMQ `priority` (turno do paciente = 1, relay = 2, lembrete = 5); manter o pacing conservador só quando `providerFor(instance) === 'uazapi'`.

**7. `relay_answer_to_establishment` devolve `ok:true` sem ter relayado nada, e a guarda anti-mentira confia no NOME da tool**
P1 · BUG · confiança **alta** · esforço P
- `apps/api/src/handlers/tool-executor.ts:255-260`: `await relayUserAnswerToEstablishment(...)` — resultado `{relayed:false}` ignorado, sem `observation.note`, sem `ToolFailure`.
- `clarification.ts:318-319`: `if (!pending) return { relayed: false };` e `:400-405`: o boolean de `sendOutboundToSupplier/Clinic` (que devolve `false` quando `assertSane` recusa) é descartado → `relayed: true` mesmo sem envio.
- `inbound-user.ts:2517-2522`: `reallyContacted = supplierMessaged || toolCalls.some(t => ['relay_answer_to_establishment', …].includes(t.name))`.

Cenário: pergunta da farmácia já fechada (`clarification_status='closed'` pelo confirm); o paciente responde "é do Hiago, apartamento 302"; o modelo chama `relay_answer…` → `ok:true` → "já passei pra farmácia 💙" → nada saiu, a farmácia entrega sem o complemento.

Correção: `if (!r.relayed) throw new ToolFailure('NADA foi enviado: não há pergunta pendente…')`; propagar o boolean do envio; setar `ctx.turnFlags.supplierMessaged = true` só no envio real e tirar `relay_answer_to_establishment` da lista por nome.

**8. A matemática do lock (espera 150 s / TTL 300 s) ignora os 3 retries do cliente LLM — e o turno de foto tem 2 chamadas de LLM antes da primeira resposta**
P1 · RISCO SOB CARGA · confiança **alta** (aritmética) · esforço P
- `packages/llm/src/client.ts:415-437`: `maxAttempts = 3`, retry em **qualquer** erro (inclusive 400/401/timeout), backoff 1 s/2 s.
- `inbound-user.ts:1560` `timeoutMs: 60_000` (1ª chamada) → pior caso 60+1+60+2+60 = **183 s** só nela; `handlers/ingestao-de-exame.ts:140` (`lerFotoDeDocumento`, `timeoutMs: 60_000`, também via `chat()`) roda **antes** (`inbound-user.ts:1369/1429`), mais `transcreverMidia` 30 s, mais `AGENT_LOOP_BUDGET_MS` 75 s + rodada iniciada antes do deadline (25 s×3).
- `inbound-user.ts:382/389`: `TURN_LOCK_WAIT_MS = 150_000`, `TURN_LOCK_TTL_MS = 300_000`, comentário "cobre o pior caso com folga" — falso quando o OpenRouter degrada (justamente quando importa; foi o cenário do incidente de 30/07). O breaker (`failureThreshold: 5`) só abre depois de ~5 falhas.
- Também `client.ts:282-306`: o `AbortController` é limpo no `finally` após os headers; `res.json()` lê o corpo **sem timeout**.

Correção: `maxAttempts` = 2 para o turno interativo e nunca retentar 4xx; orçamento de tempo do **turno inteiro** (`Date.now()-turnStart`) passado como `timeoutMs` restante para cada `chat()`; abort do corpo (mover `clearTimeout` para depois do `res.json()`); TTL do lock = orçamento + margem, e renovar o lock (PEXPIRE) a cada rodada.

**9. Resposta > 4096 caracteres nunca é dividida — a Meta rejeita, o job falha 5× e o paciente fica mudo justo no turno longo**
P1 · BUG · confiança **média** (limite documentado pela Meta; comportamento do zpro não confirmado) · esforço P
- `outbound.ts:53-113`, `zpro-client.ts:164-176`, `outbound.queue.ts:287`: nenhum chunk; grep por `4096|chunk|split` em whatsapp/outbound = vazio.
- `inbound-user.ts:1559` `maxOutputTokens: 2000` (≈ 6–7 mil chars em PT); `xarlote.system.ts` manda "leia e INTERPRETE… opine" para laudos.
- `outbound.queue.ts:266-277`: HTTP 4xx prova que nada saiu → 5 tentativas idênticas → `failed`.

Correção: `dividirParaWhatsApp(texto, 4000)` pura em `packages/shared` (corta em parágrafo/frase), aplicada em `sendOutbound` gerando N jobs com `messageId` próprio.

### P2

**10. `start_pharmacy_order` procura pedido ativo SEM janela de tempo (o prompt e os backstops usam 24h) — um `confirming` preso bloqueia o mesmo remédio para sempre**
P2 · BUG · confiança **média** · esforço P
- `tool-executor.ts:1048-1055` `.in('status', ['quoting','quoted','confirming'])` sem `.gte('created_at', …)`; `:1088-1095` mesmo remédio → `sendCurrentOrderStatus` do pedido velho.
- `order-state.ts:97-105` e `inbound-user.ts:787-794` usam `JANELA_PEDIDO_VIVO_MS`. `confirming` só vira `handed_off` em `tool-executor.ts:2982`; se algo lança entre o CAS (2836) e ali, ninguém expira `confirming` (`order-followup.worker.ts:118-121` só trata `quoted`; `rescueOrphanedPharmacyQuotes` só `quoting`).
Correção: mesma janela no `existingActive`; worker expira `confirming` > 2h para `failed` com motivo.

**11. Menus de consentimento enviados direto, fora da fila (regra inegociável #5), sem carimbo de entrega**
P2 · QUALIDADE / RISCO SOB CARGA · confiança **alta** · esforço P
- `inbound-user.ts:556` e `:657` `await sendMenu(SARA_INSTANCE, …)`; a fila já suporta `kind: 'menu'` (`outbound.queue.ts:327-334`). A linha em `messages` (545-553) não recebe `delivery_status`. 200 primeiros contatos simultâneos = 200 chamadas paralelas ao zpro sem pacing nem trava de duplicata.
Correção: `dispatchOutbound({ kind:'menu', ticketId, messageId })`.

**12. Lock sem FIFO: rajada do mesmo paciente é processada fora de ordem, e o timestamp do provedor não é persistido**
P2 · UX / QUALIDADE · confiança **alta** · esforço M
- `concurrency/user-lock.ts:49-55`: poll `SET NX` com jitter 150–270 ms; quem chega ao Redis primeiro depois do release vence. `queries.ts:86-90` `insertMessage` sem `created_at` (o `inbound.timestamp` é descartado) → o histórico grava a ordem de **processamento**.
Cenário: "quero paracetamol" / "na verdade dipirona" / "500mg" em 3 s → o modelo pode ler "500mg" antes de "na verdade dipirona".
Correção: fila por telefone em Redis (LPUSH/BRPOP ou BullMQ com `jobId` + group) ou, no mínimo, `created_at = inbound.timestamp`.

**13. Sem debounce na perna do paciente (a da farmácia tem 8 s)**
P2 · UX / OTIMIZAÇÃO · confiança **alta** · esforço M
- `inbound-supplier.ts:953-979` (`SUPPLIER_DEBOUNCE_MS = 8000`) vs. nada em `inbound-user.ts`. Cinco linhas curtas = 5 turnos de LLM, 5 respostas, 5× custo, e o achado 12.
Correção: janela de 2–3 s por telefone antes de adquirir o lock, concatenando textos (mídia não agrupa).

**14. `users.metadata` (JSONB) tem ≥ 6 escritores read-modify-write sem merge atômico — updates perdidos**
P2 · BUG (concorrência API × worker) · confiança **alta** (padrão) / **média** (frequência) · esforço P
- `inbound-user.ts:2785` `metadata: { ...meta, audio_intro_sent: true }` com `meta` do **início do turno** (apaga o que `save_user_profile_fact`/`gravaMeta` gravaram no mesmo turno); `tool-executor.ts:486-488`; `workers/reminder-dispatcher.worker.ts:608,690,751` (`uMeta` lido no início do tick); `workers/open-intent-chaser.worker.ts:73-99` (`u.metadata` da listagem); `routes/admin.ts:114`.
Cenário: turno grava `onboarding_qs_declined: true` (tool) enquanto o dispatcher regrava `{...uMeta, reengage_template_at}` → a recusa some → a Xarlote volta a fazer as perguntas ("NUNCA insista" violado).
Correção: RPC `merge_user_metadata(user_id, patch jsonb)` (`metadata = metadata || patch`) e remoção de chave por `metadata - 'k'`; um escritor.

**15. `save_user_profile_fact` insere sem checar existência; enricher usa outro lock (`user`) que não o do turno (`turn`)**
P2 · BUG · confiança **alta** · esforço P
- `tool-executor.ts:436-459` inserts crus em `user_health_conditions/allergies/medications`; `workers/profile-enricher.worker.ts:188-202` check-then-insert sob `lock:user:<userId>`; o turno usa `lock:turn:<phone>` (`inbound-user.ts:405-407`). Chamadas repetidas da tool (o modelo repete em rodadas/turnos) = "Dipirona" ×3 no prontuário e no prompt.
Correção: mesmo `ilike` check-then-insert na tool (ou índice único parcial `lower(substance)`), e o enricher tomar também o lock de turno.

**16. Rate-limit `INCR` + `EXPIRE` não atômico → chave sem TTL → paciente bloqueado para sempre**
P2 · BUG (baixa probabilidade, dano alto) · confiança **alta** · esforço P
- `middleware/rate-limit.ts:28-30`: `incr` e só então `expire` se `count === 1`; se o `expire` falhar (blip), a chave vive sem TTL; após 25 mensagens acumuladas, `allowed=false` em toda mensagem e o aviso "já já te respondo" (`webhook.zpro.ts:219-229`) sai uma vez — e nunca responde (a mensagem é descartada).
Correção: `SET rk 0 EX window NX` + `INCR`, ou `EXPIRE rk window NX` em toda chamada (Redis 7).

**17. Mídia: download sem teto de tamanho, PDF parseado no event loop da API, sniff só depois de baixar tudo**
P2 · RISCO SOB CARGA · confiança **alta** · esforço M
- `packages/whatsapp/src/client.ts:249-266` `axios.get(…, {responseType:'arraybuffer', timeout: 30_000})` sem `maxContentLength` (WhatsApp aceita documento até 100 MB); `lib/media-sniff.ts:47` `MAX_BYTES = 10 MB` checado **depois**; `packages/integrations/src/pdf-leitor.ts:34-105` pdf.js no processo (e `linhas.join('\n').length` dentro do loop, O(n²)); tudo isso em `ROLE=api`, que também precisa responder webhooks.
Correção: `maxContentLength` = 10 MB + `HEAD`/`Content-Length` antes; ingestão de documento no worker (ver achado 5).

**18. Handler pode ficar mudo quando a LLM devolve vazio e um worker escreveu na conversa durante o turno (`sentThisTurn` sem `trace_id`)**
P2 · BUG · confiança **alta** · esforço P
- `inbound-user.ts:2464-2470` filtra por `trace_id` (com o comentário explicando por quê); `:2625-2631` **não** filtra. Lembrete/relay disparado no meio do turno + resposta vazia (truncada) → nenhum fallback, paciente sem resposta à mensagem dele.
Correção: `.eq('trace_id', traceId)` na segunda query (e cobrir com teste).

**19. ~150 `await writeLog` no caminho quente — latência serial e ponto de falha**
P2 · OTIMIZAÇÃO · confiança **alta** (contagem) / **média** (latência) · esforço P
- `queries.ts:149-161` = 1 insert síncrono em `system_logs` por chamada; 71 em `inbound-user.ts`, 79 em `tool-executor.ts`. Um turno típico acumula 10–20 round-trips só de log (Railway → Supabase sa-east-1), e cada um pode lançar (achado 4).
Correção: `writeLog` fire-and-forget com buffer/batch e `catch` interno; `await` só em `error`.

**20. Backstop de fechamento (11b) lê a "última fala" sem filtrar `delivery_status` — um "ok" pode fechar compra cuja apresentação nunca chegou**
P2 · BUG · confiança **média** · esforço P
- `inbound-user.ts:2059-2067` seleciona `direction='out'` após `presented_at` sem excluir `window_blocked/failed`; `quote-consolidation.ts:717` carimba `presented_at` pelo espelho, não pela entrega; `packages/llm/src/utils/history.ts:27` já define `NAO_ENTREGUE` para o histórico. Cenário: apresentação rejeitada pela janela, paciente responde "ok" a um template de reengajamento → `resolveQuotePick` genérico com 1 opção → `confirm_order_selection` → farmácia recebe "pode preparar".
Correção: reutilizar `NAO_ENTREGUE` no filtro e exigir `delivery_status='delivered'` na âncora.

**21. Tool inventada pelo modelo cai em `default: break` e vira `ok:true`; args nunca validados com Zod**
P2 · QUALIDADE · confiança **alta** · esforço P
- `tool-executor.ts:309-310` `default: break;` → `:339-344` `return { ok: true }` + `assistant_tasks.status='success'`; `resolveToolName` (`client.ts:227-248`) só corrige distância ≤ 3. Args: todos `tc.args as {...}` (grep `zod|safeParse` em tool-executor = 0); `client.ts:365` JSON inválido vira `{}` em silêncio. (O próprio arquivo registra que `cancel_order` já foi vítima disso: linhas 779-783.) Todas as 33 tools do schema têm `case` hoje — o risco é o nome alucinado.
Correção: `default: throw new ToolFailure(\`ferramenta "${tc.name}" não existe\`)`; schema Zod por tool derivado do JSON schema em `xarlote-tools.ts`, com `ToolFailure` listando os campos.

**22. Tipos de mensagem: vídeo sem legenda e tipos desconhecidos viram silêncio; figurinha vira 2 chamadas de visão**
P2 · UX · confiança **alta** · esforço P
- `packages/whatsapp/src/zpro-normalize.ts:346-353`: sem ramo de vídeo — com legenda vira texto (o modelo nem sabe que veio vídeo), sem legenda → `null` → `webhook.zpro.ts:146-158` só loga warn e devolve `no-normalized` (paciente mudo). Reação/edição/apagamento: shape não capturado → mesmo caminho (reação em silêncio é aceitável; edição "não confirmado").
- `:314` `typeStr.includes('sticker')` → `image` → `ingerirDocumentoDeExame` + turno multimodal (2 chamadas de visão por figurinha).
Correção: ramo `video` → texto `[O paciente enviou um vídeo; eu não assisto vídeo — peça foto ou texto]`; `sticker` → texto curto sem visão; `unknown` → fallback textual honesto em vez de `null`.

### P3

**23. Fuso: datas de tratamento em UTC e período do dia em `getHours()` do servidor**
P3 · BUG · confiança **alta** · esforço P
- `tool-executor-v2.ts:149,185,199-201,224,523` `new Date().toISOString().slice(0,10)` para `started_at/start_date/expected_end_date/expected_depletion_at/ended_at` (entre 21:00 e 23:59 BRT o dia é +1; `packages/shared/src/adherence.ts:56` já faz certo com `BRT_OFFSET_MS`); `workers/skill-extractor.worker.ts:179` `d.getHours()` → 10h BRT vira "tarde", 21h BRT cai fora dos buckets → skill de período errada entra no prompt.
Correção: `hojeLocal()`/`horaLocal()` únicos em `br-datetime.ts`.
Nota: `tool-executor-v2.ts` **está vivo** (9 handlers importados em `tool-executor.ts:23-30`), não é código morto.

**24. Pequenos "falha vira sucesso" e ruído**
P3 · QUALIDADE · confiança **alta** · esforço P
- `tool-executor.ts:2344-2347` e `:2360-2365` (`create_reminder` sem horário/passado) e `:2797-2802` (`confirm` já fechado): `return` sem `ToolFailure`/`note` → `ok:true` ao modelo.
- `webhook.zpro.ts:224` promete "já já te respondo" para uma mensagem que é descartada.
- `inbound-user.ts:843` `history.slice(0, -1)` assume que a última linha é a mensagem atual (um `out` de worker no meio duplica a fala do paciente no prompt); filtrar por `inboundMsg.id`.
- `client.ts:333-345`: `finish_reason` não é lido → truncamento por `max_tokens` sai cortado sem detecção.
- `webhook_events` sem retenção (poda desagendada de propósito, `0028:125-143`) — LGPD art. 6º III citado pela própria migration; decisão do fundador, registro aqui.

---

## 3. O que verifiquei e está OK

- Idempotência do webhook: `unique(provider, instance, external_event_id)` (`infra/supabase/schema.sql:394`), insert antes de processar, sobrevive a restart; uazapi idem.
- Echo/status/grupo/fromMe ignorados sem cair no pipeline (`zpro-normalize.ts:148-156, 207-215`); sinal de entrega alimenta o diretório.
- Lane de estabelecimento blindada por número mesmo quando a URL diz cliente (`webhook.zpro.ts:33-77`).
- Lock por telefone com release compare-and-delete em Lua, fail-open documentado; app e WhatsApp compartilham o mesmo lock.
- Consentimento: aceite explícito, mídia antes do aceite não é processada, botões reenviados.
- Loop ReAct: 4 rodadas, `ONCE_PER_TURN_TOOLS`, tool result ecoado com `tool_call_id`, erro de tool volta ao modelo; `assistant_tasks` gravado em start/success/error (`tool-executor.ts:166-171, 314, 351`); `redigirCredenciais` na entrada e na saída.
- Preempção de emergência regex-conservadora com guardas de passado/3ª pessoa; escalonamento durável em `red_flag_pending`.
- Fila de saída: trava de envio único por `messageId` (SET NX 15 min) + trava local, release só com prova de 4xx, `withQueueRetry` + fallback direto com pacing; `sendDedupKey` protege o caso "add na fila deu timeout mas passou".
- `messagesToHistory` exclui `window_blocked/suppressed/failed` e carimba lacunas ≥ 6 h com data.
- Histórico limitado a 30 linhas; transcript de PDF limitado a 400 chars; laudo cortado por valor, corte anunciado.
- Mídia validada pelos bytes (`sniffMidia`), token do Meta para lookaside, PDF cifrado tratado; imagem-lixo não vai à visão.
- `create_reminder`: data/hora calculadas no servidor com `userTz`, COUNT/UNTIL honrados, one-shot no passado recusado, dedupe por título+rrule.
- `/simulate` desligado em produção (`simulate.ts:33-36`).
- `confirm_order_selection`: quote validada antes de transicionar, CAS `quoting/quoted → confirming`, congela irmãs.

## 4. Perguntas em aberto (só produção/fundador respondem)

1. O zpro alguma vez posta **array** de eventos? `webhook.zpro.ts:101-103` pega só o `[0]` — se sim, o resto é perdido em silêncio. Conferir em `webhook_events.raw` se algum `raw` chegou como array.
2. Qual o **timeout do webhook** do zpro e quantas retentativas? Define o quanto o achado 17 (event loop ocupado) vira duplicata/perda.
3. A Meta/zpro devolve qual erro para texto > 4096 (achado 9)? Há em `system_logs` algum `zpro /text HTTP 400` com corpo longo?
4. Quantas mensagens `messages.delivery_status='failed'` na perna `sara` nos últimos 30 dias, por motivo? (mede os achados 6, 9 e 20 na prática.)
5. Já houve caso real de `red_flag_pending` com `emergency_contact_notified=true`? Se nunca, o achado 2 está confirmado em produção.
6. Existe registro de `user.forget_me.requested` sem `user.forget_me.executing` precedido por `isForgetMeRequest`? (`audit_log`) — mede quantas vezes o gatilho `quero sair` já disparou.
7. Qual a cota WABA (tier) do número da Xarlote hoje — para dimensionar `WA_RATE_MAX` (achado 6) sem risco.
8. Na perna do app, quantos jobs `app-inbound` terminaram `failed` com `attemptsMade=3` (achado 4)?
