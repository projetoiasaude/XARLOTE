# DOSSIÊ — Por que o fluxo de compra de medicamento NÃO funciona na vida real

> Investigação feita em 27/08/2026 contra o banco de PRODUÇÃO (Supabase `niqmxiybiwrfkvdfojcq`),
> os logs de produção e o código do repo `/Users/hiagovieira/IA_da_saude`.
> Tudo abaixo é FATO VERIFICADO, com a fonte ao lado. Não há especulação nesta seção.

---

## 1. O produto e a restrição

**Xarlote** — concierge de saúde por WhatsApp, **EM PRODUÇÃO em Goiânia, com pacientes reais**.
O MVP é: paciente pede remédio → Xarlote acha farmácias → negocia → entrega preço/pagamento.

**Stack travada:** Node 20 · TS 5 · Fastify 4 · BullMQ 5 · Redis 7 · Supabase (Postgres) ·
OpenRouter (LLM) · Next.js 14 · pnpm workspaces · Railway (api + worker + redis) · Vercel (web).

**WhatsApp:** provedor **zpro** nas DUAS pernas (confirmado no `/health` de produção hoje:
`wa_provider_sara: "zpro"`, `wa_provider_agent: "zpro"`). O zpro é um intermediário sobre a
**API oficial WhatsApp Business (WABA) da Meta**.
- perna `sara` = fala com o PACIENTE
- perna `agent` = fala com FARMÁCIA e CLÍNICA
- Abertura fria (fora da janela de 24h) **obriga template HSM aprovado**. Texto livre só dentro da janela.
- Templates aprovados hoje: `cotacao_medicamento_2` (farmácia, 2 vars), `atendimento_clinica`
  (clínica, 1 var), `contato_geral` (coringa, 1 var), `lembrete_compromisso` (re-engajar paciente).

**Regras inegociáveis do projeto (CLAUDE.md):**
1. Nunca comitar segredo.
2. Nunca fingir que a Xarlote é humana se perguntada.
3. Nunca deixar PII (telefone, CPF, endereço, lat/lng, Pix, dado clínico) em log nível ≥ info sem redação.
4. Nunca chamar LLM sem timeout e retry.
5. **Nunca enviar WhatsApp fora da fila `outbound-whatsapp:*`** (rate limit é crítico pra não tomar ban).
6. `service_role` só no backend; frontend usa `anon` + RLS.
7. Registrar tool calls em `assistant_tasks` e eventos LGPD em `consent_events`.
8. Nunca diagnosticar, nunca ajustar dose.

---

## 2. O caso real que motivou tudo — paciente "Lud" (Ludmila), 26/08/2026

| hora | o que aconteceu |
|---|---|
| 17:53 | "oi xarlote" |
| 17:53 | Xarlote: "Oi Lud! Tudo bem?" |
| 17:54 | "queria um remédio porque estou com muita dor no estômago, acho que a gastrite atacou" |
| 17:54 | **Xarlote: "Pra gastrite, omeprazol 20mg em jejum é o caminho"** ← receitou dose e posologia |
| 17:54 | "pode cotar um pantoprazol, por favor" → "pode ser 20 mg" |
| 17:54 | pedido criado, endereço salvo "trabalho" (Setor Sul, Goiânia) |
| 17:54 | Google Places → 18 farmácias; "Seleção v2: 5 independente(s), 2/13 rede(s) (cap 2)" |
| 17:54 | log: **"⛏️ WhatsApp minerado do site de Drogaria Plus: landline"** |
| 17:54 | "Time final (5): Droga Ryos [verificada] · Drogasil [verificada] · Farmácia Modelo [fixo] · Farma Popular [fixo] · Ultra Popular [fixo]" |
| 17:55 | Xarlote → Lud: "Achei 5 farmácias e **já entrei em contato com elas**" |
| 17:55 | 5 templates `cotacao_medicamento_2` disparados |
| 17:55 | e-commerce responde em ~7s: **Ultrafarma R$10,93 · Indiana R$11,98 (4 dias úteis) · Drogal R$12,69 (5 dias úteis)** |
| 17:56 | **Lud: "queria algo mais rápido. Não queria aguardar 4 dias pra ter o medicamento."** |
| 17:56 | modelo chama `expand_pharmacy_search` → +5 farmácias (raio 10km), **todas fixo** |
| 17:57 | 10 templates no total disparados |
| 17:57 / 17:59 | "3min: 0 cotação(ões)" **DUAS VEZES** (traceIds diferentes) |
| 17:59 / 18:01 | "5min: 0 cotações — modo eager" **DUAS VEZES** |
| 18:04 / 18:06 | mesma mensagem "As farmácias ainda não responderam" enviada **DUAS VEZES** à Lud |
| 18:42 | rescue: "No successful quotes for order" — as 10 viram `timeout` |
| 18:42 | Xarlote: "Falei com 10 farmácias, mas nenhuma respondeu ainda 😔" |
| 18:49 | **"xarlote, pode deixar. Obrigada, eu vou olhar aqui próximo"** ← paciente desiste |

**Resultado: 0 de 10 farmácias responderam. A paciente não conseguiu o remédio.**

---

## 3. Os telefones daquele pedido (dado central)

| farmácia | número | tipo | resultado |
|---|---|---|---|
| Droga Ryos | +5562982222170 | CELULAR | timeout |
| Drogasil | +5562998465310 | CELULAR | timeout |
| Farmácia Modelo | +556232291966 | **FIXO** | timeout |
| Farma Popular | +556239310401 | **FIXO** | timeout |
| Ultra Popular | +556230935700 | **FIXO** | timeout |
| Drogaria Plus | +556235332000 | **FIXO** | timeout |
| Drogaria Milano | +556231214000 | **FIXO** | timeout |
| Drogaria Medserv | +556232032688 | **FIXO** | timeout |
| Drogaria Primavera | +556232320101 | **FIXO** | timeout |
| Farmácia do Trabalhador | +556232060707 | **FIXO** | timeout |

**8 de 10 eram telefone FIXO** (12 dígitos, local começando com 3 = fixo em Goiás).
Celular BR = 13 dígitos com `9` no 5º dígito de `55DD9XXXXXXXX`.

---

## 4. Taxa de resposta — o dado que separa causa de ruído

Medido sobre `quotes` × `messages` inbound na conversa, em produção:

| era | tipo de número | aberturas | responderam | % |
|---|---|---|---|---|
| ANTIGA (uazapi, texto livre, até 28/07) | **celular** | 121 | 66 | **55%** |
| ANTIGA (uazapi, texto livre, até 28/07) | **fixo** | 95 | 11 | **12%** |
| NOVA (zpro/WABA, template, desde 29/07) | **celular** | 5 | 1 | 20% |
| NOVA (zpro/WABA, template, desde 29/07) | **fixo** | 14 | 1 | 7% |

**Leitura correta:** celular responde ~5× mais que fixo, em QUALQUER era. A amostra da era
nova é pequena demais (n=5 celular) pra culpar a virada de provedor. **Não trocar de provedor
com base nisso** — seria conclusão sem suporte estatístico.

**Contraprova de que o canal WABA funciona:** mesma perna `agent`, mesmo template frio, com CLÍNICAS:
- desde 29/07: **40 aberturas → 27 responderam = 68%**
- 24/08 15:42:57 dispara → **15:43:25 (28 segundos)** a secretária Ludmylla responde
- 25/08 09:32:24 dispara → **09:32:31 (7 segundos)** a secretária Rita responde

**Contraprova de que não é "acham que é golpe/robô":** em ~90 respostas de farmácia lidas
(julho), NENHUMA perguntou quem era, se era golpe ou robô. Atendentes se apresentaram pelo
nome ("me chamo Nhaytton", "me chamo Daniele", "Farmacêutico André Lucas", "meu nome e Adelino"),
deram preço, pediram CPF/endereço/forma de pagamento, ofereceram genérico, negociaram frete.
**44 das 95 farmácias já contatadas responderam pelo menos uma vez.**

**Taxa de FECHAMENTO histórica (virou preço):** ~7% das cotações. 240 cotações → 16 `quoted`.
Última resposta real de farmácia: **07/08/2026**.

---

## 5. Os 5 defeitos confirmados no código

### D1 — Não existe confirmação de entrega. Em duas camadas.

**Camada A (bug nosso):** `sendTemplateOpeningToSupplier` em
`apps/api/src/handlers/outbound-agent.ts:355` faz
`await db.from('messages').insert({...})` **sem `.select('id').single()`** — não captura o id.
Depois chama `dispatchOutbound({...})` **sem `messageId`**. Como `stampDelivery`
(`apps/api/src/queues/outbound.queue.ts`, ~linha 400) só carimba quando recebe `messageId`,
o carimbo NUNCA roda pra abertura fria de farmácia.
Prova: as 10 linhas de ontem têm `delivery_status`, `external_id` e `provider_ticket_id` = NULL.
O caminho irmão `sendOutboundToSupplier` (mesmo arquivo, ~linha 152) **passa** o `messageId`
corretamente — e o de clínica também. Só a abertura por template ficou de fora.

**Camada B (limite do provedor):** mesmo corrigindo A, o zpro não entrega o que precisamos.
Em **2.019 ecos de status** gravados em `webhook_events`, o payload SEMPRE veio
`{"status":"sended","ack":1}`. **Nunca** apareceu `ack: 2` (delivered) nem `ack: 3` (read),
e `wamid` vem sempre `null`. Ou seja: o zpro confirma "despachei", não "a Meta entregou".
O `delivery_status='delivered'` que o banco carimba na perna do paciente é uma **tradução
otimista de "sended"** — não é prova de entrega.
O próprio código admite a lacuna em `apps/api/src/handlers/tool-executor.ts:1246`:
*"o sinal de 'sem WhatsApp' viria de um parser de status do zpro NAO-DOCUMENTADO"*.

**Implicação:** hoje é IMPOSSÍVEL distinguir "a farmácia ignorou" de "a mensagem nunca chegou".
Toda decisão a jusante (insistir? trocar? avisar o paciente?) está sendo tomada às cegas.

### D2 — Rede grande é contatada por WhatsApp E cotada no e-commerce (desperdício)

O e-commerce roda **sempre e em paralelo** (`tool-executor.ts:1579`), não por ser rede.
As redes continuam entrando na fila de WhatsApp, limitadas por
`PHARMACY_CHAIN_CAP = 2` (`tool-executor.ts:1139`).
Ontem a Drogasil foi contatada por WhatsApp **e** cotada no e-commerce — gastou 1 das 10 vagas.
Comentário no próprio código (`tool-executor.ts:1420`) reconhece: *"redes grandes
(Drogasil/Raia/Pague Menos…) quase só mandam auto-resposta"*.
Evidência viva: em julho a Drogasil respondeu *"para cotações acesse nosso site ou baixe o
aplicativo"* — ou seja, a rede te manda pro e-commerce de qualquer jeito.

### D3 — O e-commerce ordena por PREÇO, nunca por PRAZO

`packages/integrations/src/pharmacy-platforms/index.ts:433`:
```js
return quotes.sort((a, b) => (b.lines.length - a.lines.length) || (a.total - b.total));
```
Cobertura de itens, depois **preço mais barato**. Prazo de entrega **não entra em lugar nenhum**.
Corte em `MAX_NETWORKS = 3` (`apps/api/src/handlers/platform-quotes.ts:18`).

O ETA existe e é renderizado (`fulfillmentLine`, `platform-quotes.ts:26`) — o campo
`q.delivery.etaText` e `q.pickup.etaText` estão lá. Só **não é usado pra decidir nada**.

Consequência direta no caso Lud: recebeu os 3 mais baratos (R$10,93 / R$11,98 em 4 dias /
R$12,69 em 5 dias). A **Drogasil está `enabled: true`** no registry e entrega rápido em
Goiânia — ficou fora do top-3 por ser mais cara. A paciente disse explicitamente *"queria
algo mais rápido"* e não havia mecanismo pra reordenar.

Registry (`packages/integrations/src/pharmacy-platforms/registry.ts`), redes com `enabled: true`:
pague-menos, extrafarma, drogaria-sao-paulo, pacheco, sao-joao, drogal, venancio,
drogaria-globo, catarinense, indiana, drogasil, nissei, ultrafarma.
Com `enabled: false`: **droga-raia, araujo, onofre, panvel**.
Há suporte a `pickup` (retirar na loja) já implementado e não priorizado.

### D4 — O "busca outra farmácia" existe mas foi BLOQUEADO pelo próprio critério

`topUpIfDeadAir` em `apps/api/src/handlers/tool-executor.ts:1255`, agendado a
`PHARMACY_TOPUP_CHECK_MS = 180_000` (3 min), teto `PHARMACY_MAX_TOPUP = 2`.

Só dispara se `live === 0` ("vácuo total"). Mas conta como **sinal de vida**:
```js
if (sup?.whatsapp_verified_at) { live++; continue; }
```
`whatsapp_verified_at` = "essa farmácia respondeu em ALGUMA época do passado".

Ontem Droga Ryos e Drogasil estavam `[verificada]` (responderam em julho) → `live = 2` →
**top-up não disparou**. As duas únicas com histórico de conversa — e mudas naquele dia —
foram exatamente o que **bloqueou** a busca por mais farmácias.

Pior: roda **uma vez só** (`pharmacyBackups.delete(orderId)` no fim da função), teto 2, e nunca
mais. Não existe ciclo de "procura até achar quem responda".
Os +5 de ontem só saíram porque a **paciente pediu** e o modelo chamou `expand_pharmacy_search`.

Timers relevantes: `check3min` / `check5min` em
`apps/api/src/handlers/quote-consolidation.ts` (~linha 140/163); janela total do pedido
`QUOTE_WINDOW_MIN` (o rescue pegou às 18:42, ~45 min).

### D5 — A Xarlote informa contagem que ela sabe ser falsa

O sistema classifica cada número em tiers (`tool-executor.ts:1148`):
`tier: 'verificada' | 'celular' | 'fixo'`, e loga o "Time final" com o tier de cada uma.
Ele SABIA que 8 dos 10 eram fixo, e logou "WhatsApp minerado ... landline".
Mesmo assim disse à paciente **"Achei 5 farmácias e já entrei em contato com elas"** e depois
**"Falei com 10 farmácias"**.

Isso é reincidência de uma família de incidentes que o projeto já auditou e documentou
(a consulta que não existia, o cancelamento que não houve, o "já dei um alô" que nunca saiu).
O projeto já tem um mecanismo criado pra isso — o **`claim-guard`**, que relê o texto à luz do
que as tools REALMENTE fizeram. Ele não cobriu este caso.

### D6 (bônus, achado na mesma auditoria) — mensagem duplicada ao paciente

`scheduleQuoteTimeout(..., force = true)` em `quote-consolidation.ts:41` faz
`scheduledTimeouts.delete(orderId)` mas **nunca dá `clearTimeout` nos timers já agendados**.
`expand_pharmacy_search` chama com `force` → duas cadeias paralelas no MESMO pedido.
Prova: dois "3min", dois "5min" e a mesma mensagem enviada à Lud às 18:04 e 18:06.

### D7 (bônus) — a Xarlote receitou

"Pra gastrite, omeprazol 20mg em jejum é o caminho" — medicamento + dose + posologia, não
solicitado. Viola a regra 8 do CLAUDE.md.

### D8 (bônus) — coluna morta

`quotes.contact_attempts` está 0 em todas as linhas. Uma busca por `contact_attempts` em todo
`apps/` e `packages/` (arquivos `.ts`) retorna **zero ocorrências de escrita**. A coluna
existe no schema e nunca é incrementada. Não há retry nem nudge à farmácia: um disparo só,
depois silêncio até o rescue.

---

## 6. Mapa de arquivos relevantes

| arquivo | papel |
|---|---|
| `apps/api/src/handlers/tool-executor.ts` | tools da LLM; seleção de farmácias (`Seleção v2`), tiers, top-up, backups, `expand_pharmacy_search`, disparo do e-commerce em paralelo |
| `apps/api/src/handlers/inbound-supplier.ts` | abre a negociação com a farmácia (`initiate...`, linha ~1290-1380), decide warm/cold, monta a abertura via LLM, `finalizeQuote` |
| `apps/api/src/handlers/outbound-agent.ts` | envio pra farmácia/clínica; `sendOutboundToSupplier` (~152), `sendTemplateOpeningToSupplier` (~338) |
| `apps/api/src/queues/outbound.queue.ts` | worker da fila; `sendClaimed` (kinds text/image/menu/template/audio), `stampDelivery` |
| `apps/api/src/handlers/quote-consolidation.ts` | timers 3min/5min, modo eager, `consolidateQuotes`, rescue durável |
| `apps/api/src/handlers/platform-quotes.ts` | apresenta as redes ao paciente; `MAX_NETWORKS=3`, `fulfillmentLine` |
| `packages/integrations/src/pharmacy-platforms/` | `registry.ts` (catálogo de redes), `index.ts` (cotação + ordenação), `vtex.ts`, `rd-adapter.ts`, `ultrafarma-adapter.ts`, `nissei-adapter.ts` |
| `apps/api/src/config/template-registry.ts` | templates HSM aprovados, `pharmacyColdOpen`, `buildTemplatePayload` |
| `apps/api/src/routes/webhook.zpro.ts` | entrada; blindagem de lane ("Lane corrigida") que roteia resposta de estabelecimento que chega na URL do sara |
| `apps/api/src/handlers/supplier-directory.ts` | `whatsapp_verified_at`, `markSupplierVerifiedById` |

**Tabelas:** `orders`, `quotes` (status: pending/contacting/negotiating/quoted/unavailable/timeout/refused),
`suppliers` (`phone_e164`, `whatsapp_e164`, `whatsapp_verified_at`), `conversations`
(`party_type` user/supplier/clinic, `whatsapp_instance`), `messages`
(`direction` in/out, `delivery_status`, `external_id`, `provider_ticket_id`), `system_logs`, `webhook_events`.

**Testes:** 1862 testes em 97 arquivos, `pnpm test` (vitest), `pnpm typecheck` limpo em 6 pacotes.
⚠️ Um incidente já registrado no projeto: rodar `tsc` + `vitest` em 7 agentes paralelos saturou
a máquina do fundador. Evitar recomendar paralelismo pesado de build.

---

## 7. O que o PLANO precisa resolver

O objetivo NÃO é fechar bugs. É: **uma pessoa com dor de estômago às 18h em Goiânia consegue
o remédio dela pelo WhatsApp da Xarlote, hoje, na vida real.**

O plano precisa ser **executável neste stack, sem reescrita**, respeitando produção com
pacientes reais em cima, e precisa dizer explicitamente o que é código (posso fazer) e o que
é ação do fundador (comercial, contas, credenciais).
