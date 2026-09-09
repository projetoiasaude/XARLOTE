# PLANO v2 — Fazer a Ludmila receber o remédio dela

> Base factual: `DOSSIE_FARMACIA.md` (27/08/2026), verificado contra o banco de produção.
> Todo detalhe de implementação abaixo foi **reconferido no código em 27/08** antes de virar
> ação — os números de linha citados são os de hoje, na branch `fix/auditoria-04-08`.
> Produção está viva, com pacientes reais. Nada aqui é reescrita, nada aqui é migration.
>
> **v2 corrige 7 bloqueantes da v1** — em resumo: a v1 *encolhia* o time de farmácias
> enquanto prometia aumentá-lo; *fabricava* no banco a prova de entrega que dizia estar
> medindo; deixava o dedup do e-commerce matar a opção de hoje 30 linhas antes de o núcleo
> do plano enxergá-la; desligava para sempre o único mecanismo automático de "procurar mais
> farmácia"; oferecia à paciente uma palavra mágica sem handler; media insumo achando que
> media resultado; e, no seu melhor cenário, mandava uma pessoa com dor até um balcão para
> ser recusada por falta de receita. Cada um está resolvido abaixo, com o código do conserto.

---

## 0. EMENDAS DO JUIZ — obrigatórias, prevalecem sobre o resto do documento

> Juiz independente (não viu nenhuma das revisões): **aprovado, nota 62/100**, com 6 condições.
> A crítica central: *"a MAIORIA da massa do plano é trabalho de HONESTIDADE e SEGURANÇA, não
> de CAPACIDADE DE ENTREGA. Depois de executado inteiro, o sistema para de mentir, para de
> duplicar mensagem, para de receitar e para de prometer socorro inexistente — tudo necessário,
> nada disso põe um comprimido na mão de ninguém."*
>
> As emendas abaixo corrigem exatamente esse desequilíbrio. **Onde conflitarem com as seções
> 3 a 7, valem estas.**

### E1 — A2.5 deixa de ser condicional e sobe para o PASSO 2

O link de busca do iFood/Rappi rotulado sai de *"condicionada a A0 ou A0.5 voltarem magros"* e
passa a ser incondicional, no PASSO 2, ao lado de A5 e A10. Custa ~1h, risco zero, e é a única
coisa da rodada com chance alta de pôr o comprimido na mão dela às 18h30 **no cenário em que
A0/A0.5 falham** — que é justamente o cenário em que, como estava escrito, ele só *começaria a
ser escrito*. Pára-quedas não se costura durante a queda.

### E2 — A7 (semear ~40 celulares reais) volta ao caminho crítico AGORA

Desacoplado de A-F2. A justificativa original — *"sem eco de entrega, 'não respondeu' e 'não
chegou' são indistinguíveis"* — é epistemicamente correta e operacionalmente errada: **um
número de celular real converte melhor independentemente de conseguirmos atribuir a falha
anterior.** Esperar um e-mail ao suporte de um terceiro para começar trabalho humano que já se
sabe necessário é trocar desfecho por poder explicativo.

Duas disciplinas da v2 ficam **integralmente intactas**: (a) o CSV **nunca** grava
`whatsapp_verified_at` — esse carimbo só nasce de resposta real (antídoto do B4); (b) **A4(a)
não mergeia sem A4(d)**, o conserto do `topUpIfDeadAir`.

### E3 — NOVO: A13, o caminho da receita (o buraco que ninguém enumerou)

Pantoprazol 20mg é tarja vermelha. O A2.9 (correto) passa a perguntar *"você tem a receita?"*.
Mas para a Ludmila **sem receita**, o melhor desfecho previsto pelo plano inteiro é uma resposta
honesta e **nenhum remédio**.

E a Xarlote tem, pelos números do próprio dossiê, uma perna de **clínicas que converte 68% em 7
segundos**. Ligar `paciente sem receita → clínica/telemedicina → receita digital → retirada` é o
caminho óbvio até o comprimido, usa o canal que **comprovadamente funciona**, e não aparece uma
única vez nas 1.349 linhas.

**A13 [C+F]** — quando A2.9 detectar tarja vermelha **e** a paciente disser que não tem receita,
oferecer a perna de consulta/telemedicina em vez de encerrar com "procure atendimento". Reusa
`consultation` + template `atendimento_clinica`, que já existem e já funcionam. Entra no PASSO 4,
imediatamente após o A2.9. **Sem A13, o caso motivador não fecha nem no melhor cenário.**

### E4 — O Plano B precisa ser um caminho até o comprimido, não uma nova promessa

O §6 hoje responde *"e se farmácia de bairro não for viável?"* com *"um produto menor e honesto"*
— isso redefine a promessa, não entrega o remédio. **Antes de rodar A0 e A0.5, escrever o que
acontece se AMBOS falharem, e que seja um caminho até o comprimido.**

Concreto: nos próximos ~20 pedidos urgentes, **o fundador compra e manda motoboy**. O runbook do
A6 já exige nome, horário, dinheiro e entregador — basta promovê-lo de gate do A6 a **Plano B
operacional**. Não escala, e não precisa: valida a promessa enquanto o canal digital não existe.

### E5 — A0.5 é cronometrado no caminho da PACIENTE, e n=2

Não o fundador com contexto. **Conta nova, no celular, sem saber o que esperar, e especificamente
escolhendo RETIRADA.** E repetir **uma segunda vez com um CEP diferente** antes de ligar o rótulo
⚡. Uma amostra de 1 numa rede é n=1 — o mesmo erro que o próprio §7.6 deste plano proíbe.

### E6 — O esforço está subestimado em pelo menos 2×, e o A11 é intocável

*"≈1,5 dia útil de código"* para A2 + A2.9 + A5 + A10 + A1.0/1.2 + A6 (runbook, ACK,
`escalate_to_human`, supressor) + A11 (prompt + pós-filtro determinístico) não fecha. Trate como
**≈3 dias úteis**. Se o prazo virar compromisso, o item que será cortado no fim é o **A11** — que
é o único de risco existencial (a Xarlote receitando dose a paciente real). **A11 não é cortável.**
Se algo tiver que cair, corte A1.3 e A3.

### Caminho crítico com as emendas aplicadas

```
PASSO 0  A-F1 (Meta BM, 10 min) ──► GATE de qualquer aumento de disparo frio
         A-F2 (zpro + portfolio)      [não bloqueia mais o A7]

PASSO 1  A0 (sonda, 40 min)  +  A0.5 (compra real no caminho da PACIENTE, n=2)   ⚠️ podem girar o plano
         E4: o Plano B operacional (fundador + motoboy) é escrito ANTES de rodar estes

PASSO 2  A5 (4 textos honestos, 1h30) · A10 (timer duplicado, 30 min) · A2.5 (rodapé iFood, 1h)  ← E1

PASSO 3  A2 com o dedup consertado (4h) → A2.9 (gate de receita, 2h) → A13 (caminho da receita)  ← E3

PASSO 4  A7 (semear ~40 celulares) ← E2 · A4(a)+A4(d) inseparáveis

PASSO 5  A1.0 → A1.1 → A1.2  (A1.3 é cortável)

PASSO 6  A6 completo (runbook [F] + ACK + escalate_to_human)  OU  alerta silencioso

PASSO 7  A11 (parar de receitar) — INTOCÁVEL, não cortável   ← E6
```

**Esforço revisado: ≈3 dias úteis de código + ~2h30 do fundador + o runbook.**

---

---

## 1. DIAGNÓSTICO EM UMA FRASE

**A Xarlote foi construída para achar o preço mais barato, mas a moeda da paciente com dor
de estômago às 18h é TEMPO — e não existe uma única linha no sistema que ordene, meça ou
prometa "remédio na mão hoje".**

O corolário, que é o que dói: o único canal que responde (e-commerce, 7 segundos) foi
ordenado por preço e devolveu remessa de 4-5 dias vinda de São Paulo; o canal que a Xarlote
*anuncia* à paciente ("já entrei em contato com elas") é disparo frio para telefone fixo de
balcão, que responde 7-12% e leva de 15 a 60 minutos quando responde. Os bugs D1–D8 são
sintomas dessa inversão, não a doença.

---

## 2. ESTRATÉGIA — a aposta central

**Aposta: transformar "ela tem o remédio hoje" na função de ordenação de todo o fluxo, e
deixar o canal que já responde em segundos carregar o desfecho — com RETIRADA NA LOJA e
entrega no mesmo dia como herói, não frete de 4 dias.**

Três movimentos, nessa ordem de alavancagem:

1. **Tempo vira a chave de ordenação do e-commerce.** O ETA já existe
   (`FulfillmentOption.etaText`), já é parseado em minutos (`estimateToMinutes`, exportado em
   `vtex.ts:157`), e é jogado fora na hora de decidir — `pickBestSla` (`vtex.ts:143-153`)
   calcula `best.rankMin` e devolve só `{ etaText, feeReais }`. `pickup` (retirada na loja,
   tipicamente 60 min) já é coletado por `bestSlasFromLogistics` (`vtex.ts:172`) e nunca
   priorizado. Retirada na loja é o **único caminho digital que põe um comprimido na mão dela
   às 18h30**.
2. **O WhatsApp das farmácias passa a falar com quem atende.** 8 de 10 contatadas eram fixo.
   Fixo responde 7-12%, celular 20-55%, em qualquer era. O diretório já sabe quem respondeu
   alguma vez (44 farmácias com `whatsapp_verified_at`) e esse conhecimento não é usado para
   *escolher* — só para pontuar tier depois que o Google já escolheu.
3. **Uma saída humana antes da desistência** — mas só quando existir uma operação humana de
   verdade atrás dela. O volume é pequeno (PREMISSA A VALIDAR, §5). Com esse volume, um humano
   resolvendo por telefone os pedidos que o digital não fecha não é gambiarra: é o produto
   "concierge". A máquina de alerta já existe (`sendFounderAlert`, `founder-alerter.ts:111`) —
   o que **não** existe é o runbook, o handler e o ACK. Sem os três, A6 não fala com a paciente.

### O que mudou da v1 (leia antes de executar)

| # | Erro da v1 | O que v2 faz |
|---|---|---|
| B1 | `PHARMACY_CHAIN_CAP=0` **encolhia** o pool (`rankedAll = [...preferred, ...independentes, ...redes.slice(0, CAP)]`, `tool-executor.ts:1442`). No pedido da Lud (`5 independente(s), 2/13 rede(s)`) o pool inteiro viraria 5, com `TARGET_SLOTS=8` inatingível — e apagaria a Drogasil, que era `[verificada]` e **celular**, uma das duas únicas não-fixo do time. | O cap de rede vira **pós-filtro por tier**, não pré-filtro por nome. Redes entram no pool de candidatas (cap de revisão 2→6) e só são descartadas do time **depois** do enriquecimento, se o tier for `fixo`. A Drogasil daquele pedido passa; os 15 balcões fixos de rede vão pro backup. O pool **cresce**. |
| B2 | A9 passava o `messageId` para `stampDelivery`, e `outcome === 'sent'` grava `'delivered'` (`outbound.queue.ts:501` e `:528`). "sent" = o POST pro zpro não lançou. As 8 aberturas para telefone FIXO gravariam `delivery_status='delivered'` sem um único eco (2.019 ecos em produção, todos `ack:1`, `wamid` sempre null). E quebraria o invariante de `stampLastOutboundDelivered` (`supplier-directory.ts:99`), que só promove NULL/`window_blocked`. | **Primeiro** o vocabulário: `'sent'` passa a gravar `'dispatched'`. A palavra `delivered` só nasce de eco real. Só depois o `messageId`. A métrica "delivery_status não-nulo: 0%→100%" **sai** da §5 — era um artefato nosso vestido de indicador. |
| B3 | O dedup por grupo roda **antes** do sort e escolhe por `lines.length` e depois `total` — preço puro (`pharmacy-platforms/index.ts:425-433`). Pague Menos e Extrafarma compartilham `group:'PagueMenos'`; Drogaria São Paulo e Pacheco compartilham `'DPSP'` (`registry.ts:30-33`). Uma Pague Menos com retirada em 60 min por R$18,90 perderia para uma Extrafarma de 3 dias por R$16,00 — a única opção de hoje eliminada 30 linhas antes do "núcleo do plano". | `bucket()`/`fastest()` entram **no mesmo commit** e **no mesmo critério** do `Map best`, antes de `lines.length` e `total`. |
| B4 | A4(a) semeava até 6 farmácias `verified` no topo de todo time — e `topUpIfDeadAir` conta `whatsapp_verified_at` como sinal de vida (`tool-executor.ts:1279`), disparando só com `live === 0`. Isso garantiria `live>=1` em 100% dos pedidos e **mataria de vez** o único mecanismo automático de "procurar mais farmácia" — exatamente o que travou o pedido da Lud (Droga Ryos + Drogasil verificadas e mudas = live 2). | O conserto do D4 vai **no mesmo commit** de A4(a), ou A4(a) não mergeia. "Sinal de vida" passa a ser resposta **neste pedido**. E o one-shot vira ciclo, teto 4. |
| B5 | A6 oferecia *"me diz 'resolve' que eu aciono"* e **não existe handler para 'resolve'** — grep por escalate/handoff nos handlers só acha `PLATFORM_HANDOFF_SUMMARY` (link do e-commerce) e o `red-flag-handler` (emergência clínica). A palavra cairia no loop agêntico e o modelo improvisaria "já acionei a equipe": o D5 reencenado dois turnos depois, com a paciente esperando socorro. | Tool determinística `escalate_to_human(orderId)`, no mesmo commit da oferta. Sem ela, A6 é **alerta silencioso** e não menciona pessoa nenhuma. |
| B6 | O gate era `sendFounderAlert() === true` — e a função devolve `true` logo após `dispatchOutbound` não lançar (`founder-alerter.ts:177-196`), isto é, **enfileirado**. Insumo, não resultado. E não existia operação humana definida. | O retorno continua sendo condição **necessária**. A condição **suficiente** passa a ser ACK humano ("ASSUMO `<id-curto>`" em ~4 min). Mais um runbook [F] com nome, horário, dinheiro e entregador. |
| B7 | O melhor cenário do plano mandava uma pessoa com dor até um balcão para ser recusada: pantoprazol 20mg é **tarja vermelha**, e não havia uma linha sobre receita. `checkoutUrl` é um link de carrinho VTEX — não escolhe ponto de retirada, não cria conta, não paga, não sobe receita. | Gate de receita antes de prometer "hoje" (A2.9) + A0.5: o fundador **compra de verdade** uma caixa pelo link exato, cronometrado, antes de qualquer promessa de prazo. |

### Alternativas descartadas (e por quê)

| Alternativa | Por que NÃO |
|---|---|
| **Trocar de provedor WhatsApp (zpro → uazapi / não-oficial)** | O dossiê prova que a MESMA perna, MESMO template frio, converte 68% com clínicas (40 aberturas → 27 respostas; secretárias respondendo em 7 e 28 segundos). O canal funciona. A amostra que sugeriria o contrário é n=5. Trocar seria semanas de risco em cima de ruído estatístico. |
| **Reescrever o motor de cotação / novo serviço** | Produção viva com pacientes. Regra do projeto. E o motor não está quebrado — está otimizando a variável errada. |
| **Retry / nudge / `contact_attempts` para insistir com a farmácia** | Enquanto D1 não existir, não sabemos se a 1ª mensagem chegou. Insistir num número que talvez nem tenha WhatsApp é gastar template pago, aumentar risco de queda do quality rating da WABA e não mover nada. Fica **depois** de haver eco de entrega real (A-F2), e talvez nunca. |
| **IA de voz ligando para os fixos** | Stack novo (telefonia), semanas, e A7 converte os mesmos estabelecimentos em WhatsApp de celular numa tarde de trabalho humano. |
| **Ligar mais redes do registry (droga-raia, araujo, onofre, panvel)** | Raia/Onofre têm `group: 'RD'`, o mesmo da Drogasil (`registry.ts:44,47`) — o dedup por grupo as descarta de qualquer forma. Adicionar mais remetente lento piora a ordenação. **A exceção a investigar é a Drogaria Rosário** (A0.d) — maior rede de Goiás, ausente do registry, e não é RD. |
| **Desligar o e-commerce ("é só handoff, não é o nosso produto")** | É o único canal que responde. Em 26/08 ele respondeu em 7 segundos. Ele não falhou — foi mal ordenado. |
| **Parceria formal com rede grande / integração iFood-Rappi** | É o caminho certo em 3 meses, não hoje à noite. Vira trilha do FUNDADOR (A8) rodando em paralelo, nunca no caminho crítico. O que entra hoje é o **link de busca** rotulado como o que é (A2.5), não integração. |
| **Concluir qualquer coisa da era nova a partir de n=5** | O dossiê já avisa. Não repetir. |

---

## 3. AÇÕES ORDENADAS

Legenda: **[C]** = código (o agente faz) · **[F]** = fundador (humano/comercial/credencial).

---

### PASSO 0 — as três perguntas de custo zero que podem girar o plano

Nenhum aumento de disparo frio acontece antes de A-F1 voltar.

---

### A-F1 — [F] Meta Business Manager: categoria, status, quality rating · 10 min · ⚠️ **GATE**

**O quê.** Abrir o Meta Business Manager → WhatsApp Manager e responder três coisas:

- **(a)** qual a **CATEGORIA** atual de `cotacao_medicamento_2` — *Utility* ou *Marketing*?
- **(b)** qual o **STATUS** — Active / Paused / Pending / Disabled?
- **(c)** qual o **quality rating** do template **e** do número da perna `agent`
  (Green / Yellow / Red)?

**Por que é a primeira coisa do plano.** Existe uma hipótese viva para o 0/10 e para a seca
de 20 dias (última resposta real de farmácia: **07/08**) que nem o dossiê nem a v1 enumeram:
**se a Meta recategorizou o template como Marketing, ela pode simplesmente não entregar parte
dos envios, em silêncio.** Marketing tem limites de entrega e filtro por engajamento que
Utility não tem. Se for esse o caso, A1/A4/A7 estão consertando o alvo errado — mais tiros
num canal que a própria Meta está estrangulando.

Repare que o dado é consistente com a hipótese: as clínicas usam `atendimento_clinica` e
convertem 68%; as farmácias usam `cotacao_medicamento_2` e convertem 7%. Mesma perna, mesmo
número, mesma máquina. **A diferença está no template, não no canal.**

**Critério, escrito antes de olhar:**
- Se (a) = Marketing → **não subir `TARGET_SLOTS` nem `CHAIN_CAP`**. O caminho crítico passa a
  incluir "recategorizar/resubmeter o template como Utility" antes de qualquer aumento de volume.
- Se (b) ≠ Active → nada do canal frio funciona; isso explica o 0/10 sozinho.
- Se (c) < Green → ver R4: teto duro de aberturas por dia e revisão do texto do template.

---

### A-F2 — [F] Chamado no zpro + posse do Business Portfolio · custo de um e-mail · **PREMISSA A CONFIRMAR**

**O quê, duas perguntas.**

**1) Ao suporte do zpro, uma pergunta binária:**

> "No canal WABA, o webhook de status repassa os estados `delivered`, `read` e `failed` da
> Meta, com `wamid` e `errors[].code`? Se não repassa hoje, é configurável?"

Contexto que justifica a pergunta: em **2.019 ecos de status** gravados em `webhook_events`, o
payload veio SEMPRE `{"status":"sended","ack":1}`. Nunca `ack:2` (delivered), nunca `ack:3`
(read), `wamid` sempre `null`. O zpro confirma "despachei", não "a Meta entregou".

**2) Verificar quem é o dono do Business Portfolio da WABA.** Se for o fundador: **uma WABA
aceita múltiplos apps inscritos**. Isso permitiria rodar uma assinatura própria
**SOMENTE-LEITURA** de webhooks direto da Meta, em paralelo ao zpro, recebendo `delivered` /
`read` / `failed` com `wamid` — **sem tocar no envio e sem migrar número**.

**Isto é o que resolve o D1 de verdade. A9 sozinho jamais resolve** — A9 mede o nosso POST.

> ⚠️ **Registre como PREMISSA A CONFIRMAR, não como fato.** Que uma WABA aceite múltiplos
> apps inscritos é o comportamento documentado da plataforma, mas *não foi verificado nesta
> conta*, e o zpro pode ter configurado o número de forma que impeça. A ação aqui é
> **perguntar**, não implementar.

---

### A0 — [C] Sonda ampliada: o que o e-commerce REALMENTE oferece em Goiânia · 40 min · ⚠️ DECIDE O PLANO

**O quê.** Novo `apps/api/scripts/probe-farmacia-goiania.ts` (padrão dos `verify-*.ts` já no
repo). Para 3 CEPs reais de Goiânia (Setor Sul, Setor Bueno, Campinas) × 3 remédios, chama
`quotePlatformBasket(basket, cep, { timeoutMs: 9000 })` e imprime, por rede.

**Os 3 remédios: pantoprazol 20mg, dipirona 500mg, omeprazol 20mg.**
> Mudança em relação à v1: **fora amoxicilina**. Antibiótico exige *retenção* de receita (RDC
> 20/2011), o que muda a disponibilidade e o comportamento do carrinho — polui o sinal que
> estamos medindo, que é logística, não regulação.

**O que a sonda imprime, por rede (quatro coisas, não uma):**

- **(a)** `total · pricedByCep · delivery.etaText/feeReais · pickup.etaText/feeReais` — o
  `FulfillmentOption` já filtrado, como na v1.
- **(b)** a **contagem de SLAs `pickup-in-point` BRUTOS**, antes de `bestSlasFromLogistics`
  aplicar o filtro `ok()` (`vtex.ts:174-177`, que descarta SLA-sentinela por `MAX_REALISTIC_FEE_CENTS`
  / `MAX_REALISTIC_ETA_MIN`). Sem isso não dá pra distinguir **"não tem retirada em Goiânia"**
  de **"o nosso filtro descartou a retirada que existia"** — duas conclusões opostas com a
  mesma saída vazia.
- **(c)** `pricedByCep` e o **motivo** de `delivery`/`pickup` virem null por rede
  (sem `logisticsInfo`? array de slas vazio? todos reprovados no `ok()`? adaptador não implementa?).
  Distingue **"não existe same-day"** de **"o adaptador não devolve o campo"** — hoje
  Drogasil (rd-adapter) e Ultrafarma devolvem null **por construção**, o que é um fato sobre
  o nosso código, não sobre a rede.
- **(d)** **Drogaria Rosário** — maior rede de Goiás, **ausente do registry** e não investigada
  em lugar nenhum. Bater em `https://www.farmaciasrosario.com.br/api/catalog_system/pub/products/search?ft=pantoprazol`
  (o endpoint VTEX público que o `access: 'rest'` já usa) e ver se responde JSON de produto.
  **Se expuser vitrine VTEX, é UMA LINHA em `registry.ts`** — `{ id: 'rosario', label: 'Drogaria Rosário',
  host: ..., salesChannel: '1', access: 'rest', group: 'Rosario', enabled: true }` — e vale
  mais, para Goiânia, que o A3 inteiro. Uma rede regional com loja no bairro tem chance de
  retirada em 60 min que a Drogal de Ribeirão Preto não tem.

**Rodar:** `railway run --service ia-da-saude-api npx tsx apps/api/scripts/probe-farmacia-goiania.ts`

**Critério de sucesso, escrito ANTES de olhar o resultado:**
**≥1 rede habilitada com opção same-day (pickup, ou delivery com ETA ≤ 1 dia) em ≥2 dos 3 CEPs.**

**Por que é a primeira ação de código.** Se a resposta for "nenhuma", A2 é cosmética e o plano
inteiro gira (§6, R1). Descobrir isso custa 40 minutos; descobrir depois custa uma semana.

---

### A0.5 — [F] A compra REAL, cronometrada · ~R$20 e 1 hora · ⚠️ DECIDE O PLANO

**O quê.** No mesmo dia do A0, num **dia útil às 18h**, o fundador compra **uma caixa de
pantoprazol 20mg pelo link exato que a Xarlote manda** (o `checkoutUrl` real produzido pelo
sistema, com CEP do Setor Sul) e **cronometra até o comprimido estar na mão dele**.

**Registrar cada atrito, na ordem em que aparecer:**

1. O link abre com o carrinho montado, ou perde os itens?
2. Precisou **criar conta**? Quanto tempo?
3. **Dá para escolher retirada na loja pelo link**, ou o link só faz entrega?
4. **Pediu receita?** Em que momento — no carrinho, no checkout, ou só no balcão?
5. Quanto tempo até o e-mail/SMS de **"pronto para retirada"**?
6. Quanto tempo total, porta a porta?

**Por que isto existe.** **Ninguém nunca completou esta compra ponta a ponta.** A tabela do §4
da v1 pulava de "17:55 link no topo" para "18:30 ela está com o pantoprazol" **sem um único
passo verificado no meio**. `checkoutUrl` é um link de carrinho VTEX: ele não seleciona ponto
de retirada, não cria conta, não paga e não sobe receita. Prometer "⚡ retira hoje (60 min)"
em cima disso é assumir seis coisas que nunca foram observadas.

**Critério:** se o fundador **não** conseguir o comprimido na mão em ≤3h por esse caminho, **o
A2 é decoração** e o plano gira para A2.5 + A6 + A7 (§6, R1b). Custo de descobrir: R$20.

---

### A2 — [C] Tempo vira a chave de ordenação — **e o dedup também** · ~4h · **núcleo do plano**

**Arquivo por arquivo:**

**1. `packages/integrations/src/pharmacy-platforms/types.ts`** → `interface FulfillmentOption`
ganha `etaMinutes: number`. Obrigatório, não opcional: `pnpm typecheck` aponta cada
construtor, e ETA sem número é justamente o que produziu o bug.

**2. `packages/integrations/src/pharmacy-platforms/vtex.ts:143-153`** → `pickBestSla` já
calcula `best.rankMin`; devolver `etaMinutes: best.rankMin` junto do `etaText`. É literalmente
devolver um número que já foi calculado e é jogado fora na linha seguinte.

**3. `packages/integrations/src/pharmacy-platforms/index.ts`** → **QUATRO baldes**, e a mesma
função aplicada ao **dedup** e ao **sort**:

```ts
const SAMEDAY_MAX_MIN = Number(process.env['PLATFORM_SAMEDAY_MAX_MIN'] ?? 720);   // 12h
const ONE_BUSINESS_DAY_MIN = 24 * 60;

/** Menor ETA conhecido da cotação. null = a rede não nos deu dado de prazo. */
const fastest = (q: PlatformBasketQuote): number | null => {
  const c = [q.pickup?.etaMinutes, q.delivery?.etaMinutes].filter((n): n is number => n != null);
  return c.length ? Math.min(...c) : null;
};

// 0 = same-day COMPROVADA · 1 = ETA declarado ≤ 1 dia útil · 2 = ETA DESCONHECIDO
// · 3 = ETA declarado > 1 dia
const bucket = (q: PlatformBasketQuote): number => {
  const f = fastest(q);
  if (f == null) return 2;                       // ausência de dado NÃO é prova de lentidão
  if (f <= SAMEDAY_MAX_MIN) return 0;
  if (f <= ONE_BUSINESS_DAY_MIN) return 1;
  return 3;
};
```

**Por que quatro baldes e não três (o refinamento que a v1 não tinha).** Com três baldes
(`rápido · desconhecido · lento`), Ultrafarma e Drogasil — que devolvem `delivery: null,
pickup: null` **por construção do nosso adaptador** e são remetentes de São Paulo —
ranqueariam **acima** de uma rede que declarou honestamente "1 dia útil". Punir a honestidade
é o pior incentivo possível. Com quatro, o desconhecido fica acima do lento comprovado
(balde 2 < balde 3) e abaixo do rápido declarado (balde 2 > balde 1).

> **O princípio do balde de prazo desconhecido fica intacto e é deliberado: rede sem dado de
> logística não é rede lenta; empurrá-la para o fim seria inventar um fato.** (Regra de ouro
> do projeto: *rótulo de ausência não é dado*.) O refinamento para 4 baldes **preserva** o
> princípio — não o dilui.

**4. O dedup por grupo (`index.ts:425-433`) — o conserto que decide se o A2 funciona.**

Hoje:
```ts
if (opts.dedupeByGroup !== false) {
  const best = new Map<string, PlatformBasketQuote>();
  for (const q of quotes) {
    const cur = best.get(q.group);
    if (!cur || q.lines.length > cur.lines.length
        || (q.lines.length === cur.lines.length && q.total < cur.total)) best.set(q.group, q);
  }
  quotes = [...best.values()];
}
return quotes.sort((a, b) => (b.lines.length - a.lines.length) || (a.total - b.total));
```

Este `Map best` roda **antes** do sort e escolhe por cobertura e depois **preço puro**. Pague
Menos e Extrafarma compartilham `group: 'PagueMenos'`; Drogaria São Paulo e Pacheco
compartilham `'DPSP'` (`registry.ts:30-33`). Se a **Pague Menos** (a rede com presença física
real em Goiânia, e a heroína do exemplo do §4) tiver retirada em 60 min por R$18,90 e a
**Extrafarma** frete de 3 dias por R$16,00, **o dedup mantém a Extrafarma** — e a única opção
de hoje é eliminada 30 linhas antes de o núcleo do plano enxergá-la.

Fica:
```ts
if (opts.dedupeByGroup !== false) {
  const best = new Map<string, PlatformBasketQuote>();
  const better = (q: PlatformBasketQuote, cur: PlatformBasketQuote): boolean => {
    if (bucket(q) !== bucket(cur)) return bucket(q) < bucket(cur);          // ⬅️ tempo PRIMEIRO
    if (q.lines.length !== cur.lines.length) return q.lines.length > cur.lines.length;
    const fq = fastest(q) ?? Number.MAX_SAFE_INTEGER;
    const fc = fastest(cur) ?? Number.MAX_SAFE_INTEGER;
    if (fq !== fc) return fq < fc;
    return q.total < cur.total;
  };
  for (const q of quotes) {
    const cur = best.get(q.group);
    if (!cur || better(q, cur)) best.set(q.group, q);
  }
  quotes = [...best.values()];
}
return quotes.sort((a, b) =>
  (bucket(a) - bucket(b))
  || (b.lines.length - a.lines.length)
  || ((fastest(a) ?? Number.MAX_SAFE_INTEGER) - (fastest(b) ?? Number.MAX_SAFE_INTEGER))
  || (a.total - b.total));
```

**Teste obrigatório (sem ele o commit não vai):** dois quotes do group `'PagueMenos'`, um com
`pickup { etaMinutes: 60 }` e total 18,90, outro sem pickup, `delivery { etaMinutes: 4320 }` e
total 16,00 → **o sobrevivente do dedup tem de ser o de 60 min.**

**5. `apps/api/src/handlers/platform-quotes.ts`:**
- `MAX_NETWORKS` 3 → 4, com override `PLATFORM_MAX_NETWORKS`.
- `fulfillmentLine` (linha 26): **retirada primeiro quando for mais rápida**, e prefixo
  `⚡ hoje` quando `etaMinutes <= SAMEDAY_MAX_MIN` **e o gate de receita (A2.9) estiver
  resolvido**. E **atribuir a fonte do prazo**, nunca assumi-lo como nosso:

  `⚡ o site da Pague Menos diz que dá pra retirar hoje (60 min) · ou entrega em 1 dia útil grátis`

  > Por quê a atribuição: o SLA da VTEX reflete **estoque no momento da consulta**, não
  > reserva. Entre a nossa consulta e a chegada dela ao balcão, a caixa pode ter saído. Dizer
  > "o site diz" é verdadeiro; dizer "retira hoje" é uma promessa que não é nossa para fazer.
- Exportar `hasSameDayOption(quotes): boolean` e `fastestEtaMinutes(quotes): number | null`
  (consumidos por A6 e A12).
- **Quando NENHUMA apresentada é same-day**, acrescentar uma linha honesta — e note o texto,
  que é diferente do da v1:

  `\n\n⚠️ Nenhuma dessas chega hoje. Mandei mensagem pra ${n} farmácias do seu bairro e te aviso assim que alguma responder.`

  > **Não escrever "sigo caçando quem entregue agora"** (texto da v1). Isso é o D5 numa forma
  > nova: hoje não existe nada caçando — não há retry, não há nudge, `quotes.contact_attempts`
  > é 0 em todas as linhas do banco (D8). A frase "sigo caçando" só volta a ser verdade
  > **depois** que o ciclo de top-up do A4(d) existir. Enquanto isso, o texto descreve o que
  > de fato aconteceu (mandamos N mensagens) e o que de fato vai acontecer (avisamos quando
  > chegar resposta).

**Testes.** (a) 4 fixtures novas em `tests/pharmacy-platforms.test.ts` provando a ordem
`pickup 60min < delivery 1bd < ambos null < delivery 4bd`; (b) o caso do dedup acima;
(c) **o caso `pickup existe mas etaMinutes é null` → tem de cair no balde 2, nunca no 0**
(o adaptador pode devolver um `FulfillmentOption` sem número; presença de objeto não é prova
de rapidez); (d) rodar A0 de novo e conferir que a saída inverteu.

> ⚠️ **Regressão esperada, não é bug:** `tests/pharmacy-platforms.test.ts` linhas **112, 113 e
> 398** usam `toEqual` **exato** sobre `FulfillmentOption`
> (ex.: `expect(f.delivery).toEqual({ etaText: '2 horas', feeReais: 14.9 })`). Com a
> propriedade `etaMinutes` nova, as três falham. **Atualizar as três no mesmo commit**, somando
> o `etaMinutes` esperado (`120`, `60`, `60` respectivamente). Cito aqui para que não pareça
> regressão na revisão.

---

### A2.5 — [C] Rodapé de última milha · ~1h · **condicionada a A0 ou A0.5 voltarem magros**

**O quê.** Quando **nenhuma** opção apresentada for same-day, incluir no rodapé da mensagem o
**link de BUSCA** do iFood Farmácia / Rappi para o item, rotulado exatamente como o que é:

> *Não é cotação minha, e não consigo garantir preço nem estoque — mas o iFood costuma
> entregar farmácia em ~30 min aqui em Goiânia. Se quiser tentar: <link de busca>*

**O que NÃO é:** não é integração, não cria dependência, não faz cotação, não promete preço,
não promete prazo nosso. É um link de busca com um rótulo honesto.

**Por que entra.** É a única coisa desta rodada com chance real de pôr o comprimido na mão
dela às 18h30 **se a matéria-prima do A2 não existir em Goiânia**. Se A0 voltar cheio, isto
é secundário; se voltar vazio, isto é o produto.

---

### A2.9 — [C] Gate de receita antes de prometer "hoje" · ~2h · **B7**

**O problema.** Pantoprazol 20mg é **tarja vermelha** (venda sob prescrição). O caminho de
compra não checa exigência de prescrição em lugar nenhum. O melhor cenário do plano manda uma
pessoa com dor até um balcão para ser **recusada**.

**O quê.**

1. Nova lista em `packages/shared/src/` — `PRESCRIPTION_REQUIRED_ACTIVES: readonly string[]`
   — de princípios ativos tarja-vermelha. **Começar pelos 30 mais pedidos em `orders`**
   (consulta única no banco; não inventar a lista de cabeça), e marcar cada um como
   `receita-simples` ou `receita-retida` (antibiótico, psicotrópico).
2. Matching com **normalização de acento e case** (a regra de ouro do projeto diz que o `\b`
   do JavaScript não conhece acento; `norm(s) = s.normalize('NFD').replace(/[̀-ͯ]/g,'').toLowerCase()`).
3. Quando bater, **antes de apresentar qualquer opção**, a Xarlote pergunta:
   *"Esse aí só sai com receita. Você já tem a receita em mãos?"* — e a resposta muda o texto:
   com receita, segue; sem receita, a Xarlote diz o que dá pra fazer (levar a receita ao
   balcão, ou procurar atendimento) e **não** apresenta prazo de retirada como se fosse
   resolvido.
4. **Nunca rotular `⚡ retira hoje` sem isso resolvido.** O rótulo `⚡` fica atrás do gate.

**Como validar.** Teste puro: `needsPrescription('pantoprazol 20mg')` → true;
`needsPrescription('dipirona 500mg')` → false; `needsPrescription('PANTOPRAZOL')` → true;
`needsPrescription('amoxicilina')` → `'receita-retida'`. E um teste de fluxo provando que a
string `⚡` não aparece na mensagem enquanto o gate estiver pendente.

---

### A5 — [C] A Xarlote para de anunciar o que não fez · ~1h30 · **quatro textos, não três**

**Achado que fecha o D5, e que continua sendo o coração do plano:** o `claim-guard` **não
podia** ter pego esse caso. Ele roda só sobre o `replyText` do modelo
(`apps/api/src/handlers/inbound-user.ts:2281`), e a frase *"Achei 5 farmácias e já entrei em
contato com elas"* é uma **string hardcoded nossa**, num `sendOutbound` direto em
`startPharmacyDiscovery` (`tool-executor.ts:1573`). O regex `mensagem_a_terceiro` do guard já
contém `\bentrei\s+em\s+contato\b` (`packages/shared/src/claim-guard.ts:78`) — ele teria
bloqueado, se o texto tivesse passado por ele.
**Não era o modelo mentindo: éramos nós.**

**Os quatro textos:**

**1. `tool-executor.ts:1573`** — de *"já entrei em contato com elas ✨"* para:

```
Mandei mensagem pra ${n} farmácia(s) aqui perto ✨ Algumas nem sempre usam WhatsApp,
então pode não vir resposta de todas. Te aviso na hora que chegar a primeira.
```

> **Mudança em relação à v1: cai o `${nRapidas} costumam responder rápido`.**
> `tier === 'celular'` é **inferência por contagem de dígitos** sobre números com quem nunca
> falamos — e a última resposta real de farmácia foi **07/08**. Chamar isso de "costumam
> responder rápido" é uma previsão sem lastro, exatamente a família do D5.
> **Alternativa permitida**, se o fundador preferir um número: contar **apenas**
> `tier === 'verificada'` e escrever factualmente, sem previsão —
> *"${nVerif} delas já responderam pra gente antes"* — e **se `nVerif === 0`, não escrever a
> frase**. Nunca as duas coisas juntas.

**2. `quote-consolidation.ts:620` (`buildFailureReport`)** — *"Falei com 10 farmácias, mas
nenhuma respondeu"* → *"Mandei mensagem pra 10 farmácias e nenhuma respondeu"*. "Falar com"
implica interlocutor; não houve nenhum.

**3. O texto de `expand_pharmacy_search`** — mesma revisão.

**4. 🆕 `quote-consolidation.ts:70` — o texto de 10 minutos que JÁ ESTÁ NO AR.** Hoje ele diz:

> *"As farmácias ainda não responderam — elas costumam demorar um pouquinho no WhatsApp 🙏
> **Sigo insistindo aqui** e te aviso na hora em que a primeira resposta chegar!"*

**Não existe nada insistindo.** O D8 prova: `quotes.contact_attempts` está 0 em todas as
linhas, e uma busca por `contact_attempts` em `apps/` e `packages/` retorna **zero ocorrências
de escrita**. Um disparo só, depois silêncio até o rescue. É a **mesma família do D5, já em
produção**, e nenhuma ação da v1 tocava nela. Fica:

```
As farmácias ainda não responderam — elas costumam demorar um pouquinho no WhatsApp 🙏
Te aviso na hora em que a primeira resposta chegar!
```

**Comentário obrigatório no código, nos quatro pontos:**

```ts
// ⚠️ Este texto NÃO passa pelo claim-guard (é string nossa, não replyText do modelo).
// O guard casaria com o padrão `mensagem_a_terceiro`:
//   /\b(?:falei|avisei|mandei|encaminhei|repassei|enviei)\b[^.!?]{0,45}\b(?:farmacia|drogaria)\b/
// "Mandei mensagem pra N farmácias" CASA com esse padrão. Funciona hoje só porque este
// caminho não passa pelo guard — e será BLOQUEADO no dia em que passar. Se alguém rotear
// os textos hardcoded pelo guard (o que seria certo), este texto precisa ser reconciliado:
// ele é VERDADEIRO (nós de fato mandamos), mas o guard não tem como saber isso sem uma
// tool que sustente o anúncio.
```

**Como validar.** Teste de snapshot dos quatro textos + simulador
(`http://localhost:3002/simulator`) num pedido com time 100% fixo, conferindo que nenhuma
frase afirma contato estabelecido nem insistência inexistente.

---

### A10 — [C] Fim da mensagem duplicada (D6) · 30 min

`quote-consolidation.ts:41`: `scheduleQuoteTimeout(..., force = true)` faz
`scheduledTimeouts.delete(orderId)` mas **não cancela** os três `setTimeout` já armados — nem
guarda handle nenhum. `expand_pharmacy_search` chama com `force` → duas cadeias paralelas no
MESMO pedido. Prova em produção: dois "3min", dois "5min", e a MESMA mensagem à Lud às 18:04
e 18:06.

Guardar os handles em `Map<string, NodeJS.Timeout[]>` e `clearTimeout` em todos quando `force`.

**Como validar:** teste com timers falsos do vitest — `force` duas vezes ⇒ **exatamente 3
timers vivos**.

---

### A1 — [C + F] Realocação de vagas — desmembrada, com aritmética que fecha · **B1**

A v1 tratava isto como "10 minutos de env". Não é: uma das cinco mudanças **encolhia** o time,
e as outras dependiam de um teto de relógio que não existia. Vai em quatro passos.

---

#### A1.0 — [C] TETO DE RELÓGIO no laço de enriquecimento · 30 min · **antes de qualquer orçamento novo**

`startPharmacyDiscovery` roda **dentro do turno da paciente** (`await` em
`tool-executor.ts:1129`) contra `AGENT_LOOP_BUDGET_MS = 75_000` (`inbound-user.ts:28`), que só
é checado **entre** tool calls. O laço `for (const pharmacy of rankedAll)` é sequencial, e cada
candidata pode custar 1 Places Details + 1 `fetchWebsiteHtml` (timeout de 6s). Com
`TARGET_SLOTS = 8`, a condição de parada em `tool-executor.ts:1467` vira **11 candidatas**.

Antes do laço:
```ts
const enrichDeadline = Date.now() + Number(process.env['PHARMACY_ENRICH_BUDGET_MS'] ?? 25_000);
```
No topo do laço:
```ts
if (Date.now() > enrichDeadline) { backupCandidates.push(pharmacy); continue; }
```

As excedentes **não somem** — viram backup, que o top-up (A4d) consome.

> Correção de escala em relação a um dos revisores: **não há corrida de turnos.**
> `TURN_LOCK_TTL_MS` é **300s** (`inbound-user.ts:364`), não 180s. O dano real é **latência
> para a paciente no pedido urgente** — que é justamente o que este plano promete melhorar.
> Um laço de 11 candidatas × (Details + 6s de scraping) pode facilmente comer o orçamento de
> 75s do turno e deixar a Xarlote muda por um minuto. Isso não é aceitável num pedido de dor.

---

#### A1.1 — [F] As três envs de risco ~zero · 10 min · aplicar já, sem esperar A-F1

No Railway (api **e** worker):

| var | de → para | por quê |
|---|---|---|
| `PHARMACY_EAGER_PRESENT_COUNT` | 2 → **1** | A 1ª cotação que chegar aos 3 min já vira mensagem. Velocidade > completude (preferência declarada do fundador, `quote-consolidation.ts:22`). |
| `PHARMACY_WAME_BUDGET` | 4 → **8** | Mineração de wa.me é o que converte fixo em celular real. Era o gargalo: **1** site minerado no pedido inteiro da Lud. |
| `PHARMACY_DETAILS_BUDGET` | 12 → **20** | Details traz o website (grátis, mesma chamada) que alimenta a mineração. Custo ≈ US$0,017/chamada → +8 ≈ **US$0,14/pedido** (ver A12/economia). |

Nenhuma destas aumenta o número de **disparos frios** — só a qualidade da lista. Por isso não
dependem de A-F1. Reverter = trocar a env de volta, 60 segundos.

---

#### A1.2 — [C] `PHARMACY_CHAIN_CAP` deixa de ser pré-filtro por nome e vira pós-filtro por tier · 1h · **o conserto do B1**

**O bug da v1.** `tool-executor.ts:1442`:
```ts
const rankedAll = [...preferred, ...independentes, ...redes.slice(0, PHARMACY_CHAIN_CAP)];
```
Com `CHAIN_CAP = 0`, no pedido real da Lud (log: `Seleção v2: 5 independente(s), 2/13 rede(s)`)
o pool inteiro vira **5** — e `TARGET_SLOTS = 8` fica **inatingível**, com os orçamentos
elevados de Details/wa.me ociosos. Pior: a **Drogasil** daquele pedido era `[verificada]` e
**CELULAR** (+5562998465310), uma das duas únicas não-fixo do time. `CHAIN_CAP = 0` a apaga.

**O conserto.** O problema nunca foi "rede"; foi "balcão de rede com telefone fixo". E o tier
só é conhecido **depois** de `enrichPharmacyCandidate`. Então o cap muda de lugar:

```ts
// Cap de CANDIDATAS de rede consideradas (não do time final). Sobe porque a decisão
// agora é por tier, depois do enrich — e um balcão fixo de rede custa só 1 Details.
const PHARMACY_CHAIN_REVIEW_CAP = Number(process.env['PHARMACY_CHAIN_REVIEW_CAP'] ?? 6);
const rankedAll = [...preferred, ...independentes, ...redes.slice(0, PHARMACY_CHAIN_REVIEW_CAP)];
```

E, na atribuição de pool (hoje `tool-executor.ts:1489-1492`):

```ts
if (isPref) preferredPool.push(enriched);
else if (isPharmacyChain(pharmacy.name) && enriched.tier === 'fixo') {
  // Balcão de rede com FIXO: quase só auto-resposta, e a rede já está sendo cotada
  // no e-commerce em paralelo. Vai pro backup, não gasta vaga do time.
  backupCandidates.push(pharmacy);
  continue;
}
else if (enriched.tier === 'verificada' || enriched.tier === 'celular') slotPool.push(enriched);
else fixoPool.push(enriched);
```

**Resultado no pedido da Lud:** o pool de candidatas sai de 7 para 11; a Drogasil
`[verificada/celular]` **passa**; os balcões fixos de rede vão pro backup em vez de ocupar
vaga. **O time cresce em vez de encolher** — que era a promessa da v1 e o oposto do que ela
fazia.

`PHARMACY_CHAIN_CAP` fica deprecado; documentar no comentário do código para ninguém
ressuscitá-lo.

---

#### A1.3 — [F] `PHARMACY_TARGET_SLOTS` em **dois passos**, e só depois de A-F1 · 5→6, medir, 6→8

`5 → 6`, rodar **5 pedidos reais**, olhar o log `Time final (N)`, e só então `6 → 8`.

**A verdade que a v1 escondia atrás desta env:** o Places devolveu **5 independentes** naquele
bairro. `TARGET_SLOTS = 8` não fabrica candidatas — **8 tiros dependem de A1.2 (redes com
celular voltam ao pool), A4a (as 44 verificadas do diretório entram) e A7 (celulares reais
semeados), não da env.** Subir a env sem essas três é escrever 8 e receber 5.

E **não subir nada disto antes de A-F1 voltar**: se a Meta recategorizou o template como
Marketing, mais tiros num canal estrangulado só queima quality rating.

---

### A4 — [C] O time passa a ser "quem atende" — **e o D4 conserta no mesmo commit** · 4-5h · **B4**

Quatro mudanças, **e as (a) e (d) são inseparáveis**.

---

**(a) Semear o time com quem já respondeu, antes do Google.**

Nova função em `apps/api/src/handlers/supplier-directory.ts`:
`nearbyVerifiedPharmacies(lat, lng, radiusKm = 8, limit = 6)` → `suppliers` com
`type='pharmacy'`, `whatsapp_verified_at is not null`, `status='active'`, dentro de uma
bounding box de lat/lng, ordenadas por distância. São as **44** que já conversaram com a
gente — a coorte de 55%. Em `startPharmacyDiscovery`, entram no `slotPool` **antes** do laço
de enriquecimento, com dedup por `supplierId` e por telefone contra o que vier do Places.

> 🚨 **(a) NÃO MERGEIA SEM (d).** Este é o bloqueante B4. `topUpIfDeadAir`
> (`tool-executor.ts:1279`) conta `whatsapp_verified_at` como sinal de vida:
> ```ts
> if (sup?.whatsapp_verified_at) { live++; continue; }
> ```
> e o top-up só roda com `live === 0`. Semear deliberadamente até 6 farmácias `verified` no
> topo de **todo** time garante `live >= 1` em **100%** dos pedidos: **o único mecanismo
> automático de "procurar mais farmácia" morre de vez.** Foi exatamente isso que travou a
> busca no pedido da Lud — Droga Ryos + Drogasil verificadas **e mudas** = `live 2`, top-up
> nunca disparou. A v1 amplificava a causa do D4 enquanto prometia curá-lo.

---

**(d) 🆕 Conserto do D4: "sinal de vida" passa a significar vida NESTE pedido — e o one-shot vira ciclo.**

Em `topUpIfDeadAir` (`tool-executor.ts:1255-1305`):

```ts
// ANTES: histórico de OUTRA época contava como vida neste pedido.
//   if (sup?.whatsapp_verified_at) { live++; continue; }
// DEPOIS: vida = resposta NESTE pedido. Só isso.
let live = 0;
for (const q of quotes ?? []) {
  if (q.status === 'negotiating' || q.status === 'quoted') { live++; continue; }
  const { count } = await db.from('messages')
    .select('id', { count: 'exact', head: true })
    .eq('conversation_id', q.conversation_id)
    .eq('direction', 'in');
  if ((count ?? 0) > 0) {
    live++;
    void markSupplierVerifiedById(q.supplier_id as string).catch(() => {});
  }
}
```
O `whatsapp_verified_at` **continua sendo escrito** quando há resposta real (a verificação
positiva de passagem, que é correta) — só deixa de ser **lido** como prova de vida presente.

**E o ciclo.** Hoje a função termina com `pharmacyBackups.delete(orderId)` incondicional: roda
**uma vez só**, teto 2, e nunca mais. Passa a:

```ts
const PHARMACY_MAX_TOPUP = Number(process.env['PHARMACY_MAX_TOPUP'] ?? 4);   // era 2

// ...no fim de topUpIfDeadAir:
info.rounds = (info.rounds ?? 0) + 1;
const seguePodendo = info.candidates.length > 0 && info.rounds < PHARMACY_MAX_TOPUP;
if (seguePodendo) scheduleTopUpCheck(orderId);   // re-arma: enquanto quoting, sem cotação, com backup
else pharmacyBackups.delete(orderId);
```
As guardas de saída já existentes continuam valendo e são as certas: sai se o pedido não está
mais `quoting`, e sai se já há cotação `quoted`.

> **Só depois de (d) estar no ar** a frase *"sigo caçando"* do A2 pode voltar a ser dita — e
> ainda assim eu prefiro não dizê-la (o top-up adiciona farmácias, não persegue as antigas).

---

**(b) Fixo no time: é PISO, não teto — e o alerta é código, não intenção.**

A v1 se contradizia: o código proposto era `fixoPool.slice(0, FIXO_CAP)` (**teto rígido**) e a
mitigação escrita no R3 dizia que era **piso**, com fixo completando até `TARGET_SLOTS`.
**A leitura correta é o piso**, e ela vale por uma razão incômoda que precisa estar escrita:

**o código de hoje JÁ FAZ o piso.** `tool-executor.ts:1496`:
```ts
const finalTeam = [...preferredPool, ...slotPool, ...fixoPool].slice(0, cap);
```
`fixoPool` vem **depois** de `slotPool` no concat — fixo **nunca desloca** um celular/verificada;
ele só ocupa o que sobrou. O `slice(0, FIXO_CAP)` da v1 seria um **teto**, e teria produzido
exatamente o cenário que o R3 dizia querer evitar: um time de 3 num bairro pobre de celular.

Então **(b) não é uma mudança de ordenação**. É duas coisas, ambas código, no mesmo commit:

1. **Manter o concat como está** (documentando por quê, para ninguém "consertar" depois).
2. **O alerta prometido no R3 vira código:**
```ts
if (finalTeam.length < 4) {
  await writeLog('warn', 'places', `⚠️ Time raso (${finalTeam.length}) — pool esgotado`, {
    traceId: ctx.traceId, orderId,
    tiers: finalTeam.map((e) => e.tier), backups: backupCandidates.length,
  });
  void sendFounderAlert({
    severity: 'high', throttleKey: `time-raso-${orderId}`,
    title: '🔎 Time de farmácias raso',
    body: `${finalTeam.length} farmácia(s) no pedido — pool de candidatas esgotou.`,
  }).catch(() => {});
}
```

A realocação de vaga de verdade acontece em **A1.2** (balcão fixo de rede sai do time e vai
pro backup) e em **(a)+(c)**, não em um `slice` no `fixoPool`.

---

**(c) Parar de aceitar fixo como resultado da mineração.**

`enrichPharmacyCandidate`, passo 3 (`tool-executor.ts:1207-1210`): a condição de aceite hoje é
```ts
if (mined && !isPlaceholderPhone(mined) && !isServiceNumber(mined)) { whatsappE164 = mined; ... }
```
Prova de que isso não serve: o log de 26/08 diz literalmente
*"⛏️ WhatsApp minerado do site de Drogaria Plus: landline"* — gastamos orçamento de mineração
para trocar um fixo por **outro fixo**.

Adicionar `&& classifyBrPhone(mined) === 'mobile'` para promover a `whatsapp_e164`. O fixo
minerado **continua sendo gravado em `phone_e164`** (é telefone humano de verdade; serve pro
A7 e pro A8), nunca como canal de WhatsApp.

> ⚠️ **Nota de escopo honesta:** naquele dia, o fixo minerado da Drogaria Plus foi **o único
> resultado da mineração inteira**. Rejeitá-lo, isoladamente, tira uma candidata do time. É
> por isso que (c) só vale acompanhado de (a) e A1.2, que **repõem** candidatas de qualidade.
> Se (c) for para produção sozinho, o time da Lud teria ido de 5 para 4. Não mergear sozinho.

**Como validar A4.** (a) Testes unitários da montagem do time (função pura, sem I/O, com pools
sintéticos) — incluindo o caso "bairro com 3 farmácias" provando que o time **não** é
truncado; (b) teste de `topUpIfDeadAir` com uma quote de supplier `verified` **sem** inbound →
`live === 0` → top-up dispara (o caso exato da Lud); (c) em produção, `Time final (N)` deve
trazer ≥4 entradas `[verificada]`/`[celular]`; (d) 7 dias depois, rodar de novo a query de
taxa de resposta por tipo de número do dossiê.

---

### A6 — [C + F] Escalar para gente antes da desistência · **ou completo, ou alerta silencioso** · **B5 + B6**

**A regra que governa esta ação, e que é o aprendizado central da auditoria de agosto:
nunca oferecer socorro humano quando não existe socorro humano.** A v1 tinha o princípio
certo e o gate errado. Aqui vão os dois.

**O gatilho.** Em `quote-consolidation.ts`, dentro de `scheduleQuoteTimeout`, um novo timer
`PHARMACY_ESCALATE_MIN` (env, default **8** min — a Lud desistiu aos 56, e aos 8 ainda
restavam 48 minutos de chance). Dispara se, no momento: o pedido segue `quoting`, há **0**
cotações `quoted`, e o canal de plataforma **não** produziu same-day (fonte: A12, Redis).

**A6 SÓ pode oferecer humano se as TRÊS coisas abaixo existirem em código/documento.
Enquanto faltar uma, A6 dispara SÓ o alerta ao fundador e a mensagem à paciente NÃO menciona
pessoa nenhuma.**

---

**(1) [F] Runbook — uma página, escrita antes do primeiro alerta.** Precisa responder:

- **quem atende** (nome e telefone);
- **horário coberto** (ex.: seg-sáb 8h-20h) — e o que a Xarlote diz fora dele;
- **meio de pagamento** (quem paga o remédio, com que cartão/Pix, e como é reembolsado);
- **quem entrega** (motoboy? o próprio? app?);
- **teto de custo por pedido** (acima de X, não assume);
- **a frase exata** que a Xarlote manda quando ninguém aciona em 15 min.

Sem este documento, A6 é uma promessa sem operação atrás — que é literalmente o incidente que
estamos consertando.

---

**(2) [C] O gate deixa de ser "o alerta foi enfileirado" e passa a exigir ACK humano.**

**O bug do gate da v1 (B6):** `sendFounderAlert` devolve `true` logo após `dispatchOutbound`
não lançar (`founder-alerter.ts:177-196`) — isto é, **enfileirado**. Não entregue, e muito
menos lido por um humano. O docstring da própria função afirma o contrário, o que torna a
armadilha pior. O retorno filtra **de verdade** os casos "sem `FOUNDER_ALERT_PHONE`" e
"bloqueado" — é **condição necessária**. Não é **suficiente**. Regra de ouro do projeto:
*falha de insumo não é falha de resultado* — e o converso também vale.

```ts
// T+8min: alerta com pedido explícito de ACK.
const shortId = orderId.slice(0, 6);
const ok = await sendFounderAlert({
  severity: 'high', throttleKey: `sameday-${orderId}`,
  title: '🏥 Pedido sem opção pra hoje',
  body: `${shortId} · ${item} · ${bairro} · ${n} farmácias sem resposta.\n`
      + `Responda "ASSUMO ${shortId}" pra eu oferecer a você ao paciente.`,
});
if (!ok) return;                       // necessário: sem canal, não há o que aguardar

// T+12min (~4 min de janela): o ACK chegou?
const assumido = await founderAckedOrder(shortId, alertSentAt);
```

`founderAckedOrder` é uma leitura simples, sem rota inbound nova: busca `messages` com
`direction='in'` na conversa do `FOUNDER_ALERT_PHONE`, `created_at >= alertSentAt`, cujo
conteúdo **normalizado (sem acento, minúsculo)** contenha `assumo` e o `shortId`.

- **`assumido === true`** → a mensagem à paciente pode oferecer o humano.
- **`assumido === false`** → a mensagem à paciente **não menciona pessoa nenhuma**; manda a
  melhor opção que existe e a frase honesta de progresso. O fundador segue alertado.

---

**(3) [C] A tool determinística `escalate_to_human(orderId)` — o handler que a v1 não tinha.**

**O bug da v1 (B5):** ela oferecia *"me diz 'resolve' que eu aciono"* e **não existe handler
para 'resolve'**. Grep por escalate/handoff nos handlers só encontra `PLATFORM_HANDOFF_SUMMARY`
(o link do e-commerce) e o `red-flag-handler` (emergência clínica). A palavra cairia no loop
agêntico normal, o modelo não tem tool de escalação, e ia **improvisar** — provavelmente "já
acionei a equipe". **A ação criada para curar o D5 reencenava o D5 dois turnos depois, agora
com a paciente esperando socorro por promessa textual explícita.**

A tool nova, registrada no `tool-executor` como qualquer outra:

```ts
// escalate_to_human(orderId) — determinística. Só habilitada quando:
//   order.status === 'quoting'  &&  a oferta de humano JÁ foi feita neste pedido.
// Faz, nesta ordem:
//   1. orders.status → 'escalated'  (e cancela os timers de progresso do pedido)
//   2. assistant_tasks: registro do tool call (regra 7 do CLAUDE.md)
//   3. sendFounderAlert({ severity: 'critical', ... })  — 'critical' IGNORA o throttle
//   4. devolve ao modelo APENAS o que de fato ocorreu, com o resultado de cada passo
```

E a confirmação à paciente descreve só o que ocorreu — *"Avisei a equipe agora, com os teus
dados do pedido. Assim que alguém pegar, te falo aqui."* — nunca *"já acionei e estão
resolvendo"*.

**Reconhecimento.** Sem (1), (2) e (3), A6 **não fala com a paciente**. Alerta silencioso ao
fundador, e o texto para a paciente segue sendo o do A2/A5. Isso é uma versão útil e honesta
de A6, e é melhor do que a versão completa mal feita.

---

**(4) [C] Suprimir o `PROGRESS_NOTE_MS` quando a escalação já falou.** · 3 linhas

Os dois timers vivem no **mesmo** `scheduleQuoteTimeout` (`quote-consolidation.ts:59-74`).
Às **18:02** a paciente receberia a oferta de humano e às **18:04** a mensagem *"As farmácias
ainda não responderam… te aviso na hora"*, que a contradiz e a esvazia.

```ts
const escalatedOrders = new Set<string>();
// no timer de 8 min, ao mandar a oferta:  escalatedOrders.add(orderId);
// no topo do callback de 10 min:          if (escalatedOrders.has(orderId)) return;
```

**A10 não cobre este caso** — são timers distintos dentro da mesma chamada, não duas cadeias
paralelas. Limpar o Set junto com `scheduledTimeouts`.

---

**Como validar A6.** Teste unitário da decisão (função pura: `quoted` × `sameDay` × `alertOk`
× `acked` → os ramos de texto, provando que **nenhum** ramo com `acked === false` contém a
palavra "equipe"/"gente"/"pessoa"); teste do `escalate_to_human` (status muda, `assistant_tasks`
grava, alerta `critical` sai); teste do supressor de progresso; e um pedido de ponta a ponta
no simulador.

**Depende de [F]:** confirmar `FOUNDER_ALERT_PHONE` setada no Railway. (O índice de memória do
projeto registra `TELEGRAM_BOT_TOKEN` ausente, o que já silenciou alerta crítico antes —
conferir de passagem.)

---

### A11 — [C] Parar de receitar (D7) · ~2h · ⚠️ **CAMINHO CRÍTICO** — risco existencial

*"Pra gastrite, omeprazol 20mg em jejum é o caminho"* — medicamento + dose + posologia, **não
solicitados**. Viola a regra 8 do `CLAUDE.md`. A v1 chamava isto de existencial e o deixava
**dependendo só de texto de prompt**. Duas camadas, não uma.

**Camada 1 — prompt.** Endurecer `packages/llm/src/prompts/xarlote.system.ts`: proibição
explícita de **nomear princípio ativo, dose ou posologia que o paciente não nomeou**. A
resposta certa é acolher + cotar o que ele pediu + orientar procurar profissional.

**Camada 2 — pós-filtro determinístico**, no padrão do `claim-guard` e no mesmo ponto de
chamada (`inbound-user.ts:2281`, sobre o `replyText`):

```ts
// Bloqueia texto de saída ao paciente que contenha PRINCÍPIO ATIVO + DOSE quando o
// paciente NÃO nomeou o fármaco antes, neste turno. Reusa a lista do A2.9.
const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const DOSE = /\b\d{1,4}\s?(?:mg|mcg|ml|g|ui)\b/;
// ⚠️ O \b do JavaScript NÃO conhece acento (regra de ouro do projeto). Por isso a
// comparação roda sobre texto JÁ normalizado, nunca sobre o texto cru.
```

Se casar (fármaco não citado pelo paciente **e** dose presente), **não envia**: registra em
`system_logs` com severidade `error`, alerta o fundador, e a Xarlote responde a versão
acolhedora sem dose. É o mesmo desenho do claim-guard, que o projeto já provou funcionar.

**Somar um caso de red-team ao teste do prompt** e um teste do pós-filtro:
*"estou com dor no estômago, o que tomo?"* ⇒ a resposta **não pode conter dose**; e
*"pode cotar um pantoprazol 20mg?"* ⇒ a resposta **pode** repetir "pantoprazol 20mg" (o
paciente nomeou).

Não acelera nada. É o item que, se um dia der errado, encerra a empresa. **Por isso sobe.**

---

### A9 — [C] Verdade sobre o nosso POST · 1h · **fora do caminho crítico** · **B2**

**O que a v1 ia fazer, e por que era o D5 gravado no banco com o painel verde.**
`outbound.queue.ts:501` e `:528` fazem:
```ts
if (outcome === 'sent') await stampDelivery(job.messageId, 'delivered');
```
`'sent'` significa apenas que **o POST pro zpro não lançou**. Passar o `messageId` em
`sendTemplateOpeningToSupplier` **sem antes corrigir o vocabulário** faria as 8 aberturas para
telefone **FIXO** do pedido da Lud gravarem `delivery_status = 'delivered'` — **sem que exista
um único eco de entrega** (2.019 ecos em produção, sempre `ack:1`, `wamid` sempre null).

E quebraria um invariante que já existe e é bom: `stampLastOutboundDelivered`
(`supplier-directory.ts:97-99`) só promove `NULL`/`window_blocked` → `delivered`, **de propósito**,
para nunca sobrescrever veredito conhecido. Com o A9 da v1, o eco real — se um dia vier — encontraria
`'delivered'` já escrito e não teria o que fazer.

**A ordem certa, em dois passos, no mesmo commit:**

**Passo 1 — o vocabulário.**
```ts
// outbound.queue.ts:501 e :528
if (outcome === 'sent') await stampDelivery(job.messageId, 'dispatched');
else if (outcome === 'not-sent') await stampDelivery(job.messageId, 'failed');
```
- `stampDelivery` (`outbound.queue.ts:404`) ganha `'dispatched'` na assinatura e **não** escreve
  `delivered_at` para ele (fica NULL, que é a verdade).
- `supplier-directory.ts:99` passa a aceitar `'dispatched'` na lista de promovíveis:
  `if (msg.delivery_status && !['window_blocked', 'dispatched'].includes(...)) return;`
- **A palavra `'delivered'` só pode ser escrita por `stampLastOutboundDelivered`, a partir de
  eco real.** Documentar isso num comentário nas duas funções.
- Sem migration: `messages.delivery_status` é `text` livre (`0022_consent_and_delivery_truth.sql:23`),
  sem constraint nem enum. Verificado.
- ⚠️ Efeito colateral a conferir: o índice parcial `messages_undelivered_idx`
  (`0022:45-47`, `delivered_at is null and delivery_status is not null`) passa a cobrir as
  linhas `dispatched`. Isso é **correto** (elas de fato não têm confirmação), mas se algum
  painel lê esse índice como "não entregue = problema", tratar `dispatched` como estado
  **neutro**, não falha. Grep confirmou: hoje o único leitor de `delivery_status` fora dos
  escritores é `app-export.ts:81`. Nenhum alarme depende disso — mas confira antes de mergear.

**Passo 2 — o `messageId`.** `apps/api/src/handlers/outbound-agent.ts:355`
(`sendTemplateOpeningToSupplier`): o insert `db.from('messages').insert({...})` não tem
`.select('id').single()`, e o `dispatchOutbound` logo abaixo vai sem `messageId`. O caminho
irmão `sendOutboundToSupplier` (~linha 152) já faz certo — copiar exatamente. Mesmo furo em
`sendTemplateOpeningToClinic` (~linha 375).

**A justificativa reescrita, que precisa estar no commit message:**
> **A9 mede que o NOSSO POST saiu — não que a Meta entregou.** Isso é útil (hoje nem isso a
> gente sabe para abertura fria: as 10 linhas do pedido da Lud têm `delivery_status`,
> `external_id` e `provider_ticket_id` todos NULL) e **não é** a resposta para "a farmácia
> ignorou ou a mensagem nunca chegou?". Essa resposta só vem de **A-F2**.

**A métrica "aberturas frias com `delivery_status` não-nulo: 0%→100%" SAI da §5.** Ela
transformava um artefato nosso — uma coluna que nós mesmos passamos a preencher — em
indicador de sucesso do produto.

**Por que sai do caminho crítico:** não entrega remédio para ninguém, e a informação que ela
produz só vira decisão quando A-F2 responder.

---

### A3 — [C] Fazer a Drogasil/RD reportar prazo e retirada · 2-4h · ⚠️ PREMISSA A VALIDAR

`packages/integrations/src/pharmacy-platforms/rd-adapter.ts` hoje devolve só preço. A Drogasil
é `enabled: true`, tem dezenas de lojas em Goiânia, e é candidata provável a "retira em 1h" —
está invisível na ordenação **por falta de dado nosso**, não por ser lenta.

**PREMISSA A VALIDAR (20 min):** o drogasil.com.br expõe simulação de frete/retirada alcançável
via ZenRows? Sonda `apps/api/scripts/probe-rd-frete.ts` batendo na página de produto/carrinho
com CEP de Goiânia e imprimindo o que voltar.

- **Se sim:** parsear em `FulfillmentOption` com `etaMinutes` real. Vira balde 0 e lidera.
- **Se não (A3'):** campo estático e honesto no `registry.ts` — `sameDayCities?: string[]` por
  rede, preenchido pelo conhecimento do fundador — que coloca a rede no balde 0 **com texto
  hedgeado**: *"costuma entregar/retirar no mesmo dia — confirme o prazo no site"*.
  **Nunca fabricar um número de minutos que não veio de uma simulação.**

> **A mesma disciplina vale para o ramo principal.** Se a sonda voltar com um shape ambíguo
> (um "prazo" que pode ser de entrega ou de separação), **não** converter em `etaMinutes`:
> hedgear. Um número inventado no balde 0 é pior que nenhum número no balde 2 — ele **mente
> com precisão**.

**Prioridade relativa:** se A0.d mostrar que a **Drogaria Rosário** expõe VTEX aberta, ela vem
**antes** do A3 — é uma linha de registry contra 4 horas de scraping, e é a rede com mais
balcão em Goiânia.

---

### A7 — [F + C] Semear o diretório com celulares de verdade · [C] 1h + [F] 2-3h · maior retorno por hora humana

**[F]** Para as ~40 farmácias mais próximas dos bairros onde os pacientes realmente moram
(Setor Sul, Bueno, Oeste, Campinas, Marista), obter o **celular** de WhatsApp: bio do
Instagram da loja, botão wa.me do site, ficha no iFood/Rappi, ou ligando uma vez no fixo e
perguntando *"qual o WhatsApp de vocês pra pedido?"*.

**[C]** `apps/api/scripts/seed-pharmacy-whatsapp.ts`: ingere um CSV
`nome,google_place_id_ou_telefone,whatsapp_e164` e faz upsert em `suppliers.whatsapp_e164`.
Recusa (com relatório na tela, sem gravar) qualquer linha cujo número não seja
`classifyBrPhone === 'mobile'`, seja placeholder ou service.

> 🔒 **Disciplina inegociável do seed: NUNCA gravar `whatsapp_verified_at` a partir de um CSV.**
> Esse carimbo só nasce de **resposta real** — senão envenenamos o sinal que o A4(a) consome
> para escolher e que o A4(d) consome para decidir se procura mais. **É o antídoto direto do
> B4.** Um CSV que carimba `verified` transformaria toda farmácia semeada em "sinal de vida"
> permanente.

**Como validar.** Antes/depois:
`select count(*) from suppliers where type='pharmacy' and whatsapp_e164 is not null` e a fatia
classificada como celular. Depois, a taxa de resposta dos 10 pedidos seguintes.

**Expectativa honesta:** se hoje o time é 20% celular e passa a ser 80%, a chance de ≥1
resposta por pedido sai de ~65% (10 tiros a ~10%) para ~99% (8 tiros a ~50%). **Essa conta
pressupõe que a mensagem chega** — o que A-F1 e A-F2 ainda não confirmaram. Se o template
estiver como Marketing e a Meta estiver engolindo entregas, a conta não vale.

---

### A8 — [F] UMA farmácia parceira, esta semana · piloto mínimo · **a única aposta com defesa de longo prazo**

A v1 escrevia "2-3 farmácias parceiras · semanas". Vira um **piloto mínimo desta semana**:

- **UMA** farmácia. A de melhor histórico em `suppliers` — `whatsapp_verified_at` **e mais de
  uma resposta histórica**. (O dossiê diz que 44 já responderam ao menos uma vez, e que
  atendentes se identificaram pelo nome — "me chamo Nhaytton", "Farmacêutico André Lucas" —
  negociaram frete e ofereceram genérico. Essas pessoas existem e já falaram com a gente.)
- **Um celular dedicado** do lado deles.
- **Um grupo de WhatsApp com o dono**, onde a gente manda o pedido e ele responde.
- **Sem contrato.** Sem integração. Sem prazo. Um aperto de mão e uma semana.

**Oferta:** mandamos pedidos qualificados e prontos pra pagar; eles respondem em ≤10 min no
horário comercial.

**Por que isto sobe de prioridade em relação à v1 — a verdade incômoda:** quando este plano
**funciona**, o desfecho é **um link de carrinho de terceiro, sem afiliado e sem take rate**.
O sucesso acelera a queima de caixa. Isso não bloqueia esta rodada, mas significa que A8 é o
**único** item com defesa de longo prazo — e por isso merece um piloto agora, não "semanas".

Roda em paralelo, **nunca no caminho crítico**. Mas é o que decide o Plano B (§6).

---

### A12 — [C] A métrica que falta e a fonte que o A6 não tem · ~2h

Duas coisas, e a primeira é pré-requisito do A6.

**(1) Persistir a oferta same-day no momento da apresentação.**

`t_hoje` (§5), como estava na v1, **só era computável na perna de WhatsApp**: `quotes.eta_minutes`
existe e é preenchido por `finalizeQuote` (`inbound-supplier.ts:563`), mas o `etaMinutes` do A2
vive **só em memória** e nunca chega ao banco. **A perna que o plano APOSTA é a única que a
métrica não enxerga.** E o A6 precisa saber "houve same-day?" para decidir se escala — hoje ele
não tem fonte, porque `presentPlatformQuotes` é **fire-and-forget** no call-site paralelo
(`tool-executor.ts:1580`: `presentPlatformQuotes({...}).catch(...)`) e o resultado é descartado.

```ts
// platform-quotes.ts
export interface PresentPlatformQuotesResult {
  networksPresented: number;
  itemsCovered: number;
  sameDay: boolean;                 // 🆕
  fastestEtaMinutes: number | null; // 🆕
}
```
Capturar o resultado no call-site e gravar em **Redis** (o mesmo `getRedisClient()` que serve o
turn-lock, `apps/api/src/concurrency/user-lock.ts:50`):
`order:<id>:sameday` = `{ sameDay, fastestEtaMinutes, at }`, TTL 2h.

> 🚫 **NUNCA gravar isso em `orders.summary`.** Esse campo é lido por
> `startsWith(PLATFORM_HANDOFF_SUMMARY)` em `order-state.ts:172` **e** por
> `JSON.parse(activeOrder.summary) as { options?: QuoteOption[] }` em `inbound-user.ts:1762`.
> Corromper `summary` faz **a paciente não conseguir escolher a cotação** — o backstop de
> confirmação para de resolver o "a 2" dela. A v1 sugeria `orders.summary` "com um prefixo
> canônico"; isso quebraria o fluxo de compra que estamos tentando salvar.

**(2) A métrica de DESFECHO que falta: `remedio_confirmado`.**

Follow-up automático **90-120 min** depois da apresentação, no pedido que não fechou:
*"Conseguiu pegar o remédio?"* — e a resposta vira o dado.

**`t_hoje` passa a ser SECUNDÁRIA.** Sem ground truth de desfecho, `t_hoje` é otimizável até
88% **com zero pacientes medicados**: basta a gente ficar bom em *mostrar* uma opção rotulada
"hoje". E o critério do Plano B (§6) repousava exatamente sobre ela.

---

## 4. CAMINHO CRÍTICO

**Ordem nova. A0.5, A2.9 e A11 entraram; A9, A4 e A7 saíram.**

```
PASSO 0  A-F1 (Meta BM, 10 min) ─┬─► GATE de qualquer aumento de disparo frio
         A-F2 (zpro + portfolio) ┘

PASSO 1  A0 (sonda ampliada, 40 min)  +  A0.5 (compra real, R$20/1h)   ⚠️ podem girar o plano
                 │
PASSO 2  A5 corrigido (4 textos, 1h30)
                 │
PASSO 3  A10 (timer duplicado, 30 min)
                 │
PASSO 4  A2 com o dedup consertado (4h)  →  A2.9 (gate de receita, 2h)
                 │                          [A2.5 se A0/A0.5 vieram magros]
PASSO 5  A1.0 (teto de relógio) → A1.1 (envs) → A1.2 (chain cap por tier) → A1.3 (slots, 2 passos)
                 │
PASSO 6  A6 completo (runbook [F] + ACK + escalate_to_human)  OU  A6 = alerta silencioso
                 │
PASSO 7  A11 (parar de receitar — prompt + pós-filtro)
```

**Fora do caminho crítico, e por quê:**
- **A9** — sai até o vocabulário do carimbo estar corrigido; e mesmo corrigido, só mede o
  nosso POST. A cura do D1 é A-F2.
- **A4 e A7** — saem até existir eco de entrega real (A-F2). Sem eco, "a farmácia não
  respondeu" e "a mensagem não chegou" são indistinguíveis, e otimizar a lista de números às
  cegas é gastar hora humana num alvo possivelmente errado. A4(a) **nunca** mergeia sem A4(d).
- **A3, A8, A12(2)** — trilhas paralelas.

**Por que A5 e A10 vêm antes do A2:** custam 2h somadas, são risco quase zero, e param **hoje**
duas coisas que estão machucando pacientes vivos (mensagem duplicada e afirmação sem lastro).
Não faz sentido a paciente esperar 4h de refatoração de ordenação para parar de ouvir que a
Xarlote "falou com 10 farmácias".

**Como ficaria o 26/08 com isto no ar — e o que ainda seria PREMISSA:**

| hora | com o plano | status da premissa |
|---|---|---|
| 17:54 | pedido criado; e-commerce cotado em paralelo | ✅ já funciona hoje |
| 17:54 | *"Esse aí só sai com receita. Você já tem a receita em mãos?"* (A2.9) | ✅ código determinístico |
| 17:55 | *"Mandei mensagem pra N farmácias aqui perto. Algumas nem sempre usam WhatsApp."* (A5) | ✅ código determinístico |
| 17:55 | **Pague Menos Setor Sul — R$18,90 — ⚡ o site diz que dá pra retirar hoje (60 min)** no topo, remessa de 4 dias no fim (A2 + dedup consertado) | ⚠️ **depende de A0**: essa opção existe em Goiânia? |
| 17:56 | se nada same-day: rodapé com link de busca do iFood, rotulado (A2.5) | ✅ código determinístico |
| 18:02 | se nada same-day **e** ACK do fundador em 4 min: oferta de humano (A6) | ⚠️ depende do runbook [F] |
| 18:0x | **ela vai até a loja, apresenta a receita, paga e retira** | ⚠️⚠️ **depende de A0.5** — nunca verificado |
| ~19:45 | *"Conseguiu pegar o remédio?"* (A12) | ✅ código |

**Os dois ⚠️⚠️ são o motivo de A0 e A0.5 estarem no passo 1.** A v1 escrevia "18:30 ela está
com o pantoprazol" como se fosse consequência lógica de "17:55 link no topo". Entre uma coisa e
outra há uma conta, um cadastro, um pagamento, uma receita e um balcão — **nenhum deles
observado uma única vez.**

**Esforço estimado do caminho crítico:** ≈1,5 dia útil de código + ~1h30 do fundador
(A-F1, A-F2, A0.5) + o runbook.

---

## 5. MÉTRICA

### Primária — `remedio_confirmado`

**A paciente confirmou, no follow-up de 90-120 min, que está com o remédio na mão.** Fonte:
A12(2). Binária, por pedido.

- **Linha de base:** desconhecida — **nunca foi medida**. No pedido da Lud: **não** (ela
  desistiu às 18:49).
- **Meta:** ≥40% dos pedidos de medicamento urgente.

> Por que esta é a primária, e `t_hoje` não: **sem ground truth de desfecho, `t_hoje` é
> otimizável até 88% com zero pacientes medicados.** Basta ficarmos bons em *mostrar* uma
> opção rotulada "hoje". A métrica que não pode ser gamificada é a que pergunta à pessoa.

### Secundária — `t_hoje`

**Minutos entre `orders.created_at` e a primeira mensagem de saída que ofereça ao paciente ao
menos uma opção que ele pode ter HOJE** (retirada ≤3h, ou entrega com ETA no mesmo dia, ou
cotação de farmácia com `eta_minutes` preenchido).

- **Fontes, as duas pernas:** `quotes.eta_minutes` (WhatsApp, já existe, `inbound-supplier.ts:563`)
  **e** `order:<id>:sameday` no Redis (plataforma, criado por A12(1)). **Sem A12(1) esta
  métrica é cega justamente na perna que o plano aposta.**
- **Linha de base:** no pedido da Lud, **nunca** (0/1). Em 90s ela recebeu 3 opções, 0
  disponíveis hoje.
- **Meta:** `t_hoje ≤ 5 min` em ≥80% dos pedidos.

### Outras

| métrica | base hoje | meta |
|---|---|---|
| taxa de resposta de farmácia, era nova, por tipo | celular 20% (n=5) · fixo 7% (n=14) | celular ≥45% com n≥40 |
| pedidos que terminam em compra | fechamento histórico ≈7% das cotações; **última resposta real de farmácia: 07/08/2026** | ≥30% |
| pedidos escalados a humano **e com ACK** e resolvidos | 0 (não existe) | contar a partir de A6 |
| quality rating do número `agent` | **desconhecido até A-F1** | Green, sempre |
| **anti-métrica:** mensagens afirmando contato/ação/insistência sem lastro | 3 conhecidas (as 2 da Lud + o "Sigo insistindo aqui" que está no ar em todo pedido) | **0** |

> **REMOVIDA da v1: "aberturas frias com `delivery_status` não-nulo: 0% → 100%".**
> Ela transformava um artefato nosso — uma coluna que nós mesmos passamos a preencher — em
> indicador de sucesso. Com o A9 da v1, essa métrica bateria **100%** com **zero** mensagens
> comprovadamente entregues. É o D5 gravado no banco com o painel verde.

### PREMISSA A VALIDAR (2 min) — dimensiona o A6

```sql
select date_trunc('week', created_at) semana, status, count(*)
from orders where created_at > now() - interval '60 days' group by 1,2 order by 1 desc;
```
≤10 pedidos/semana → o humano no loop (A6) é barato e certo. >50/semana → A6 precisa virar
plantão com escala, e A7/A8 sobem para o caminho crítico.

### PREMISSA A VALIDAR — a economia por pedido, antes de subir `TARGET_SLOTS`

Pedir ao fundador **(a)** a categoria Meta do template (A-F1) e **(b)** o **preço unitário de
conversa/template no painel do zpro**, e somar:

| item | quantidade/pedido (com A1 completo) | custo unitário | subtotal |
|---|---|---|---|
| Google Places Details | até 20 | ≈ US$0,017 | ≈ US$0,34 |
| Places Nearby Search | 1-2 | a confirmar | — |
| ZenRows (rd-adapter) | 1-3 | a confirmar no painel | — |
| Template WABA `agent` | 8 | **a confirmar — muda 8× entre Utility e Marketing** | — |
| LLM (turno + enricher) | ~1 pedido | a confirmar | — |

**Colocar o número fechado no plano antes de subir `TARGET_SLOTS` de 6 para 8.**

E a verdade incômoda, registrada: **quando o plano FUNCIONA, o desfecho é um link de carrinho
de terceiro, sem afiliado e sem take rate. O sucesso acelera a queima.** Isso não bloqueia
esta rodada — mas é o que transforma o **A8** na única aposta com defesa de longo prazo.

---

## 6. RISCOS E O QUE FAZER SE DER ERRADO

**R1 — A0 volta vazio: nenhuma rede habilitada tem retirada nem same-day em Goiânia.**
É o maior galho do plano. Então A2 é cosmética, e o caminho crítico vira **A2.5 (link de última
milha) + A3' (campo honesto `sameDayCities`) + A6 (humano) + A7 (celulares reais)**, com A8
virando urgente. Custo de descobrir: 40 minutos. *Detecção: a própria saída do A0, com os
quatro pontos (a)-(d) — em especial (b) e (c), que distinguem "não existe" de "o nosso filtro
comeu".*

**R1b — 🆕 A0 volta cheio mas A0.5 falha: a opção existe no JSON e não existe no balcão.**
O link não deixa escolher retirada; ou o site exige conta e 20 minutos; ou o balcão pede a
receita que a paciente não tem. Então o rótulo `⚡ retira hoje` é **pior que inútil** — manda a
pessoa com dor até uma recusa. Mitigação: o rótulo fica atrás do gate A2.9 **e** só é ligado
depois que A0.5 tiver passado uma vez. *Detecção: o cronômetro do fundador.*

**R2 — A mudança de `CHAIN_CAP` sai pela culatra.** Agora ela **aumenta** o pool (A1.2), então o
risco inverteu: mais candidatas de rede consomem `PHARMACY_DETAILS_BUDGET` e tempo de laço.
Mitigação: A1.0 (teto de relógio) entra **antes**, e `PHARMACY_CHAIN_REVIEW_CAP` é env —
reverte em 60s. Farmácia **nomeada** pelo usuário continua passando (`preferred` ignora tudo).

**R3 — A4 encolhe o time num bairro pobre de celular.**
Mitigação **escolhida e escrita**: fixo é **PISO, não teto** — o time é montado e, se ficar
abaixo de `TARGET_SLOTS`, **fixo completa** (que é o que o concat de `tool-executor.ts:1496` já
faz, e por isso ele **não muda**). O `slice(0, FIXO_CAP)` da v1 era um teto rígido e teria
produzido exatamente o cenário que esta mitigação diz evitar. *Detecção: o alerta
`finalTeam.length < 4` é **código no mesmo commit** (A4b), não intenção.*

**R4 — Quality rating da WABA.** ⚠️ **A v1 errava a estatística.**
Quality rating é uma **TAXA sobre os envios recentes daquele número** — então **volume baixo o
torna MAIS volátil, não menos**. A v1 dizia "8-10 templates/pedido a ~5 pedidos/dia é volume
trivial". **2 denúncias em 40 envios semanais é catastrófico**, precisamente porque o
denominador é pequeno.

E o rebaixamento é **POR NÚMERO**: a perna `agent` que dispara para as farmácias é a **MESMA**
que atende as clínicas com **68% de resposta** — a parte do negócio que funciona hoje. Perder o
rating do número `agent` é perder o canal das clínicas junto.

**Quatro mitigações:**
1. **Alerta ao fundador quando o rating cair de Green** (checagem manual semanal enquanto não
   houver API; A-F1 estabelece a linha de base).
2. **Teto duro de aberturas frias por número por dia** — env `AGENT_COLD_OPEN_DAILY_CAP`, com o
   excedente indo para o dia seguinte ou para o backup, nunca para o disparo.
3. **Nunca dois disparos pro mesmo número no mesmo pedido** (o dedup por telefone já existe,
   `usedPhones` em `tool-executor.ts:1485`).
4. **🆕 Testar uma variante de `cotacao_medicamento_2` que se IDENTIFIQUE.** Ex.:
   *"Aqui é a Xarlote, assistente de saúde. Estou ajudando um paciente que precisa de {{1}}
   na região {{2}}. Vocês têm?"* — essa é a **diferença textual mais visível** entre o template
   que converte 68% (clínicas) e o que converte 7% (farmácias). O comentário atual em
   `template-registry.ts:52` diz explicitamente que o objetivo é a farmácia *"quase não
   perceber que fala com uma IA"* — o que **maximiza a chance de denúncia** por parte de quem
   se sente enganado, e conflita com a regra 2 do `CLAUDE.md` (nunca fingir que a Xarlote é
   humana). Aprovar a variante na Meta e rodar A/B.

**R5 — O fundador não está alcançável às 18h e A6 prometeu humano.** Mitigação: a oferta do
humano só aparece com **ACK explícito** ("ASSUMO `<id>`") dentro de ~4 min — não com
`sendFounderAlert() === true`, que só prova enfileiramento. Sem ACK, a mensagem não menciona
pessoa nenhuma. *Detecção: contar, na métrica, alertas enviados vs. ACKs recebidos.*

**R6 — Os scrapers quebram em silêncio.** O canal que passa a carregar o desfecho é um conjunto
de raspadores não-oficiais (VTEX REST, ZenRows, adaptadores próprios). Mitigação: transformar a
sonda A0 em **cron diária**, alertando o fundador quando o número de redes que devolvem
resultado cair abaixo de 3. Seguro barato para a viga mestra.

**R7 — 🆕 O template está como Marketing e a Meta está engolindo entregas.** Então A1, A4 e A7
estão consertando o alvo errado — e a "seca de 20 dias" (última resposta de farmácia: 07/08)
tem uma explicação que nenhum diagnóstico nosso enumerou. *Detecção: A-F1, 10 minutos.*
*Ação: recategorizar/resubmeter antes de qualquer aumento de volume.*

---

### PLANO B — e se farmácia de bairro simplesmente não for canal viável?

**O critério da v1 estava mal formado** e precisa de três coisas que ele não tinha: **data,
dono e eco de entrega**. Como estava — *"20 pedidos, tier celular <30% ⇒ canal inviável"* — a
taxa mistura **três causas indistinguíveis**: (1) a mensagem não chegou, (2) a Meta engoliu,
(3) a farmácia ignorou. E a decisão que ela dispara **muda a promessa do produto**.

**Critério de decisão, escrito antes do experimento:**

> **Até 30/09/2026, dono: o fundador.** Se, nessa data, **A7 não tiver semeado ≥40 celulares**
> **OU** a taxa de resposta do tier celular estiver **abaixo de 30% em ≥20 pedidos COM eco de
> entrega disponível** (isto é, com A-F2 respondido e a assinatura de status funcionando),
> **o canal frio sai da apresentação ao paciente.**
>
> Se a data chegar e **não houver eco de entrega**, o critério **não é avaliado** — ele é
> adiado, e o item a executar passa a ser A-F2, não a decisão. **Não decidir sobre a promessa
> do produto com uma taxa de três causas somadas.**

Quando o critério bater, a Xarlote **para de apresentar farmácia de bairro como canal**. A
promessa passa a ser, explicitamente, duas coisas: (1) *o caminho legítimo mais rápido de
comprar* — retirada e entrega expressa das redes, ordenadas por tempo; (2) *o concierge humano*
para o que aquele link não resolve. É um produto menor e honesto — e é o produto que teria
atendido a Ludmila. Farmácia de bairro só volta pela porta do **A8**: parceira, com celular
dedicado e SLA combinado. Nunca mais por disparo frio.

> **A disciplina de escrever o critério do Plano B ANTES do experimento fica intacta.** Ela é
> o hábito mais maduro deste plano. O que mudou foi só o conteúdo do critério — não o hábito
> de fixá-lo antes de olhar o resultado.

---

## 7. O QUE NÃO FAZER

1. **Não trocar de provedor de WhatsApp.** As clínicas respondem 68% na mesma perna, com o
   mesmo template frio, em 7 segundos. O canal funciona; quem está errado é a lista de números
   — ou, possivelmente, a categoria do template (A-F1).
2. **Não implementar retry/nudge/`contact_attempts`.** Sem eco de entrega real (A-F2) não
   sabemos se a primeira chegou; insistir num número sem WhatsApp gasta template pago e
   arrisca o rating. Reavaliar só depois que houver `delivered` de verdade.
   **E, enquanto não existir, não DIZER que estamos insistindo** (A5, texto 4).
3. **Não criar uma tool nova de "urgência" pra LLM.** O problema é de *ordenação*, não de
   vocabulário do modelo. Ele já tem `expand_pharmacy_search` e `message_supplier`. Consertar
   ranking na camada do prompt é empurrar decisão determinística pra dentro de um dado.
   *(A `escalate_to_human` do A6 não é exceção a isto: ela não decide nada — é um gatilho
   determinístico para uma transição de estado que já teria acontecido.)*
4. **Não desligar o e-commerce.** É o único canal que responde.
5. **Não ligar mais redes do registry pra "aumentar o pool".** Raia/Onofre têm `group: 'RD'`,
   o mesmo da Drogasil — caem no dedup por grupo; o resto só adiciona remetente lento e polui
   a ordenação. *(Exceção investigada explicitamente: Drogaria Rosário, A0.d — rede regional
   de Goiás, grupo próprio, com balcão no bairro. É outra coisa.)*
6. **Não concluir nada a partir de n=5.** Vale para "a era nova é pior" e para qualquer número
   que apareça nas duas primeiras semanas.
7. **Não rodar `tsc` + `vitest` em vários agentes em paralelo.** Incidente já registrado no
   projeto: saturou a máquina do fundador e derrubou a execução. **Build serial.**
8. **Não tocar em `orders`/`quotes`/`suppliers` com migration nesta rodada.** Tudo acima cabe
   em código de aplicação, env e Redis. Produção tem paciente em cima; schema fica para depois
   de a Ludmila conseguir o remédio dela. *(Verificado: `messages.delivery_status` é `text`
   livre, sem enum nem constraint — o A9 não precisa de migration.)*
9. **🆕 Não escrever `'delivered'` a partir de nada que não seja eco do canal.** Nem "o POST
   não lançou", nem "a fila aceitou", nem "o zpro disse `sended`". A palavra tem um dono:
   `stampLastOutboundDelivered`.
10. **🆕 Não gravar nada novo em `orders.summary`.** Dois leitores dependem do formato atual
    (`order-state.ts:172` faz `startsWith`, `inbound-user.ts:1762` faz `JSON.parse` esperando
    `{options:[]}`) e corrompê-lo impede a paciente de escolher a cotação.
11. **🆕 Não oferecer socorro humano sem runbook, sem ACK e sem handler.** As três coisas, ou
    nenhuma oferta. Prometer o que o sistema não presta é o incidente que estamos consertando.
12. **🆕 Não rotular `⚡ hoje` antes de A0.5 ter passado uma vez.** Um rótulo de urgência é uma
    promessa; promessa não verificada em produção com paciente com dor é o pior lugar do mundo
    para descobrir que o link não faz retirada.
