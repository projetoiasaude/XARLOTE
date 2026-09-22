# LLM, prompt, tools, guardas e custo

> Relatório integral do especialista (auditoria read-only de 21–22/09/2026, base `b981a3d`). Consolidação e priorização cruzada em [`00-CONSOLIDADO.md`](00-CONSOLIDADO.md).

---

# Auditoria READ-ONLY — cliente LLM, prompt, tools, loop, guardas e custo (Xarlote)

Escopo lido integralmente: `packages/llm/src/{client,embeddings,pricing,utils/history}.ts`, os 5 prompts, as 3 listas de tools, `apps/api/src/handlers/{inbound-user,tool-executor,tool-executor-v2 (parcial),ingestao-de-exame,verificar-nome-remedio,clarification (parcial),inbound-supplier (parcial),agent-clinic (parcial),order-state (parcial)}.ts`, `config/prompts.ts` + `data/prompts.json` (chave do LLM **ausente** no arquivo local; chave do ElevenLabs **presente**, arquivo está no `.gitignore`), `packages/shared/src/{claim-guard,reminder-body,adesao-ack,nome-remedio,busca-agendada,documento-de-exame,circuit-breaker}.ts`, `packages/db/src/memory.ts` + SQL 0031, os 4 workers, `integrations/transcription.ts`. Nenhum arquivo do repo foi alterado; nenhuma API foi chamada; os únicos artefatos são 2 scripts de verificação de regex/contagem em `scratchpad/agente-llm/`.

---

## 1. Visão geral

O núcleo é sólido em várias frentes que costumam quebrar: timeout com `AbortController`, validação Zod, cadeia de fallback ciente de modalidade, `model` reportando quem atendeu, correção de typo de tool, loop ReAct com teto de rodadas e orçamento de tempo, resultados de tool compactos (`{ok,note,spoke,error}`), e um arsenal de guardas pós-resposta nascido de incidentes reais. O prompt cache funciona (≈24k dos ≈30k tokens vêm cacheados) porque o prefixo estático (regras + tools) vem antes do dinâmico.

Os problemas que encontrei são majoritariamente **as guardas mordendo resposta legítima** (a mais grave reescreve a resposta inteira quando um lembrete tocou nas últimas 3h e a Xarlote diz "anotei/marquei/salvei" sobre QUALQUER coisa), **falha virando sucesso** em ~11 caminhos de handler que falam com o paciente e retornam `ok:true` (e viram "✅ feito" no turno seguinte), **um campo lido pelo executor que o schema não declara** (`duration_days` do `create_reminder`), **emergência de suicídio/overdose dependendo só do modelo**, **402/401 sem alerta ao fundador** (com a Xarlote prometendo "já estou avisando o time"), **o compactor travado nas 30 primeiras mensagens** e **custo/latência sub-reportados** (só a 1ª rodada de cada turno é medida; o agente da farmácia nunca emite evento). Há ainda ~30% do custo do input recuperável reposicionando o contexto dinâmico para depois do histórico.

---

## 2. Achados

### P0

**1. Guarda de "honestidade de dose" reescreve QUALQUER resposta com anotei/marquei/salvei/registrei quando um lembrete tocou nas últimas 3h** · BUG · UX
`apps/api/src/handlers/inbound-user.ts:2698-2710` + `packages/shared/src/adesao-ack.ts:76-80`
```ts
if (replyText && !doseRegistradaNoTurno && anunciouRegistroDeDose(replyText)) {
  if (!lembretesRecentesTitulos.length) { /* busca reminders com last_run_at >= now-3h */ }
  if (lembretesRecentesTitulos.length) { …; replyText = falaHonestaDeDose(lembretesRecentesTitulos); }
}
// adesao-ack.ts:79
return /\b(anotad[oa]|anotei|marcad[oa]|marquei|registrad[oa]|registrei|guardei|salvei)\b/.test(f);
```
Não há nenhuma checagem de que a mensagem do paciente foi um *ack* de dose (o registro em 11e usa `classificarAckDeDose`; a reescrita não). Cenário real e frequente: paciente com Losartana às 8h; às 9h30 escreve "tô com dor de cabeça forte desde ontem" → modelo chama `log_symptom` (ok) e escreve *"Registrei aqui. Pra dor de cabeça simples, dipirona 1g resolve, quero cotar?"* → sai **"Só pra eu registrar certinho: você tomou o *Losartana*? Me responde *tomei* que eu marco aqui 💙"**. Mesmo destino para *"Consulta marcada pra quinta às 10h"*, *"Salvei seu endereço como casa"*, *"Anotei sua alergia"*. Com 2-3 lembretes/dia, a janela de 3h cobre metade do dia.
**Correção:** gatear a reescrita em `classificarAckDeDose(textoDoPaciente)` (forte/genérico/fraco) **e** trocar só a oração que anuncia registro (`semAnuncios`-style), não a resposta inteira; testar os negativos ("Consulta marcada", "Salvei seu endereço", "Registrei seu sintoma"). Esforço: 2h. Confiança: alta (regex reproduzida).

### P1

**2. `claim-guard` família `ajuste_de_cotacao` dispara em "tirei X da lista" fora de cotação e cola uma frase sobre "busca automática"** · BUG · UX
`packages/shared/src/claim-guard.ts:96,116` · `inbound-user.ts:2597-2608`
```ts
ajuste_de_cotacao: /…\b(?:ajustei|tirei|removi|corrigi|refiz|arrumei)\b[^.!?]{0,30}\b(?:cotacao|…|item|itens|lista|…)\b|\b(?:tir[oa]|tirar|remov[oa]|remover)\b[^.!?]{0,20}\bda\s+(?:cotacao|lista|opcao)\b/
```
Reproduzi: `"Pronto, tirei a Losartana da lista dos seus lembretes 💙"` → **true**; `"Posso remover esse item da sua lista de remédios em uso?"` → **true**. Como a prova da família é só `start_pharmacy_order|cancel_order`, um `cancel_reminders` ok não salva. Resultado ao paciente: oração derrubada + *"Esse item entrou por engano na minha busca automática, pode desconsiderar 🙏 Se quiser, eu refaço a cotação só com os remédios da receita"* numa conversa de lembretes. O comentário em `inbound-user.ts:2594-2596` ("as frases são específicas") não vale para este regex.
**Correção:** exigir objeto de cotação (`cotacao|cotacoes|opcao|opcoes|busca`) nas três alternativas (tirar `lista|item|itens|pedido`), e só rodar esta família com `orderState` vivo. Esforço: 1h. Confiança: alta.

**3. `registro_salvo` não reconhece `save_user_profile_fact`/`save_address`/`set_emergency_contact` como prova → rodada extra + "Ainda não guardei nada no perfil" após ter guardado** · BUG · UX
`claim-guard.ts:60` (`registro_salvo: ['save_exam_result','parse_prescription_image','log_medication_taken','log_symptom']`) · `inbound-user.ts:1757-1795` (rodada de correção) e `2578-2591` (derruba a oração)
Com arquivo nas últimas 6 mensagens (`contextoDeArquivo`), *"sua alergia já está registrada"* / *"salvei no seu perfil"* depois de `save_user_profile_fact` ok cai em `suspect` → 1 chamada extra ao modelo (a mensagem de correção lista `save_user_profile_fact` como ferramenta de registro, contradizendo `PROVAS`) → se ele mantém a frase, sai **"Ainda não guardei nada no perfil, tá?"** — o contrário da verdade. Cenário: foto da caixa → "sim, cadastra, e sou alérgico a dipirona".
**Correção:** incluir `save_user_profile_fact`, `save_address`, `set_emergency_contact`, `save_exam_result` (sintético da ingestão já entra) em `PROVAS.registro_salvo`. Esforço: 15 min + teste. Confiança: alta.

**4. Handlers que "falam e retornam" viram `ok:true` + `assistant_tasks.success` sem efeito — e o turno seguinte lê "✅ feito"** · BUG (falha vira sucesso)
`tool-executor.ts:2341-2366` (one-shot no passado / sem horário → `sendOutbound(); return;`), `2540-2548` (INSERT falhou → avisa e cai no fim da função), `1072-1087`, `1133-1136` (`start_pharmacy_order` sem pedido criado), `tool-executor-v2.ts:670-673`; contabilidade em `tool-executor.ts:314` e leitura em `inbound-user.ts:1110-1128`
```ts
await sendOutbound(ctx.conversationId, ctx.phoneE164, `Hmm, esse horário pra "${titleForMsg}" já passou 😅 …`, ctx.traceId);
return;   // → handleToolCall grava status:'success' e devolve {ok:true}
```
Consequências: (a) `executedToolCalls[].ok=true` desliga `toolRanOk('create_reminder')` e o `reallyContacted` (`start_pharmacy_order` está na lista); (b) no turno seguinte o bloco "O QUE VOCÊ JÁ FEZ" diz *"✅ lembrete(s) criado(s) — NÃO recrie"* enquanto "LEMBRETES ATIVOS (0)" diz que não há nenhum — o modelo recebe dois fatos contraditórios exatamente quando o paciente corrige o horário. A voz única (contagem por `trace_id`) esconde a 2ª voz no turno, mas não conserta a contabilidade.
**Correção:** transformar esses caminhos em `throw new ToolFailure(...)` (já é a escola do arquivo) mantendo o `sendOutbound` + `suppressLlmText=true`; ou devolver `ok:false` com `spoke:true`. Esforço: 3h (11 caminhos). Confiança: alta.

**5. `create_reminder` lê `duration_days`, mas o schema não declara o campo** · BUG
`tool-executor.ts:2271,2386` (`const dur = Number(args.duration_days)`) vs `packages/llm/src/tools/xarlote-tools.ts:334-380` (properties: `type,title,body,event_at,scheduled_at,dia_do_mes,rrule,depends_on_title`; `duration_days` só aparece em prosa nas descrições de `rrule`/`body` e no prompt `xarlote.system.ts:473`). `duration_days` só está declarado em `start_treatment_from_order` (:444).
Modelo que respeita o schema (OpenAI em modo estrito, e cada vez mais os demais) não envia campo não declarado → antibiótico "por 10 dias" sem `COUNT` volta a ser lembrete eterno (o incidente do Levofloxacino). `PROJECT_STATE` afirma que "create_reminder lê duration_days" como se estivesse resolvido.
**Correção:** declarar `duration_days: {type:'integer', minimum:1, maximum:366}` no schema; adicionar teste que compara chaves lidas pelo handler × declaradas (regra 111). Esforço: 30 min. Confiança: alta.

**6. Emergência determinística não cobre suicídio/automutilação/overdose — depende do modelo; `EMERGENCY_KEYWORDS` é código morto** · SEGURANÇA
`inbound-user.ts:1649` (`EMERGENCY_RE = /(dor no peito|aperto no peito|falta de ar|…|sangrando muito|dor de cabeça … forte)/i`) · `packages/shared/src/constants.ts:118-122` (`EMERGENCY_KEYWORDS` com "suicídio", "overdose" — nenhum call-site no `apps/api`).
"quero me matar" / "tomei a cartela inteira" só viram botões do SAMU se o modelo chamar `red_flag_check`. O benchmark interno mostra o fallback (`gpt-4.1-mini`, que também atende TODO turno com foto) perdendo tool calls; num dia de fallback, ideação suicida fica sem protocolo. O `log_symptom` tem lista própria (`tool-executor-v2.ts:561-563`), mas só se o modelo chamar essa tool.
**Correção:** estender a preempção com padrões conservadores de `suicide_ideation|self_harm|overdose` (com `PASSADO_RE`/`TERCEIRO_RE`), categoria correta em vez de `other_critical`; apagar ou usar `EMERGENCY_KEYWORDS`. Esforço: 2h + testes. Confiança: alta.

**7. 402/401/circuito aberto: o paciente ouve "Já estou avisando o time" e ninguém é avisado; 4xx são retentados e abrem o breaker para todos** · BUG · RISCO SOB CARGA
`inbound-user.ts:1562-1590` (`userMsg = 'Opa, tive um problema técnico… Já estou avisando o time pra resolver.'` — só `writeLog('error')`, sem `sendFounderAlert`) · `client.ts:412-430` (retenta qualquer erro: `attempt >= maxAttempts` é o único freio; 400/401/402 ganham 1s+2s) · `client.ts:407` + `circuit-breaker.ts:95-96` (todo erro conta) · `anomaly-detector.worker.ts:47-458` (nenhum detector de erro de LLM).
Com saldo baixo no OpenRouter (contexto atual), o cenário é: crédito acaba → 3 tentativas × N pacientes → breaker abre 30s → todos recebem "Tive um probleminha… pode repetir?" em loop; o fundador descobre pelo "Conversas paradas", horas depois. É promessa sem ferramenta feita pelo próprio servidor.
**Correção:** (a) não retentar 400/401/402/403/404/422 e não contá-los no breaker; (b) honrar `Retry-After` em 429; (c) `sendFounderAlert` (crítico, com dedupe de 15 min) em 401/402/CircuitOpen; (d) trocar o texto por um que não prometa aviso. Esforço: 3h. Confiança: alta.

**8. Compactor nunca avança além das 30 primeiras mensagens** · BUG (memória)
`apps/api/src/workers/conversation-compactor.worker.ts:68-79,120`
```ts
.order('created_at', { ascending: true }).limit(COMPACTION_BATCH_SIZE)   // sempre as 30 MAIS ANTIGAS
const notYetCompacted = oldMsgs.filter(m => !raw?.compacted_at);
if (notYetCompacted.length < 10) continue;                                // após a 1ª rodada: 0 → pula pra sempre
```
`inbound-user.ts:775-781` promete o oposto ("O que sai desta janela não se perde: o compactor condensa"). Conversa de 2.000 mensagens: o modelo vê 29 mensagens + top-8 cards; entre a msg 31 e a 1.970 só sobrevive o que o enricher extraiu por turno.
**Correção:** filtrar `raw_payload->>compacted_at is null` na query (ou paginar por `created_at > último compactado`). Esforço: 30 min. Confiança: alta.

**9. Custo e latência sub-reportados: só a 1ª rodada emite evento; o agente da farmácia nunca emite** · OTIMIZAÇÃO · QUALIDADE
`inbound-user.ts:1591-1605` (único `writeEvent('llm.completion')`), `1868-1870` (rodadas ≥2 só `writeLog`), `1785`, `2247-2257`, `2634-2642` (correção, retry de lembrete, follow-up só-tool: nada), `ingestao-de-exame.ts:109,139`, `profile-enricher.worker.ts:134-155`, `inbound-supplier.ts:370-379` (sem `writeEvent`; `agent.completion` só existe nas queries de `metrics-aggregator.worker.ts:121`). Estimo 30-50% do gasto real fora do teto `LLM_COST_HOURLY_USD_LIMIT` e do p95. Já é a família "reporte quem atendeu".
**Correção:** emitir `llm.completion` em todo `chat()` bem-sucedido (dentro do client, com `phase`), e `agent.completion` no supplier. Esforço: 2h. Confiança: alta.

**10. Laudo em PDF chega ao modelo com duas instruções opostas na MESMA mensagem** · QUALIDADE
`inbound-user.ts:1440-1443` monta `blocoDeIngestaoParaModelo(...) + '\n\n' + blocoDoc`; `documento-de-exame.ts:198` diz *"Você NÃO precisa chamar save_exam_result nem perguntar se ele quer guardar"*; `inbound-user.ts:235` (dentro de `blocoDoc`) diz *"OFEREÇA guardar no perfil dele; se ele confirmar, chame save_exam_result"*; a descrição da tool (`xarlote-tools.ts:98`) diz *"SÓ chame DEPOIS de o paciente CONFIRMAR"*. Se o modelo segue a 2ª, `save_exam_result` recusa (`tool-executor.ts:621`) e o turno perde uma rodada; se pergunta "quer que eu guarde?", contradiz o que o servidor já fez.
**Correção:** omitir a frase de "OFEREÇA guardar" quando `ingestaoDoTurno.tipo === 'laudo'`. Esforço: 20 min. Confiança: alta.

**11. Todo turno com foto (e os 20 min seguintes) roda inteiro no modelo que perde tool calls, embora a ingestão já produza a leitura em texto** · QUALIDADE
`inbound-user.ts:1541-1545` (`model = isMultimodal ? vision_model : llm_model`), `1500-1520` (re-anexo de fotos por 20 min), `ingestao-de-exame.ts:137-160` (descrição objetiva ≤900 chars + marcadores). O benchmark citado (32/33 × 25/33) mostra exatamente as perdas que doem: lembrete não criado, dose não registrada, substituto descartado. Hoje a foto é paga duas vezes (ingestão + turno) e a conversa cai de modelo justamente quando exame/receita pedem ferramenta.
**Correção (opção A):** rodar o turno no primário com a descrição/marcadores da ingestão como texto (sem `image_url`), reservando a visão para o caso em que a ingestão falhou; **(opção B)** adotar um modelo com visão e boa chamada de ferramenta como `vision_model`. Medir com os 11 casos do benchmark. Esforço: 1 dia. Confiança: média.

**12. Agentes de farmácia/clínica instruídos a evadir "é robô/IA?" — contradiz a regra 2 do CLAUDE.md e se contradizem internamente** · SEGURANÇA · QUALIDADE
`agent-pharmacy.system.ts:109,245` (*"seja simples e honesta, **sem mencionar IA**"*), `agent-clinic.system.ts:225,319`; `agent-pharmacy.system.ts:104,240` (*"Emoji: NUNCA (zero)"*) vs. exemplo com 🙂 na própria regra 9 e no Caso A1.
É omissão deliberada diante de pergunta direta — o CLAUDE.md diz "nunca finja que é humana se perguntada". Regras que se contradizem (emoji) geram comportamento instável.
**Correção:** decisão de produto do fundador; ao menos alinhar o texto ("sou uma assistente virtual da Xarlote") e limpar os exemplos com emoji. Esforço: 30 min. Confiança: alta (é texto).

### P2

**13. `cancel_reminders(title_query)` emitido depois de `create_reminder` do mesmo título, na mesma rodada, cancela o recém-criado** · RISCO
`inbound-user.ts:1799-1815` (executa na ordem emitida), `tool-executor.ts:2591-2700` (sem exclusão de ids criados no turno; existe `ordersCreatedThisTurn` para pedidos, `tool-executor.ts:113-121`, não para lembretes). Cenário: "muda a Nimesulida pra 8h e 20h" → `[create, create, cancel("Nimesulida")]` → 0 lembretes; o modelo só percebe pela `note` se ainda houver rodada.
**Correção:** `remindersCreatedThisTurn: Set<id>` no ctx, excluído em `aCancelar`. Esforço: 1h. Confiança: alta.

**14. `arguments` inválido vira `{}` em silêncio; `finish_reason` nunca é lido** · BUG
`client.ts:363` (`try { return JSON.parse(...) } catch { return {} }`), schema Zod `client.ts:166-198` sem `finish_reason`. Tool roda sem args (ex.: `create_reminder {}` cai no caminho do achado 4) e resposta cortada por `max_tokens` sai cortada (o "…e outro de" já aconteceu). **Correção:** devolver `{ok:false, error:'argumentos inválidos'}` ao modelo sem executar; ler `finish_reason==='length'` e, se sem tools, pedir continuação curta ou aparar na última pontuação. Esforço: 1h. Confiança: alta.

**15. Contexto dinâmico antes do histórico impede cachear o histórico (~4-6k tokens frescos por turno)** · OTIMIZAÇÃO
`xarlote.system.ts:539-558` (AGORA com minuto + CONTEXTO), `inbound-user.ts:946-1175` (LEMBRETES, ESTADO DO PEDIDO, O QUE VOCÊ JÁ FEZ, user360, memória — tudo no `system`), `client.ts:389-401` (system → history → user). Como o cache é por prefixo, qualquer mudança nesses blocos invalida o histórico (que é append-only e cachearia bem). Mover o bloco dinâmico para uma 2ª mensagem `system` após o histórico (ou para o prefixo da mensagem do usuário) leva o cache de ~24k para ~28k dos ~30k: ≈ −27% no custo do input principal (cálculo na seção 5). **Risco:** obediência a regras "de estado" colocadas depois do histórico — validar com o benchmark. Esforço: meio dia. Confiança: média.

**16. Tools mortas/ambíguas e campos descartados** · QUALIDADE
`xarlote-tools.ts:512-522` `query_my_addresses` "Devolve a lista de endereços" → `tool-executor.ts:274-277` não faz nada e não seta `note` (o modelo recebe `{ok:true}` vazio); `:63-72` `request_user_location` no-op (`tool-executor.ts:191-193`); `:12-14` enum de `save_user_profile_fact.category` inclui `'address'` que o prompt proíbe (`xarlote.system.ts:417`); `:46-49` `confidence` aceito e nunca lido (`tool-executor.ts:395-492`); `:707` `phone_e164: "Converta"` vs prompt `:338` "A tool normaliza". **Correção:** remover as 2 tools no-op (≈300 tokens e menos confusão), tirar `'address'` do enum, remover `confidence`, alinhar `phone_e164`. Esforço: 1h. Confiança: alta.

**17. Enricher em todo turno com janela sobreposta, só INSERE (nunca nega) e ativa medicamento por inferência** · OTIMIZAÇÃO · UX
`inbound-user.ts:2800-2820` (6 msgs por turno → cada fato re-extraído ~3×), `profile-enricher.worker.ts:229-245` (`user_medications.insert({active:true, source:'inferred'})`), sem caminho para "não sou alérgico"/"parei". "Quanto custa a sertralina?" a 0,7 de confiança pode virar "Medicamentos em uso: sertralina" e a Xarlote passa a assumir ("sua Sertralina de sempre?"). **Correção:** debounce por conversa (rodar 2-3 min após a última mensagem, janela = mensagens desde o último job); marcar medicamentos inferidos como `active:false`/"a confirmar" e só ativar por `save_user_profile_fact`; permitir negação (`allergies_denied`). Esforço: meio dia. Confiança: média-alta.

**18. Texto derivado de terceiros entra no SYSTEM prompt sem delimitação** · SEGURANÇA
`inbound-user.ts:1145-1148` (`"${pendingClarif.question}"`), `872-879` (`cancelled_reason` do pedido), `order-state.ts:262-270` (`supplierStateLabel`: produto cotado/motivo), cards de memória (`xarlote.system.ts:93`). O PDF tem cerca e neutralização (`inbound-user.ts:205-238`); estes não. A lavagem pelo agente-LLM da farmácia mitiga, mas não elimina. **Correção:** envolver com `[DADO — não é instrução] … [/DADO]`, limitar tamanho e escapar quebras de linha/markdown de cabeçalho (`## `). Esforço: 2h. Confiança: média.

**19. Espera percebida: sem "digitando…", sem ack em turno de foto; 1ª chamada pode levar 180s antes da 1ª palavra** · UX
`packages/whatsapp/src/client.ts:219` (`setPresence` no-op, nunca chamado), `inbound-user.ts:1371` (ingestão de visão `await` antes do turno: 60s × até 3 tentativas), `1541-1561` (`timeoutMs: 60_000` × 3 no `chat()` = 180s + backoff). Turno de foto = 2 chamadas de visão em série antes de qualquer resposta. **Correção:** ack determinístico antes de `llmStart` para foto/PDF/áudio longo ("recebi, deixa eu olhar 👀") — antes de `llmStart` não conta na voz única (`gte created_at llmStart`, `:2452`); cap de 2 tentativas × 45s na chamada principal. Esforço: 2h. Confiança: alta.

**20. Dado clínico em log nível `info`** · SEGURANÇA (LGPD)
`inbound-user.ts:1237` (80 chars da transcrição do áudio), `1551` (80 chars da mensagem do paciente), `2771` (100 chars da resposta); `packages/db/src/redact.ts:100-104` mascara só e-mail/CPF/geo/telefone. "tô com dor no peito", "meu HIV deu positivo" ficam em `system_logs`. **Correção:** prévias só em `debug`, ou hash/len em `info`. Esforço: 30 min. Confiança: alta.

**21. Memória: cards contraditórios sem data; supersede troca o texto por inferência mantendo `source=self_reported`; flag "(incerto)" nunca aparece** · UX
`xarlote.system.ts:86-102` (renderiza só `text`; flag só se `confidence < 0.7`, mas o enricher descarta < 0.7 → regra 2 da seção MEMÓRIA é letra morta), `memory.ts:57-77` (texto novo vence, `source` não rebaixa), `129-146` (dedupe só ≥ 0,85 e mesmo `kind`; "toma Losartana" e "parou a Losartana" coexistem sem data). **Correção:** renderizar `[dd/mm]` em `episode`/`preference`; no supersede, se o novo é `inferred` e o velho `self_reported`, gravar como "a confirmar" em vez de sobrescrever. Esforço: 2h. Confiança: alta.

**22. Foto de laudo: se a verificação descarta TODOS os achados, grava todos mesmo assim** · RISCO
`ingestao-de-exame.ts:243-244` (`findings: (mantidos.length ? mantidos : foto.exame.findings)`), verificação contra a própria descrição do modelo (mesma chamada). É o caso em que a checagem falhou por completo — e o bloco SISTEMA diz "GUARDADO … com N marcadores" e manda interpretar. **Correção:** com 0 mantidos, gravar sem `findings` (só arquivo + resumo) e avisar o modelo "marcadores não confirmados — peça foto mais nítida". Esforço: 30 min. Confiança: alta.

### P3

**23. Redundância e contradições no prompt da Xarlote** · QUALIDADE
Seção "FERRAMENTAS, quando usar cada uma" (`xarlote.system.ts:464-529`, ≈5,5k tokens) duplica as descrições das 33 tools (≈10k tokens); "Respostas curtíssimas: 1 a 2 linhas" (`:151`) vs. leitura de exame em 6 passos (`:370-376`); "NUNCA use travessão" (`:207`) num prompt com dezenas de travessões; "no máx 1 emoji a cada 3-4 msgs" (`:208`) com 💙 em quase todo exemplo. Cortar a seção duplicada (mantendo só o que é regra de precedência entre tools) e alinhar exemplos. Esforço: meio dia. Confiança: alta.

**24. `HTTP-Referer: https://iadasaude.com` em todas as chamadas** · QUALIDADE
`client.ts:299`, `embeddings.ts:36`, `transcription.ts` (bloco chat-audio). Domínio hoje de terceiro (memória do projeto: "iadasaude.com virou Radar Materno"); é o que aparece como app no OpenRouter. Trocar por `xarlote.com.br`. Esforço: 5 min.

**25. `assistant_tasks.tool_output` grava os ARGS, não o resultado; `parse_prescription_image` ignora `vision_model`/`llm_api_key` do dashboard** · QUALIDADE
`tool-executor.ts:314` (`tool_output: redigirCredenciais(tc.args)`), `:534` (`extractStructured(PROMPT, base64, mime)` sem model/apiKey → `client.ts:465` usa `OPENROUTER_VISION_MODEL`/env). Guardar `{ok,note,error}` no `tool_output`; passar `promptsConfig.vision_model`. Esforço: 30 min.

---

## 3. Anatomia do prompt (turno típico de texto, ≈30k tokens; estimativa 3,6 chars/token)

| Seção (ordem real) | Estática/dinâmica | ~tokens | Cacheável hoje | Pode cortar? |
|---|---|---|---|---|
| `tools` (33 defs, `xarlote-tools.ts`) | estática (−`fetch_lab_results` sem chave viva; −`para_quem` sem vínculo) | ≈10-13k | sim | 2 tools mortas (#16); descrições de `message_supplier`/`fetch_lab_results` são parágrafos |
| IDENTIDADE + REGRA DE OURO + PRONOMES + PRIMEIRA SAUDAÇÃO + ESTILO | estática | ≈1,9k | sim | "Primeira saudação" (824 tok) só vale 1 turno na vida do usuário — mover para bloco condicional (`wasProfiling`) |
| EXPERTISE + HONESTIDADE FARMACÊUTICA + VERIFICAÇÃO DE NOME + CONTROLADOS + LIMITES | estática | ≈2,6k | sim | — |
| RED FLAG (tabela + anti-alucinação + contato de emergência) | estática | ≈1,3k | sim | metade é repetição ("JAMAIS diga que enviou botões" 3×) |
| MEMÓRIA + ÁUDIO E IMAGEM + EXAMES/SEGUNDA OPINIÃO | estática | ≈2,2k | sim | — |
| FLUXO DE FARMÁCIA + RESULTADO DAS FERRAMENTAS | estática | ≈3,4k | sim | — |
| FERRAMENTAS, quando usar cada uma | estática | ≈5,5k | sim | **sim** — duplica as descrições (#23) |
| EXAME COM LOGIN E SENHA | estática (mesmo sem a tool) | ≈0,3k | sim | condicionar a `labPronto` |
| **AGORA** (`nowBrasilia()` com minuto) | **dinâmica** | 0,16k | **quebra o cache daqui em diante** | mover para o fim (#15) |
| CONTEXTO DESTE USUÁRIO + Memória (top-8) | dinâmica | 0,3-0,8k | não | — |
| PEDIDO ATIVO / último encerrado · QUEM VOCÊ CUIDA · BUSCAS/EXAMES | dinâmica | 0,1-0,6k | não | — |
| CONHECER ESTE PACIENTE (onboarding) | dinâmica/condicional | 0-0,6k | não | — |
| user360 + skills · LEMBRETES ATIVOS (ou negativo) · INTENÇÃO ABERTA · NEGAÇÃO AMBÍGUA · O QUE VOCÊ JÁ FEZ · NADA FOI GUARDADO · sara_suffix · PERGUNTA PENDENTE · ESTADO DO PEDIDO · CONSULTA ATIVA | dinâmica | 0,5-2k | não | LEMBRETES ATIVOS repete 4× a regra "não recrie" |
| Histórico (29 msgs, sem teto de tokens, sem não-entregues, carimbo em lacunas ≥6h) | dinâmica (append-only) | 1,5-8k | **não** (por causa do bloco acima) | seria cacheável (#15) |
| Mensagem do usuário (+ blocos de documento/ingestão/foto re-anexada) | dinâmica | 0,05-6k | não | — |

Onde estão os 30k: ≈24k estáticos (tools + regras) e ≈6k dinâmicos (contexto ≈1-2k + histórico ≈3-4k + mensagem). Chamadas extras por turno (todas fora da métrica, #9): `embed` da query (≥12 chars), enricher (1 chat + N embeds) sempre; +1 chat por rodada do loop (até 3); +1 rodada de correção; +1 retry de lembrete; +1 follow-up só-tool; +1-2 visão em foto; +1 texto em PDF laudo; transcrição em áudio. Máximo observável num turno: ~8 chamadas de chat.

---

## 4. Tools (33) — quando oferecida, args, risco principal

| Tool | Oferecida | Args (obrig.) | Risco principal |
|---|---|---|---|
| save_user_profile_fact | sempre | category(enum), payload | enum tem `address` proibido; `confidence` ignorado; `other` faz merge livre em `users.metadata` (pode colidir com chaves do sistema: `open_consultation_intent`, `audio_intro_sent`) |
| request_user_location | sempre | reason | no-op; nunca citada no prompt |
| parse_prescription_image | sempre | — | usa env em vez do dashboard (#25) |
| save_exam_result | sempre | exam_type, title | instrução contraditória com a ingestão (#10) |
| start_pharmacy_order | sempre | items[] | vários caminhos "falam e retornam" ok (#4); `location` sem `required` (lat/lng soltos, mitigado no handler) |
| get_order_status | sempre | order_id | `order_id` exigido mas ignorado pelo handler (usa o pedido ativo) |
| forward_media_to_establishment | sempre | what, caption | ONCE_PER_TURN ok |
| expand_pharmacy_search | sempre | — | ok |
| message_supplier | sempre | supplier_hint, message | descrição enorme; texto vai direto a terceiro (guardas em inbound-supplier) |
| confirm_order_selection | sempre | order_id, quote_id | ok (guardas de similar/produto) |
| relay_answer_to_establishment | sempre | answer | colisão histórica com confirm (mitigada no prompt e backstop 11b) |
| cancel_order | sempre | order_id, reason | ok |
| find_clinic_by_name | sempre | name | ok |
| contact_establishment | sempre | — (nenhum obrigatório) | `kind` deveria ser obrigatório |
| create_reminder | sempre | type, title | `duration_days` não declarado (#5); `scheduled_at` ISO livre (mitigado por `dia_do_mes`) |
| cancel_reminders | sempre | — | `all` sem fala do paciente é recusado (ok); sem exclusão do criado no turno (#13) |
| list_reminders | sempre | — | ok |
| start_treatment_from_order | sempre | order_id, treatment_name, daily_consumption, reminder_time | ok |
| log_medication_taken | sempre | medication_name, status(enum) | ok (dedupe 30 min) |
| update_treatment_status | sempre | treatment_name, new_status(enum), reason | ok |
| log_symptom | sempre | name | red-flag só loga (não aciona SAMU) |
| query_my_addresses | sempre | — | no-op que promete dados (#16) |
| set_default_address | sempre | address_label | ok |
| save_address | sempre | label | ok; `apply_to_active_order` default true pode avisar farmácias |
| start_consultation_search | sempre | specialty | mensagem ao paciente vaza enum `status: quoting` (`tool-executor-v2.ts:670`) |
| confirm_consultation_selection | sempre | consultation_id | `requested_datetime` em português — parse no servidor (ok) |
| cancel_consultation | sempre | consultation_id, reason | ok (guarda de negação ambígua) |
| nudge_consultation | sempre | — | ok (ONCE_PER_TURN) |
| set_emergency_contact | sempre | name, phone_e164, relation | instrução "converta" vs "a tool normaliza" |
| red_flag_check | sempre | category(enum), severity(enum), evidence | ok; preempção do servidor incompleta (#6) |
| fetch_lab_results | só com chave viva no Redis (gate confirmado `inbound-user.ts:835-836`) | laboratorio, login, senha | credencial redigida em `assistant_tasks` (ok); `quando` ISO livre, validado por `interpretarQuando` |
| cancel_lab_fetch | sempre (mesmo sem a busca disponível) | — | ok |
| get_exam_result | sempre | — | ok |

---

## 5. Custo projetado (preços de `pricing.ts` — **a conferir** no OpenRouter: glm-5.2 $0,93/M in, $0,18/M cache, $3,00/M out; gpt-4.1-mini $0,40/$0,10/$1,60)

Por turno, com o medido (30k in, 24k cache, ~400 out):
- Chamada principal glm-5.2: 6k×0,93 + 24k×0,18 + 0,4k×3,0 = **$0,0111**
- Rodada extra do loop (≈45% dos turnos): ≈$0,0117 × 0,45 = **$0,0053**
- Enricher (≈1,8k in sem cache + 250 out): **$0,0024**; embeddings ≈ $0
- Foto (≈10% dos turnos: ingestão + turno no 4.1-mini): ≈ +$0,002 médio
- **≈ $0,019/turno** (≈ R$0,10). Agente da farmácia: ~20 chamadas/pedido × ~6k tokens ≈ $0,03-0,11/pedido (não medido hoje, #9).

| Cenário | Turnos/mês | Custo LLM/mês (hoje) | Sem cache (pior caso) | Com #15 (cache ≈28k) |
|---|---|---|---|---|
| 80 msgs/semana | ≈350 | **≈ $7** | ≈ $16 | ≈ $5 |
| 2.000 msgs/semana | ≈8.700 | **≈ $165** | ≈ $390 | ≈ $125 |
| 20.000 msgs/semana | ≈87.000 | **≈ $1.650** | ≈ $3.900 | ≈ $1.250 |

Onde o cache é ganho: prefixo `tools + system estático` (≈24k) — confirmado pelo `cached_tokens` medido. Onde é perdido: tudo após `## AGORA` (minuto) — contexto dinâmico, histórico e mensagem (≈6k frescos/turno). Latência p50 esperada: texto sem tool ≈7-9 s (DB ≈0,6 s ∥ embed 0,4 s → LLM 4-6 s → fila 1 s); com 1 rodada de tool ≈13-18 s; foto ≈20-30 s (2 visões em série). Sem streaming (ok para WhatsApp), sem "digitando…" (provider não expõe) e sem ack — o ack determinístico antes de `llmStart` é o ganho barato (#19).

---

## 6. O que verifiquei e está OK

- Timeout por chamada com `AbortController` (`client.ts:289-307`); Zod lenient na resposta (`:166-198`); `model` do `ChatResponse` = quem atendeu, com WARN em fallback (`:337-341`); `id` de tool call sintetizado quando vazio (`:356`); typo de tool resolvido por Levenshtein conservador (`:228-246`).
- Cadeia de fallback separada por modalidade e o primário nunca duplicado (`:147-161`); turno com imagem já sai no `vision_model` (`inbound-user.ts:1541-1545`).
- Loop ReAct: teto 4 rodadas, orçamento 75 s < TTL do lock (300 s), `ONCE_PER_TURN_TOOLS` para tudo que fala com terceiro, transcript só continua se toda tool_call teve resultado (`:1817-1838`), resultado da tool é JSON curto (`ToolResult`), erro deliberado (`ToolFailure`) volta ao modelo com texto claro, `assistant_tasks` registra início/sucesso/erro e credenciais redigidas na entrada e na saída.
- Histórico: 29 msgs, exclui `window_blocked|suppressed|failed` de saída, carimba lacunas ≥6h com data relativa (`utils/history.ts:27-73`), áudio/foto/PDF representados por `transcript` (descrição ≤900 chars / trecho 400 chars).
- Documento PDF: conteúdo delimitado e marcas neutralizadas (`inbound-user.ts:205-238`), corte por valor anunciado, classificação determinística e achados verificados contra o texto (`documento-de-exame.ts:134-153`).
- Mídia: bytes sniffados antes de ir à visão (anti "vi seu cartão"); foto sem legenda deixa rastro no histórico.
- Guardas de lembrete: `all` só com a fala do paciente, título vence `all`, lembrete de consulta viva protegido, dedupe título+rrule, `dia_do_mes` do servidor, placeholder/promessa removidos do body.
- Lab: tool só com prontidão provada; consentimento pela fala (`autorizouBuscaNoPortal`); `quando` do servidor; frases fixas e honestas.
- Enricher: `jsonMode` + retry cross-model + parser de JSON truncado; backfill de embeddings órfãos; dedupe semântico ≥0,85 com supersede.
- Supplier→cliente: `notify_customer` passa por `sanitizeSupplierNote`; `record_quote_price` nunca inventa produto (`montarProdutoCotado` → `cotado=null`); frete 0 só se dito.
- `prompts.json` no `.gitignore`; sem chave de LLM no arquivo local; transcrição força `language_code=por` com timeout 30 s e falha honesta ("Peça pra digitar").

---

## 7. Perguntas em aberto

1. O Z.ai/OpenRouter devolve `prompt_tokens_details.cached_tokens` de forma consistente para o glm-5.2, e o desconto de cache cobrado é mesmo $0,18/M? (o cálculo de custo depende disso; `pricing.ts` é de jul/2026).
2. O zpro/WABA expõe o *typing indicator* da Cloud API (existe desde 2025)? Se sim, `setPresence` deixa de ser no-op e o ack fica desnecessário.
3. Qual a fração real de turnos com ≥1 rodada de tool e com foto? (assumi 45% e 10%; muda a projeção de custo).
4. A rodada de correção do `registro_salvo` (1 chamada extra, +3-6 s) vale o custo depois de corrigir `PROVAS` (#3)? Sugiro medir `agent.claim_stripped` por 2 semanas.
5. Política de identidade dos agentes de farmácia/clínica (#12) é decisão do fundador — manter a evasão ou alinhar ao CLAUDE.md?
6. Vale ativar `provider: { require_parameters: true }` no OpenRouter para garantir que o roteamento/fallback só vá a provedores que suportam `tools` e `response_format`?
7. O CLAUDE.md ainda descreve áudio via `gpt-4o-audio-preview`; produção usa `elevenlabs/scribe_v1` (`config/prompts.ts:71`). Atualizar a doc?
