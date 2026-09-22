# Auditoria profunda da Xarlote — equipe sênior (21–22/09/2026)

> **Base:** branch `fix/auditoria-set`, HEAD `b981a3d` (= produção desde 21/09 14:19 UTC). **Modo:** somente leitura — nenhum arquivo de código foi alterado, nenhum deploy, nenhuma escrita no banco, nenhuma mensagem a paciente. **Equipe:** 9 especialistas independentes (pipeline de entrada, filas/escala, banco, segurança/LGPD, web, mobile, LLM/prompts, integrações/resiliência, qualidade/build), ~85 mil linhas lidas, 871 consultas ao código, metadados reais de produção (só `pg_*`/`information_schema`, nunca linhas de paciente). Os achados marcados **✅ conferido** foram reproduzidos por mim no código depois do relatório do especialista.
>
> ✅ **22/09, fim do dia — os 8 P0 abaixo foram CORRIGIDOS** (código no working tree, nada publicado): ver [`10-CORRECOES-APLICADAS.md`](10-CORRECOES-APLICADAS.md) com o que mudou, a ordem de publicação, as variáveis de reversão e os riscos assumidos. 2.301 testes verdes, typecheck limpo em 9/9 workspaces. Os P1/P2 deste documento seguem abertos.
>
> **Relatórios integrais** (com trecho, cenário, correção, esforço e confiança em cada achado): [01 pipeline](01-pipeline-de-entrada.md) · [02 filas/escala](02-filas-workers-escala.md) · [03 banco](03-banco-de-dados.md) · [04 segurança/LGPD](04-seguranca-lgpd.md) · [05 web](05-frontend-web.md) · [06 mobile](06-app-mobile.md) · [07 LLM/prompts](07-llm-prompts-tools.md) · [08 integrações](08-integracoes-resiliencia.md) · [09 qualidade/build](09-qualidade-testes-build.md).

---

## 1. Resumo executivo

**O que está sólido.** O núcleo que já pagou incidente é bom de verdade: idempotência de webhook por constraint única, lock por paciente com release atômico, fila de saída com rate-limit global e trava anti-duplicata, timeout + retry + circuit breaker em toda chamada externa, cadeia de fallback de LLM ciente de modalidade, guardas anti-alucinação nascidas de casos reais, cofre AES-256-GCM correto, OTP/refresh/share só por hash, **nenhum IDOR** nas 14 rotas novas do app, RLS ligada em 100% das tabelas, 2.191 testes puros passando em 6 s, typecheck limpo em 9/9 workspaces.

**O que preocupa** não é falta de proteção — é **furo nas costuras**: entre API e worker, entre web legado e app novo, entre o que o handler anuncia e o que o banco confirmou, entre o que o dashboard grava e o que o worker lê. Oito problemas são P0 (paciente prejudicado, dado exposto ou perda irreversível) e todos têm correção conhecida e curta. Dois deles são operacionais e resolvem-se hoje: **o código que roda em produção só existe neste Mac** e **o prontuário inteiro está legível com a chave anônima do bundle público**.

**Sob demanda alta**, o gargalo não é CPU nem banco (51 MB, 8 conexões de 60): é a fila de saída FIFO a 1 msg/1,2 s por número sem prioridade (a resposta ao paciente entra atrás de todos os lembretes das 08:00), o turno de LLM rodando no processo HTTP sem durabilidade, o dispatcher de lembretes com teto de 50 por tick e ~15 round-trips por lembrete, e 77% das requisições ao banco sendo pollers que devolvem zero linhas.

---

## 2. Placar

| Verificação | Resultado |
|---|---|
| `pnpm typecheck` | ✔ 9/9 workspaces (11 s) |
| `pnpm test` (vitest) | ✔ 2.191/2.191 em 122 arquivos, 5,8 s, 0 skip, 0 flaky |
| `pnpm lint` | ✘ não existe config em `apps/web`; api/packages sem lint; mobile 17 erros / 18 warnings |
| `pnpm audit --prod` | **3 críticas** (Next 14.2.35: RCE) · **65 altas** (fastify 4, axios, playwright, ws, form-data) · 36 moderadas |
| Git | **84 commits à frente de `main`, em nenhum branch remoto** (`git branch -r --contains HEAD` vazio) ✅ conferido |
| Banco (prod) | PG 17.6 · 51 MB · 33 usuários · ~5 k mensagens · RLS em 44/44 tabelas · **7 policies `anon_read_*` `using (true)` vivas** · buckets `xarlote-media` e `xarlote-audio` **públicos** |
| Cobertura | 99/207 arquivos-fonte importados por algum teste; 0 testes com Redis/Supabase (nem mock); 0 smoke pós-deploy |
| CI | roda só em `main` (parada em 03/08); deploy = `railway up` do working tree — nada gateia produção |

---

## 3. P0 — fazer agora (ordem sugerida)

### P0-1 · O código de produção só existe neste Mac ✅ conferido
`git branch -r --contains HEAD` → vazio; `origin/main` parou em 03/08 (`97f113e`); 84 commits (exames v2, cuidador, farmácia 15/09, glm) sem cópia fora do disco. **Correção (1 comando, hoje):** `git push -u origin fix/auditoria-set`; depois PR → `main`. Antes de abrir o repo a terceiros: as três chaves OpenRouter no histórico (`a4951b9`, `1034198`, `9ede403`) precisam de revogação confirmada e o histórico reescrito (gitleaks/BFG). — [09 §P0-1](09-qualidade-testes-build.md), [04 §4](04-seguranca-lgpd.md)

### P0-2 · Prontuário aberto: web `/app` por telefone + policies anon + buckets públicos ✅ conferido
Três camadas independentes, cada uma suficiente:
- **Rota legada** `routes/app.ts` ainda registrada (`server.ts:137`): `POST /app/overview` e `POST /app/inbound` identificam pelo `phone` do body, protegidos só pelo `NEXT_PUBLIC_APP_API_TOKEN` (público no bundle de `xarlote.com.br/app`, com fallback para o token de **admin** em `ApiAuth.tsx:7-8`). Qualquer pessoa lê o prontuário de qualquer número e **fala com a Xarlote em nome dele** (a resposta sai no WhatsApp do titular).
- **Policies `anon_read_users|messages|conversations|orders|quotes|suppliers|system_logs`** com `using (true)` confirmadas em `pg_policies` de produção + `anon` com SELECT em todas as tabelas de `public` + realtime publicado em `messages`. Com a anon key do bundle: `users` (CPF, nascimento, contato de emergência), `messages` (todas), `orders` (endereço, lat/lng), `quotes` (Pix).
- **Buckets** `xarlote-media` (40 objetos: fotos de receita/laudos/PDFs) e `xarlote-audio` públicos, sem policy em `storage.objects`; o código já usa signed URL (`media-host.ts:29-34` pede a migration há semanas).

**Correção:** (a) 30 min — bloquear `/app` no `middleware.ts` do web (redirect para a loja/OTP) e remover o fallback `NEXT_PUBLIC_ADMIN_API_TOKEN`; (b) migration `0034`: `drop policy` de tudo com `roles @> '{anon}'` + `revoke all on all tables in schema public from anon` + `update storage.buckets set public=false where id in ('xarlote-media')`; (c) 1–2 dias — cutover do web `/app` para as rotas com OTP/JWT (já existem) e tirar `NEXT_PUBLIC_SUPABASE_ANON_KEY` do bundle; (d) `xarlote-audio`: gravar o path na mensagem e podar por idade. — [05 §P0-1](05-frontend-web.md), [03 §P0-1 e §P1-6](03-banco-de-dados.md), [08 §P1-7](08-integracoes-resiliencia.md), [04 §3](04-seguranca-lgpd.md)

### P0-3 · Apagamento LGPD dispara por substring, quebra no meio e apaga dados de terceiros ✅ conferido
- **Gatilho:** `inbound-user.ts:675` `text.toLowerCase().includes('confirmo apagar')` sem estado pendente nem negação; `FORGET_ME_PATTERNS` (`constants.ts:75`) contém `/quero\s+sair/i`. Cenário real: *"quero sair de casa às 8h, me lembra?"* → pedido engolido, Xarlote pergunta se apaga → *"não! eu não confirmo apagar nada"* → sessões mortas, links revogados, **apagamento irreversível enfileirado**.
- **Execução:** FK `consent_events.evidence_message_id → messages(id)` é `ON DELETE NO ACTION` e o handler grava esse campo ao autorizar busca de exame (`tool-executor.ts:3141`) → o passo 3 (`messages.delete`) **lança** para qualquer paciente que já usou a frente de exames; passos 4–8 (memória, storage, anonimização) nunca rodam → paciente meio-apagado, telefone e mensagens intactos. Fios de **clínica** contam "outros pacientes" só por `quotes` → `consultation_quotes` = 0 → apaga o histórico da clínica com os outros pacientes. O fluxo anonimiza `users` **antes** de terminar (não é retomável) e ignora erro do Storage. Um job `account-forget` que falhou bloqueia **para sempre** novo pedido do mesmo paciente (`jobId` fixo + `removeOnFail:false`), respondendo 202.
- **Export LGPD** devolve `registro_de_acessos` e `acoes_automaticas` sempre vazios: seleciona `created_at` em `audit_log`/`assistant_tasks`, colunas que não existem (`app-export.ts:147,151`) e o `safe()` engole o erro.

**Correção:** guarda pura `decidirForgetMe(texto, pendenteDesde)` (confirmação só com pedido pendente ≤15 min, texto exato `^\s*confirmo apagar\s*[.!]*$`, negação vence; `quero sair` só com objeto: `do xarlote/app/cadastro`) + testes; FK → `on delete set null`; contar donos via `consultation_quotes`; reordenar (storage → linhas → anonimizar por último, telefone/paths persistidos no job); `getJob` + `retry` antes do `add`; corrigir colunas do export. — [01 §P0-1](01-pipeline-de-entrada.md), [03 §P1-2/3/4/5](03-banco-de-dados.md), [02 §B2](02-filas-workers-escala.md)

### P0-4 · Emergência: o contato de emergência (quase) nunca é avisado — e a Xarlote diz que avisou ✅ conferido
`red-flag-handler.ts:409` manda **texto livre** por `sendText` direto (fora da fila — regra inegociável 5) para um número que, por definição, nunca falou com a Xarlote → no WABA a Meta rejeita fora da janela de 24 h (a própria base documenta isso: `waba-window.ts:2-3`, incidente Elizabet 13/07). Não existe template de emergência no `template-registry`. O aceite do zpro vira `"✅ Avisei fulano"` (`:251`, `:333`) sem prova de entrega; se o zpro recusa na hora, o paciente lê *"o número que tenho não tá funcionando"*. Agravantes: botões `'📞 Avisar meu contato'`/`'🚨 Ligar emergência'` excedem 20 caracteres (limite Meta) — só o fallback 1/2/3 funciona; `catch {}` vazio ao marcar `responded_*` (`:272-278`) e, como supabase-js **não lança**, um update falho deixa `pending` e o escalator avisa o contato **depois de "foi engano"**; a preempção determinística (`EMERGENCY_RE`, `inbound-user.ts:1649`) não cobre suicídio/automutilação/overdose — `EMERGENCY_KEYWORDS` em `constants.ts:118` é código morto — então esses casos dependem do modelo chamar `red_flag_check` (o fallback `gpt-4.1-mini` perde tool calls).

**Correção:** template HSM de utilidade `contato_emergencia` (pedir aprovação na Meta **hoje**; leva dias) enviado por `dispatchOutbound` com `messageId`; até lá, texto honesto *"tentei avisar X; se ele não te procurar em 5 min, liga 192"*; rótulos `'Ligar 192'`/`'Avisar contato'`/`'Foi engano'`; `throwOnError` no update + escalator lê `user_response`; estender `EMERGENCY_RE` com padrões conservadores de ideação suicida/overdose (com `PASSADO_RE`/`TERCEIRO_RE`). — [01 §P0-2](01-pipeline-de-entrada.md), [08 §P0-2](08-integracoes-resiliencia.md), [07 §P1-6](07-llm-prompts-tools.md), [09 §P1-7](09-qualidade-testes-build.md)

### P0-5 · Fila de saída: 5xx/timeout do zpro = mensagem perdida em silêncio; Redis piscando = mensagem duplicada ✅ conferido
- **Perda:** `rawSend` só libera a trava anti-duplicata em 4xx/`success=false` (`outbound.queue.ts:259-267`). Em 5xx/timeout/DNS a trava fica; a retentativa do BullMQ acha a chave → devolve `'duplicate'` → o processor **completa sem carimbar nada** (`:527-529`). O comentário do arquivo diz "o job vai pra `failed` com carimbo" — não vai. O dispatcher de lembretes carimba `delivered` otimista contando que o worker re-carimba (`reminder-dispatcher.worker.ts:708-713`) — ele não re-carimba. O detector de falhas só conta `level=error` → **zero alerta**. Dez minutos de zpro instável = 100% das mensagens do período perdidas, doses inclusive, com o dashboard dizendo "entregue".
- **Duplicata:** `withQueueRetry` usa `Promise.race` sem cancelar o `queue.add` (`:455-468`); a conexão de produtor do BullMQ mantém `enableOfflineQueue: true` → o `add` fica pendurado, o fallback envia direto (trava só local no processo `api`), o Redis volta, o `add` executa, o **worker** faz `SET NX` numa chave que nunca existiu e envia de novo. É o mecanismo mais plausível dos incidentes de 27/07 e 30/07.

**Correção:** `externalKey` estável por mensagem lógica (= `sendDedupKey`) e perguntar ao zpro se deduplica server-side; classificar `ECONNREFUSED/ENOTFOUND` como "nada saiu"; no ramo `'duplicate'`, consultar `messages.delivery_status` e reenviar se ainda `queued`; ambíguo (5xx) → falhar terminal com `stampDelivery('failed')` + `writeLog('error')`; dispatcher carimba `queued` e só o worker escreve `delivered`; produtores com `enableOfflineQueue:false` + `jobId: sendToken`. — [08 §P0-1](08-integracoes-resiliencia.md), [02 §A1/C9](02-filas-workers-escala.md)

### P0-6 · O turno do paciente não é durável: todo deploy mata turnos em voo ✅ conferido
`webhook.zpro.ts:233` responde 200 e solta `processInboundUser` em `setImmediate`; `lifecycle.ts` drena só o HTTP e faz `process.exit`; `isShuttingDown()` **não é chamado em lugar nenhum**; a fila `INBOUND_USER` existe em `QUEUE_NAMES` e nunca foi usada. O paciente fica mudo, o zpro não reenvia (já recebeu 200) e, se reenviar, cai em `skipped: 'duplicate'`; o `turn-lock` fica preso 300 s. Agravantes: `processInboundUserInner` não tem `try/catch` externo (qualquer `writeLog`/`insertMessage` que lance depois da LLM = mudo, ~150 `await writeLog` no caminho quente); na perna do app o retry é morto por construção (índice único em `external_id` + `insertMessage` lança na 2ª tentativa); uma conexão SSE aberta segura o `app.close()` até o timeout duro → `exit(1)` e os disposers seguintes (flush de fornecedor, `closeOutbound`) nunca rodam; `SHUTDOWN_TIMEOUT_MS=25 s` < pior turno (até 183 s com os 3 retries do cliente LLM).

**Correção (curta):** `Set` de turnos em voo + disposer `Promise.allSettled` antes de fechar filas; `Fastify({ forceCloseConnections: true })`; `try/catch` externo que, se nenhuma `messages out` com o `trace_id` saiu, manda a frase honesta; `insertMessage` idempotente por `external_id`. **Correção (estrutural):** webhook só normaliza + enfileira (`jobId = external_event_id`) e o worker roda o turno, como o app já faz — resolve deploy, réplica e retry de uma vez. — [02 §A2/B1](02-filas-workers-escala.md), [01 §P1-4/5/8](01-pipeline-de-entrada.md), [08 §P1-3](08-integracoes-resiliencia.md)

### P0-7 · App mobile em modo cuidador: logout indevido e escrita no prontuário errado ✅ conferido
`use-reminders.ts:135` calcula `subjectExtra` e **nunca usa** (o lint apontava): "Já tomei" no lembrete da mãe vai sem `?subject=` → a API (`reminders.ts:791-805`) responde 403 → `errors.ts:70` mapeia 403 como `unauthenticated` → refresh à toa → 403 de novo → `onSignedOut()`: **a cuidadora é deslogada e o cache limpo**. Pior: "+ Contar alergia / Cotar / Já tomei" na tela de Saúde da mãe montam mensagens em primeira pessoa (`insights.ts:334,389`, `saude/index.tsx:287`) e mandam para `POST /app/messages`, que não conhece sujeito → **a Xarlote cota Losartana para a filha e o enricher pode inferir que a filha toma Losartana** — a classe do incidente `para_quem` de 31/08 por outra porta. O chat nem mostra o chip "você está no registro de X".

**Correção (OTA, ½ dia):** usar `subjectExtra` na mutation e a rota de ação resolver `?subject=` com capacidade `agir`; kind `forbidden` para 403 (nunca desloga); desabilitar as ações de "falar com a Xarlote" quando `cuidandoDeOutro` (ou abrir `POST /messages?subject=` com a persona sabendo quem fala por quem — decisão de produto). — [06 §P0-1/2/3](06-app-mobile.md)

### P0-8 · `/prompts`: um toggle zera as outras chaves; e o worker nunca lê o que o dashboard grava ✅ conferido
`savePrompts` faz `{...current, ...data}` com `data` trazendo `undefined` explícito em todas as chaves não tocadas (`admin.ts:324-340`) → `JSON.stringify` descarta → **o arquivo fica só com a chave do toggle** (reproduzido: `{"a":false}`). Xarlote OFF + toggle de qualquer fluxo → Xarlote volta a ON em silêncio; `llm_model`, `llm_api_key`, `vision_model`, `sara_suffix`, `tts_*` revertem para env/default. Além disso `PROMPTS_FILE` é disco local do container (`prompts.ts:4`) e a API e o worker são serviços separados: `reminders_enabled`, `nudges_enabled`, modelo e chave do enricher/compactor/TTS **no worker vêm do env, não do dashboard** — o "freio de emergência" de lembretes não freia (salvo se houver volume compartilhado — confirmar). O "Salvar" do web ainda reenvia a config inteira do momento em que a aba abriu, religando switches desligados em outra aba (`prompts/page.tsx:278-292`).

**Correção:** filtrar `undefined` antes do spread + teste unitário; config de runtime em tabela (`runtime_config`, cache 10 s) ou Redis pub/sub lida pelos dois serviços; web salva só o diff; `GET /admin/prompts` devolve chaves mascaradas. — [09 §P1-3/4](09-qualidade-testes-build.md), [05 §P1-4/5](05-frontend-web.md), [04 §P2-6](04-seguranca-lgpd.md)

---

## 4. P1 — próximas duas semanas (agrupado por dor)

### 4.1 A Xarlote responde errado ao paciente
| # | Achado | Onde | Ref |
|---|---|---|---|
| 1 | Guarda de "honestidade de dose" reescreve **qualquer** resposta com anotei/marquei/registrei/salvei se um lembrete tocou nas últimas 3 h — *"Registrei seu sintoma"*, *"Consulta marcada"*, *"Salvei seu endereço"* viram *"você tomou o Losartana?"* ✅ conferido | `inbound-user.ts:2698-2710`, `adesao-ack.ts:79` | [07 §P0-1](07-llm-prompts-tools.md) |
| 2 | `resolvedElsewhere` ignora negação: *"ainda não comprei o remédio, tô esperando você"* **cancela o pedido vivo** e responde "que bom que já resolveu" ✅ conferido | `pharmacy.ts:460-490`, `inbound-user.ts:2176-2199` | [01 §P1-3](01-pipeline-de-entrada.md) |
| 3 | `claim-guard` família `ajuste_de_cotacao` dispara em *"tirei a Losartana da lista dos seus lembretes"* e cola frase sobre "busca automática" | `claim-guard.ts:96,116` | [07 §P1-2](07-llm-prompts-tools.md) |
| 4 | `registro_salvo` não reconhece `save_user_profile_fact`/`save_address`/`set_emergency_contact` como prova → rodada extra + *"Ainda não guardei nada no perfil"* depois de ter guardado | `claim-guard.ts:60` | [07 §P1-3](07-llm-prompts-tools.md) |
| 5 | ~11 caminhos de handler que "falam e retornam" viram `ok:true` + `assistant_tasks.success` → turno seguinte lê "✅ lembrete criado — NÃO recrie" com zero lembretes; `relay_answer_to_establishment` devolve `ok:true` sem ter relayado ("já passei pra farmácia") | `tool-executor.ts:2341-2366,1072-1136,255-260` | [07 §P1-4](07-llm-prompts-tools.md), [01 §P1-7](01-pipeline-de-entrada.md) |
| 6 | `create_reminder` lê `duration_days` que o schema **não declara** → antibiótico "por 10 dias" volta a ser lembrete eterno em modelo que respeita o schema | `tool-executor.ts:2271`, `xarlote-tools.ts:334-380` | [07 §P1-5](07-llm-prompts-tools.md) |
| 7 | Resposta > 4.096 caracteres nunca é dividida → Meta rejeita → 5 tentativas idênticas → mudo justo no laudo longo | `outbound.ts:53-113` | [01 §P1-9](01-pipeline-de-entrada.md) |
| 8 | Tool inventada pelo modelo cai em `default: break` → `ok:true`; args nunca validados (Zod = 0 em tool-executor); `arguments` inválido vira `{}`; `finish_reason: length` não é lido (resposta cortada sai cortada) | `tool-executor.ts:309-344`, `client.ts:363` | [01 §P2-21](01-pipeline-de-entrada.md), [07 §P2-14](07-llm-prompts-tools.md) |
| 9 | Vídeo sem legenda → silêncio; com legenda o modelo não sabe que havia vídeo; figurinha → 2 chamadas de visão; lote de eventos do zpro lê só `[0]`; eco de status `failed` da Meta é descartado (a única prova de rejeição some) | `zpro-normalize.ts:302-353`, `webhook.zpro.ts:103` | [01 §P2-22](01-pipeline-de-entrada.md), [08 §P2-10/11](08-integracoes-resiliencia.md) |
| 10 | Workers proativos (feedback de consulta, estoque, follow-up, nudge, chaser) mandam texto livre fora da janela de 24 h, a Meta rejeita e o worker já marcou "perguntei" — nunca volta | 5 workers, `outbound.ts` sem noção de janela | [08 §P1-5](08-integracoes-resiliencia.md) |
| 11 | 402/401 do OpenRouter: paciente ouve *"já estou avisando o time"* e ninguém é avisado; 4xx são retentados e abrem o breaker para todos | `inbound-user.ts:1562-1590`, `client.ts:412-430` | [07 §P1-7](07-llm-prompts-tools.md) |
| 12 | Lock de turno (espera 150 s / TTL 300 s) não cobre 3 retries × 60 s do cliente LLM (pior caso 183 s só na 1ª chamada; foto = 2 chamadas de visão antes da 1ª palavra); nenhum ack/“digitando” | `inbound-user.ts:382-389,1560`, `client.ts:415-437` | [01 §P1-8](01-pipeline-de-entrada.md), [07 §P2-19](07-llm-prompts-tools.md) |
| 13 | Laudo em PDF chega ao modelo com duas instruções opostas na mesma mensagem (guardar × não guardar); foto de laudo com 0 achados verificados grava todos mesmo assim | `inbound-user.ts:1440`, `ingestao-de-exame.ts:243` | [07 §P1-10/P2-22](07-llm-prompts-tools.md) |
| 14 | Web do paciente mostra "Compra entregue"/"a caminho" para `handed_off` (= repassado à farmácia) para sempre; `humanizeRrule` ignora 2ª hora, `UNTIL` e `COUNT` | `app/saude/page.tsx:43`, `format.ts:100` | [05 §P1-6/P2-7](05-frontend-web.md) |
| 15 | Mobile: "reenviar" gera `clientId` novo e **duplica o turno** (a API diz por escrito que reusar é o caminho); áudio cortado aos 3 min é descartado sem aviso; refresh que falha por rede mostra "sessão expirou"; SSE morto em silêncio; usuário novo cai em modo degradado com polling de 5 s | `use-chat.ts:366`, `use-gravador.ts:101`, `client.ts:81-97`, `stream.ts:138-152` | [06 §P1-4..9](06-app-mobile.md) |

### 4.2 Quebra sob carga / operação
| # | Achado | Ref |
|---|---|---|
| 16 | Fila de saída sem prioridade nem TTL, 1 msg/1,2 s por número (limite pensado pro uazapi): resposta ao paciente entra atrás dos lembretes das 08:00; worker 6 h fora → lembrete das 8h chega às 14h | [02 §A3](02-filas-workers-escala.md), [01 §P1-6](01-pipeline-de-entrada.md) |
| 17 | Dispatcher de lembretes: teto 50/tick, ~12–16 round-trips sequenciais por lembrete (25–65 s > intervalo de 30 s → ticks sobrepostos; contadores de template por tick → 2 templates pagos pro mesmo paciente), recorrente > 45 min de atraso é **pulado em silêncio**; one-shot reivindicado `sent` antes de enfileirar (crash = aviso de consulta perdido) | [02 §B5/C1](02-filas-workers-escala.md) |
| 18 | Worker morto é invisível: `/health` da API não sabe do worker, o anomaly-detector mora dentro dele, `restartPolicyMaxRetries=3` (após 3 quedas o Railway para), sem `unhandledRejection` handler (um `void withCronLock` sem `.catch` derruba o processo), Telegram sem token → alerta depende do zpro que ele vigia | [02 §B4](02-filas-workers-escala.md), [08 §P1-6](08-integracoes-resiliencia.md), [09 §P2-11](09-qualidade-testes-build.md) |
| 19 | 2 réplicas do `api` quebram debounce de fornecedor, throttle de alerta e timers de consolidação (in-process; o código admite) | [02 §B6](02-filas-workers-escala.md) |
| 20 | `queue.add` sem timeout em `enqueueAppInbound`/enricher: Redis fora = request pendurado minutos (não 503) segurando o turn-lock | [02 §B7](02-filas-workers-escala.md) |
| 21 | Rate-limit `INCR`+`EXPIRE` não atômico → chave sem TTL → paciente/IP bloqueado para sempre (3 auditores) | [02 §C2](02-filas-workers-escala.md), [01 §P2-16](01-pipeline-de-entrada.md), [04 §P3-17](04-seguranca-lgpd.md) |
| 22 | Download de mídia sem teto (`axios` sem `maxContentLength`; o limite de 10 MB checa depois) → documento de 100 MB na memória da API; PDF (pdf.js + `inflateSync` até 32 MB) parseado no event loop do processo que atende webhooks | [02 §C3/C4](02-filas-workers-escala.md), [08 §P2-9](08-integracoes-resiliencia.md) |
| 23 | Lab-fetch: `Promise.race` sem cancelar `abrirPortal` → Chromium zumbi (150–300 MB cada) no container que despacha lembretes; `status='rodando'` órfão se o worker morre (credencial cifrada sobrevive; ninguém resgata); `JOB_TIMEOUT` > `lockDuration` | [02 §B3](02-filas-workers-escala.md), [08 §P1-4](08-integracoes-resiliencia.md) |
| 24 | Uma conexão Redis por cliente SSE; SSE sobrevive à revogação e sem teto por usuário | [02 §C7](02-filas-workers-escala.md), [04 §P3-15](04-seguranca-lgpd.md) |
| 25 | Env sem validação no boot: `REDIS_URL` ausente → `localhost` em silêncio (trava e limiter viram locais), `ZPRO_SARA_TOKEN` ausente → modo simulador sozinho, provider ausente → `uazapi` por default | [02 §C8](02-filas-workers-escala.md), [08 §P2-16](08-integracoes-resiliencia.md) |
| 26 | `pnpm dev` (1º comando do CLAUDE.md) sobe workers contra o banco de **produção** (`.env` local aponta o ref de prod, `ROLE` default `all`) — o dispatcher local reivindica lembretes reais e tenta enviar pela instância uazapi antiga | [09 §P1-6](09-qualidade-testes-build.md) |
| 27 | ~203 escritas no Supabase descartam `error` (supabase-js **não lança**; `catch {}` nunca dispara) — inclui o `red_flag_pending` da emergência, claim de lembretes e mensagens de saída | [09 §P1-7](09-qualidade-testes-build.md) |
| 28 | Nada gateia produção: CI só em `main`, deploy = `railway up` do working tree; `security.yml` falharia hoje (3 críticas) | [09 §P2-10](09-qualidade-testes-build.md) |

### 4.3 Banco
| # | Achado | Ref |
|---|---|---|
| 29 | Lost update em JSONB: `users.metadata` tem ≥ 6 escritores read-modify-write (turno, tool, dispatcher, chaser, admin) — recusa de onboarding some, "NUNCA insista" violado; `memory_cards` fora do lock; `consultations.preferences` idem | [03 §P1-8](03-banco-de-dados.md), [01 §P2-14](01-pipeline-de-entrada.md) |
| 30 | Índices ausentes nas consultas quentes: `reminders` sem nenhum índice por `user_id`; `quotes` sem `conversation_id`/`supplier_id` (hot path da farmácia); pollers de `orders`/`consultations`/`consultation_quotes` por status; `conversations(party_type,last_message_at)`; `messages(created_at)` para métricas; 53 FKs sem índice | [03 §P2-12 + mapa](03-banco-de-dados.md) |
| 31 | Compactor de conversas **nunca avança** do primeiro lote (lê sempre as 30 mais antigas) e custa 50 `COUNT(*)`/hora — conversa longa vira 29 mensagens + 8 cards | [03 §P1-7](03-banco-de-dados.md), [07 §P1-8](07-llm-prompts-tools.md) |
| 32 | `webhook_events` (maior tabela, 14 MB, PII crua) sem retenção e `prune_webhook_events()` **quebrada** (insere em coluna inexistente); `otp_codes` sem `user_id` nem poda | [03 §P1-10/P2-17](03-banco-de-dados.md) |
| 33 | Realtime = 54% da CPU do banco com publicação em 9 tabelas que ninguém assina (só `messages`/`quotes` pelo web); 77% das 4 M requisições são pollers devolvendo 0 linhas (`red_flag_pending` 962 k a cada 10 s) | [03 §P2-11/13](03-banco-de-dados.md) |
| 34 | `select('*')` no histórico do LLM (traz `raw_payload`) e em `memory_cards_index` (traz o `embedding` de 1536 floats × 8 por turno); ~150 `await writeLog` síncronos por turno (100–400 ms de latência só de log) | [03 §P2-14/15](03-banco-de-dados.md), [01 §P2-19](01-pipeline-de-entrada.md) |
| 35 | `audit_log`/`event_log`/`consent_events` com `user_id ON DELETE CASCADE` e sem proteção contra UPDATE/DELETE (37 updates / 51 deletes já aconteceram) | [03 §P2-16](03-banco-de-dados.md) |
| 36 | Drift repo × produção: `query_user_360` em prod usa `onset_date`, a migration 0004 usa `c.since` (reaplicar quebra); enum `order_status_t` tem `completed` só em prod; migrations 0008–0010 e 0027 não existem; `packages/db/src/types.ts` não existe → toda row é `any` (foi o que deixou o export vazio passar) | [03 §P2-19](03-banco-de-dados.md), [09 §P2-12](09-qualidade-testes-build.md) |
| 37 | Invariantes "um pedido ativo por paciente"/"uma conversa por JID" só protegidos por lock fail-open (check-then-insert); `orders.created_at` reescrito como relógio de estado em 3 lugares; `reminders.updated_at` sem trigger | [03 §P1-9/P2-21](03-banco-de-dados.md) |

### 4.4 Segurança e LGPD (além do P0-2)
| # | Achado | Ref |
|---|---|---|
| 38 | Login do dashboard sem rate limit/lockout: uma senha protege o token que apaga o banco e lê tudo | [04 §P1-1](04-seguranca-lgpd.md) |
| 39 | Resgate de código de cuidado compara contra **todos** os convites abertos e gasta tentativa em cada um: 6 chutes de qualquer conta esgotam os convites de todo mundo | [04 §P1-2](04-seguranca-lgpd.md) |
| 40 | Senha do portal do laboratório persiste em claro em `messages.content`/`transcript`, na foto (bucket público) e no histórico enviado ao LLM — a tool diz "não guardo a senha" | [04 §P1-3](04-seguranca-lgpd.md), [08 §P1-7](08-integracoes-resiliencia.md) |
| 41 | Webhooks fail-open sem segredo (`ZPRO_WEBHOOK_SECRET`/`UAZAPI_WEBHOOK_SECRET` opcionais; uazapi ainda registrado) + `fetchInboundMedia` sem allowlist de host e reenviando o Bearer do zpro a host arbitrário (SSRF + vazamento de token); o segredo do webhook vai na query e é **logado em `info`** a cada mensagem | [08 §P1-8](08-integracoes-resiliencia.md), [09 §P1-5](09-qualidade-testes-build.md), [04 §P2-7](04-seguranca-lgpd.md) |
| 42 | `POST /app/messages` sem rate limit (turno de LLM por request); OTP com lockout dirigido (só o último código vale) e bomba de template pago sem teto global; `trustProxy: true` (XFF forjável — não confirmado o edge do Railway); PIN do médico com contador não atômico | [04 §P2-5/8/9/10/11](04-seguranca-lgpd.md) |
| 43 | `GET /admin/prompts` devolve chaves OpenRouter/ElevenLabs em claro ao navegador a cada 30 s em toda página; `NEXT_PUBLIC_ADMIN_API_TOKEN` como fallback no bundle público | [04 §P2-6/12](04-seguranca-lgpd.md), [05 §P1-5](05-frontend-web.md) |
| 44 | Dependências: `next@14.2.35` (2 RCE críticos, patch só na linha 15), `fastify@4.29.1` EOL, `axios` (prototype pollution), `playwright` (TLS), `ws`, `form-data`; 3 chaves OpenRouter no histórico git de um repo que já foi público | [04 §P2-4/13](04-seguranca-lgpd.md), [09 §P0-2/P2-9](09-qualidade-testes-build.md) |
| 45 | CPF, nascimento, telefone e endereço completo no system prompt dos agentes de farmácia/clínica, enviados ao provedor sem `data_collection: 'deny'`/ZDR; `HTTP-Referer`/User-Agent apontando para `iadasaude.com` (hoje de terceiro) | [04 §P2-14](04-seguranca-lgpd.md), [07 §P3-24](07-llm-prompts-tools.md) |
| 46 | Dado clínico em log `info` (80 chars da mensagem/transcrição/resposta); Sentry não raspa `exception.value` (corpo de erro do zpro com número); jobs concluídos com telefone + texto (e OTP) retidos no Redis por contagem, não por idade — e o forget-me não toca o Redis | [07 §P2-20](07-llm-prompts-tools.md), [08 §P2-12/P3-22](08-integracoes-resiliencia.md), [02 §C5](02-filas-workers-escala.md) |
| 47 | Mobile: cache MMKV com o prontuário em claro entra no backup automático do Android (`allowBackup` default `true`) | [06 §P1-10](06-app-mobile.md) |

### 4.5 Dashboard e web
| # | Achado | Ref |
|---|---|---|
| 48 | Tela de conversa mostra as 200 mensagens **mais antigas** (conversa longa parece parada); lista = só 20 conversas sem aviso; users/orders/suppliers cortados em 200/50/100 sem paginação | [05 §P1-2/3](05-frontend-web.md) |
| 49 | Nascimento e início de tratamento com off-by-one de `DATE`; `/logs` rola para o log mais antigo; simulador e "responder como farmácia" anunciados em prod onde respondem 404; interruptor mestre sem confirmação; contadores das abas calculados sobre a lista filtrada | [05 §P2-8..11/P3-24](05-frontend-web.md) |
| 50 | Sem header de segurança em nenhuma rota (iframe/clickjacking); open redirect `//` no login; polling de 5 s sem pausa em aba oculta nem guarda de requisição em voo; ~720 KB de JS no `/app` (supabase-js inteiro); 9 blobs desfocados em loop + `box-shadow` animado em celular fraco | [05 §P2-13..17/P3-18](05-frontend-web.md) |

### 4.6 App mobile (além do P0-7 e do item 15)
| # | Achado | Ref |
|---|---|---|
| 51 | Upload de mídia sem timeout/cancelamento (compositor trava em "Enviando…" e bloqueia o texto); foto sobe sem redimensionar (5–7 MB de base64 no heap) | [06 §P1-9/P2-18](06-app-mobile.md) |
| 52 | `consentRequired` do `/app/me` nunca é consumido — no próximo bump da política, quem já está logado fica preso (428 em todo envio) | [06 §P1-11](06-app-mobile.md) |
| 53 | Push **não existe** no app (`lib/push.ts` morto, `POST_NOTIFICATIONS` declarado sem uso); sem `ErrorBoundary` nem crash report (tela "Something went wrong" em inglês); React Query sem `focusManager`/`onlineManager` (volta do background não atualiza); OTA só checa no cold start | [06 §P2-14..17](06-app-mobile.md) |

---

## 5. P2/P3 — melhorias com retorno claro (resumo)
- **Custo/latência de LLM:** mover o bloco dinâmico (`## AGORA` com minuto, contexto, lembretes) para **depois** do histórico → cache de ~24k para ~28k dos ~30k tokens ≈ **−27% no input** (validar obediência com o benchmark); cortar a seção "FERRAMENTAS, quando usar" (≈5,5k tokens que duplicam as descrições das tools); remover 2 tools no-op (`query_my_addresses`, `request_user_location`); enricher com debounce por conversa (hoje re-extrai cada fato ~3×) e sem ativar medicamento por inferência; só a 1ª rodada de cada turno emite `llm.completion` (30–50% do gasto invisível ao teto de custo). Projeção: ≈ $7/mês hoje, ≈ $165/mês a 2 k msgs/semana, ≈ $1.650/mês a 20 k. — [07 §3/5](07-llm-prompts-tools.md)
- **Prompt cache & modelo de foto:** todo turno com foto (e os 20 min seguintes) roda no modelo que perde tool calls, embora a ingestão já produza a leitura em texto — rodar o turno no primário com a descrição como texto, reservando a visão só quando a ingestão falha. — [07 §P1-11](07-llm-prompts-tools.md)
- **Memória:** cards contraditórios sem data; supersede troca `self_reported` por inferência; a flag "(incerto)" nunca aparece. — [07 §P2-21](07-llm-prompts-tools.md)
- **Agentes de farmácia/clínica** instruídos a "não mencionar IA" — contradiz a regra 2 do CLAUDE.md (decisão de produto). — [07 §P1-12](07-llm-prompts-tools.md)
- **Arquitetura:** `processInboundUserInner` = uma função de 2.413 linhas (~60 `let` compartilhados); `tool-executor.ts` 3.208 linhas — índice e proposta de divisão em `handlers/inbound/*` e `handlers/tools/*` sem mudar comportamento, com prova de equivalência por sequência de logs/tools em 5 turnos do simulador. — [09 §4](09-qualidade-testes-build.md)
- **Duplicação web↔mobile** (18 basenames iguais: `use-chat`, `OrbNav`, `glass-*`, formatadores) → `packages/ui-logic` headless; `packages/core` (26 linhas usadas) fundir em `shared`; helpers mortos em `db/queries.ts`, `whatsapp/client.ts`; `native/` (Capacitor) e `@capacitor/*` no web superados pelo Expo. — [09 §P3-19..21](09-qualidade-testes-build.md), [05 §P3-22](05-frontend-web.md), [06 §P3-25](06-app-mobile.md)
- **Plataforma:** Node 20 EOL (sem `.nvmrc`, prod não fixado); `nixpacks` compila `dist/` que ninguém usa (prod roda `tsx src/server.ts` com `--no-frozen-lockfile`); `loadPrompts()` faz I/O síncrono em 31 call-sites; `tests/` nunca passa pelo `tsc` (7 erros reais escondidos); scripts em `scripts/` chamam RPC `exec_sql` inexistente apontando para prod, e `prod_rest.py` faz PATCH/DELETE sem confirmação. — [09 §P3](09-qualidade-testes-build.md)
- **Docs drift:** CLAUDE.md ainda diz Sara/uazapi/`gpt-4.1-mini`/`gpt-4o-audio-preview`/§11 (o log é o §9)/`types.ts` inexistente; README de abril; `PROJECT_STATE.md` 125 KB com o estado real no meio do §9. — [09 §P3-22](09-qualidade-testes-build.md)
- **Acessibilidade e UX:** contraste `text-white/30` sobre `#04041a` abaixo de 4,5:1; Drawer sem `role="dialog"`/focus-trap; botão 192 com ~24 px de altura no chat web; "cancelar" lembrete a 28 px de "feito", definitivo e sem desfazer. — [05 §P2-12/P3-19](05-frontend-web.md)

---

## 6. Plano de execução sugerido

| Quando | O quê | Esforço |
|---|---|---|
| **Hoje** | `git push -u origin fix/auditoria-set` (P0-1) · bloquear `/app` web + migration `0034` (drop anon + revoke + bucket privado) (P0-2) · pedir aprovação do template HSM `contato_emergencia` na Meta (P0-4) · confirmar `ZPRO_WEBHOOK_SECRET`, `NODE_ENV=production`, `TELEGRAM_BOT_TOKEN` e volume de `apps/api/data` no Railway | 2 h |
| **Semana 1** — paciente protegido | Forget-me (guarda pura + FK + fios de clínica + reordenação + retry do job + colunas do export) (P0-3) · Emergência: rótulos, `throwOnError`, escalator lê `user_response`, `EMERGENCY_RE` com suicídio/overdose, aviso pela fila com texto honesto até o template sair (P0-4) · Mobile cuidador (3 correções, OTA) (P0-7) · `/prompts` (`undefined` filtrado + web salva diff + chaves mascaradas) (P0-8) · Fila de saída: classificação de erro, `duplicate` consulta `delivery_status`, `enableOfflineQueue:false` + `jobId: sendToken`, dispatcher carimba `queued` (P0-5) · Conversa: gate da guarda de dose, negação em `resolvedElsewhere`, `PROVAS.registro_salvo`, `duration_days` no schema, `ToolFailure` nos 11 caminhos "fala e retorna" (itens 1–6) | 5 dias |
| **Semana 2** — robusto sob carga | Turno durável: rastreio em voo + `forceCloseConnections` + `try/catch` externo + `insertMessage` idempotente; depois webhook → fila `INBOUND_USER` consumida pelo worker (P0-6) · Prioridade + TTL na fila e `WA_RATE_*` por provedor (16) · Observabilidade: heartbeat do worker no `/health` da API, `unhandledRejection`, alerta em 401/402/fila parada, `restartPolicyMaxRetries`, Telegram (18) · Banco: índices, compactor, `prune_webhook_events` + cron, publicação realtime enxuta, RPC `users_metadata_merge`, unique parcial em `orders`, FKs de auditoria `restrict` (29–37) · Lab-fetch: fechar browser no timeout, resgatar `rodando`, `lockDuration` (23) · Config de runtime compartilhada API+worker (P0-8b) | 8 dias |
| **Semana 3** — segurança e dívidas | Rate limit no login do dashboard e em `/app/messages`; resgate de convite por alvo; redigir senha do portal na mensagem-fonte; segredo do webhook obrigatório + fora do log + allowlist de host na mídia; `trustProxy: 1`; OTP aceita qualquer código válido + teto global; deps (`axios`, `playwright`, `ws`, `form-data` agora; Next 15 e Fastify 5 planejados) (38–47) · Web: ordem/paginação da conversa, `handed_off`, rrule, DATE, headers (48–50) · Mobile: reenvio com mesmo `clientId`, refresh por rede, SSE, áudio 180 s, upload com timeout, `allowBackup:false`, `consentRequired` (15, 51–53) · Validação de env no boot + `pnpm dev` seguro + CI em todo branch + `scripts/deploy.sh` que exige typecheck+test (25–28) | 8 dias |
| **Depois** | Prompt cache (bloco dinâmico após o histórico), tools mortas, enricher com debounce, `llm.completion` em toda chamada · modularização dos 2 arquivos gigantes · `packages/ui-logic` · tipos gerados do banco + baseline `0000` · docs (CLAUDE.md, README, PROJECT_STATE enxuto) | contínuo |

Tudo acima segue os padrões do repo (guarda pura em `packages/shared` + teste vitest; handler orquestra; migration idempotente que derruba constraint pelo conteúdo, não pelo nome).

---

## 7. Decisões que só o fundador pode tomar
1. **`/app` web:** ainda há paciente usando `xarlote.com.br/app`? Se não, o bloqueio é imediato; se sim, o cutover para OTP precisa de aviso.
2. **Cuidador:** pode confirmar/adiar/cancelar o lembrete da pessoa cuidada? E "falar com a Xarlote" em nome dela — bloquear na bolsa alheia ou abrir `POST /messages?subject=` com a persona sabendo quem fala por quem?
3. **Emergência:** aprovar o template HSM `contato_emergencia` na Meta (categoria utilidade) e definir o texto.
4. **Agentes de farmácia/clínica:** manter "sem mencionar IA" (contradiz a regra 2 do CLAUDE.md) ou alinhar ("sou uma assistente virtual da Xarlote")?
5. **Cota WABA** do número (tier) para dimensionar `WA_RATE_MAX` sem risco.
6. **Railway:** `ROLE` real do service `api` (ainda `all`?), grace de SIGTERM, número de réplicas, volume em `apps/api/data`, `restartPolicyMaxRetries`, Redis com persistência?
7. **zpro:** deduplica por `externalKey`? emite eco de status `failed` com código da Meta? manda array de eventos? aceita segredo em header?
8. **Chaves OpenRouter do histórico git** (`b485…`, `7c2c…`, `0543…`): todas revogadas? Repo segue privado e sem forks?
9. **`xarlote-audio` público** (o zpro só aceita URL): aceita poda por idade (24 h–7 d) e registro do path na mensagem?
10. **Retenção:** `assistant_tasks` (args das tools) e `webhook_events` — prazo? O forget-me deve anonimizar `audit_log.metadata` mantendo `action/occurred_at`?
11. **Next 15 / Fastify 5:** janela para as migrações de major (as críticas do Next não têm patch na linha 14).
12. **Nome do saldo:** o saldo da OpenRouter estava em US$ 4,55 em 21/09 — recarga e auto-recarga (independente desta auditoria, mas é o que derruba a Xarlote primeiro).
