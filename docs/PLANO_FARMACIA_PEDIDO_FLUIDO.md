# Plano — o pedido na farmácia perfeito e fluido (caso Ludmila, 10/09/2026)

> Escrito em 13/09/2026. Este documento é o **desenho** da correção definitiva dos seis defeitos
> que apareceram na conversa da Ludmila. Não é uma lista de remendos: cada defeito é rastreado
> até a decisão de arquitetura que o permitiu, e a correção muda essa decisão. Complementa (não
> substitui) `PLANO_FARMACIA_VIDA_REAL.md`, que trata de **fazer a farmácia responder**; este
> trata de **o que acontece depois que ela responde**.

## 0. O que aconteceu, em uma frase por defeito

| # | O que a Ludmila viveu | A decisão de arquitetura por trás |
|---|---|---|
| 1 | "Aflor 1000 Flex, 100 comprimidos" lido de uma receita manuscrita que diz *Daflon 1000 Flex, 1x ao dia* | A leitura do modelo vira **fato** do pedido sem nenhuma checagem externa. |
| 2 | "Suplemento Fixare Flex — R$ 313,90 🛒" com link de compra | O ranqueador das redes aceita produto que bate **metade** do nome ("flex"), por substring. |
| 3 | Farmacêutica: "Seria Daflon?" → Xarlote: "Não, é Aflor 1000 Flex mesmo" | O agente-farmácia defende o pedido como verdade; nada sinaliza que o nome veio de uma foto. |
| 4 | "Venaflon serve sim" | `substitutes_ok` é **obrigatório** no schema da tool → o modelo preenche `true` sozinho; a pergunta nunca é feita à paciente. |
| 5 | "Sim, é o Daflon Flex 1000mg com 30 envelopes" (era Venaflon 30 comprimidos) e "pix" inventado | A cotação guarda **preço**, não **produto**. O modelo do lado da paciente só vê "Coimbra — R$64,90" e chuta. O auto-captura grava `['pix']` fixo. |
| 6 | Frete (R$5), total (R$69,90) e "nome de quem recebe?" (2×) nunca chegaram; 3 dias de silêncio | A conversa com a farmácia é **compartilhada** entre todos os pedidos de todos os pacientes; o roteador acha um pedido de **julho, de outro paciente**, antes de olhar o pedido vivo. O ramo certo existe e é inalcançável. |
| + | Endereço errado usado, correção não salva, "endereço da clínica" sugerido, "Sim" não fechou | Endereço salvo escolhido pelo modelo sem a paciente dizer; correção mid-pedido vira `message_supplier` em vez de gravar; sem âncora de apresentação depois de um update de frete. |

## 1. Princípios (o que muda de verdade)

1. **Fato de produto é estruturado, não texto.** Toda cotação passa a carregar `items_available`
   (`ProdutoCotado[]`): o que a farmácia disse que tem, se é substituto, de onde veio a informação.
   Preço sem produto é "preço de algo que a farmácia não nomeou" — e é apresentado assim.
2. **Nome lido de foto/áudio é hipótese até uma fonte externa confirmar.** A fonte é o catálogo
   das grandes redes (já integrado, <1 s, cacheado): "aflor" não existe em lugar nenhum → a
   Xarlote confere com a paciente ANTES de acionar 5 farmácias.
3. **Consentimento é fala do paciente, nunca default de schema.** `substitutes_ok` deixa de ser
   obrigatório; nulo = "não perguntado". Substituto oferecido pela farmácia é REGISTRADO como
   substituto e apresentado como tal; quem escolhe é a paciente, informada.
4. **Roteamento por estado explícito, com precedência testável.** Um resolvedor puro decide a
   qual pedido pertence a mensagem da farmácia. Pós-venda só captura se a janela dele estiver
   aberta. Pedido cotado e não decidido continua **em conversa**.
5. **A Xarlote sabe o que já foi respondido.** `message_supplier` consulta o estado antes de
   enviar: frete conhecido não se pergunta de novo — se responde.
6. **Endereço é dado do pedido, e correção é gravação.** Corrigir endereço no meio do pedido
   atualiza o pedido, o perfil e avisa a farmácia — numa tool só.

## 2. Desenho por defeito

### 2.1 Leitura da receita (defeitos 1 e 3)
- `start_pharmacy_order.items[].source: 'texto' | 'foto' | 'audio'` (prompt instrui; server
  decide). Novo módulo puro `packages/shared/src/nome-remedio.ts`:
  - `tokenPrincipal(nome)` — a marca/princípio (primeiro token de nome, sem dose/forma/qtd).
  - `nomeExisteNoCatalogo(token, nomesDeProdutos)` — palavra inteira, acento-insensível.
  - `decidirVerificacaoDeNome({source, existe, inconclusivo})` → `'segue' | 'confirmar' | 'segue_sem_verificar'`.
- Handler: antes de criar o pedido, `verificarExistenciaDoRemedio(nome)` busca em 4 redes VTEX
  em paralelo (timeout 5 s, cache Redis 30 d por token). Regras:
  - foto/áudio + não existe → **não cria o pedido**; devolve ao modelo a pergunta exata
    ("Li *Aflor 1000 Flex* na receita, mas não achei remédio com esse nome. Confere pra mim?").
  - texto + não existe → segue (a palavra do paciente vence), item marcado `name_verified=false`.
  - redes fora do ar → inconclusivo → segue, marcado `name_verified=null` (nunca trava pedido).
- Agente-farmácia com item `name_verified=false|null`: prompt diz que o nome pode estar errado;
  **backstop determinístico** `sugestaoDeNomeDaFarmacia(texto, nomePedido)` (regex "seria X?",
  "você diz X?", "é X?") → leva a sugestão à paciente e responde cortesia à farmácia. Nunca insiste.

### 2.2 Ranqueador das redes (defeito 2)
- `scoreProductMatch`: o **token principal é obrigatório** e a comparação é por **palavra inteira**;
  com ≤2 tokens de nome, exige TODOS; com 3+, exige ≥⅔. Números soltos ("1000") continuam
  ignorados — Daflon Flex é "900mg + 100mg" no catálogo, e tratar 1000 como dose derrubaria o certo.
- Prova: "Aflor 1000 Flex" → nada (era Fixare Flex 0,52); "Daflon Flex 1000" → só Daflon Flex
  (era Daflon 1000 comprimidos 0,52 empatado).

### 2.3 Substituto (defeito 4)
- Schema: `substitutes_ok` opcional; descrição: só `true`/`false` se o paciente DISSE.
- Prompt do agente: três estados. Nulo → "registre como SUBSTITUTO e diga que vai confirmar".
- Guarda determinística na saída pra farmácia (`consertarAceiteDeSubstituto`): se o texto do
  agente aceita similar ("serve sim", "pode ser o genérico") e o item não tem `substitutes_ok=true`,
  o texto vira "vou confirmar se pode ser o similar e já te falo".
- Detecção no texto da farmácia (`detectarSubstitutoOferecido`): "só tenho X", "concorrente",
  "similar", "genérico" → `is_substitute=true` mesmo quando o agente fica mudo (auto-captura).

### 2.4 Identidade do produto (defeito 5)
- `quotes.items_available` = `ProdutoCotado[]` (coluna existe, estava sem uso — sem migration).
- `record_quote_price` ganha `product_as_quoted` e `is_substitute`; `payment_methods` deixa de ser
  obrigatório e o prompt para de mandar "use pix se não souber". Auto-captura grava `[]`.
- Apresentação (`consolidateQuotes`): cada opção mostra a linha do produto; substitutos vêm por
  último com "⚠️ similar (não é o X)"; sem identidade → "(a farmácia não confirmou o produto)".
  O `summary` do pedido carrega `product` e `is_substitute` → o modelo enxerga.
- `ESTADO DO PEDIDO` no prompt: "cotou R$64,90 — **Venaflon (substituto)**".
- Guarda na fala da Xarlote (`afirmacaoDeProdutoSemProva`): "sim, é o X" sobre cotação cujo
  produto não contém X → resposta corrigida deterministicamente (mesma família do claim-guard).

### 2.5 Roteamento e pós-cotação (defeito 6)
- `packages/shared/src/rota-farmacia.ts`: `decidirRotaDaMensagem(candidatas, texto, agora)`:
  1. cotação em negociação → `negociacao` (chegada/nome desvia pro pós-venda SÓ com janela aberta);
  2. pedido pós-venda com janela de 72 h aberta → `pos_venda`;
  3. cotação `quoted` de pedido vivo (`quoting|quoted`, sem escolhida, <24 h) → `pos_cotacao`;
  4. `timeout` de pedido <24 h → `tardia`;
  5. nada → `nenhuma` (log com o porquê).
  Teste de regressão: pedido de julho `handed_off` na mesma conversa + cotação de hoje → `pos_cotacao`.
- `pos_cotacao`: o agente roda em modo "cotação registrada" (pode atualizar frete via
  `record_quote_price`, responder cortesia, levar dúvida). Backstops determinísticos
  (`packages/shared/src/pos-cotacao.ts`): `capturarFrete(texto, total)`; pergunta de nome →
  responde "vou confirmar com quem vai receber e já te passo" UMA vez por cotação; se a oferta
  mudou (frete agora conhecido / substituto sinalizado) → **um** update à paciente com o total
  novo e "quer fechar?", re-ancorando `presented_at` (o "sim" genérico fecha pelo backstop 11b).
- `message_supplier`: `perguntaJaRespondida(mensagem, cotação)` — frete/prazo/total já conhecidos
  voltam como observação pro modelo em vez de virar mensagem repetida à farmácia.

### 2.6 Endereço (o "mais")
- `saved_address_label` só vale se o paciente **mencionou** o rótulo/endereço na fala (turno atual
  ou anterior) — senão o handler pergunta "casa, trabalho ou outro?". Consentimento pela fala.
- `save_address` ganha `apply_to_active_order` (default true): atualiza `orders.delivery_*`, e se
  já houver cotação com preço, avisa aquela farmácia UMA vez com o endereço certo.
- Prompt: correção de endereço no meio do pedido = `save_address`; endereço impresso em receita
  é da clínica, nunca de entrega.
- `extractDeliverySector` ignora Qd./Lt./Lote/Casa/Apto/Bloco ("Rua 14, Lt. 20" → "Setor Sul").
- Fechamento: a pergunta "quer fechar com X?" da própria Xarlote vira âncora válida pro "sim".

## 3. O que NÃO muda (de propósito)
- A conversa com a farmácia continua compartilhada por telefone (é o WhatsApp) — o remédio é
  precedência explícita, não uma conversa por pedido.
- O auto-captura de preço continua (perder oferta é pior), mas passa a registrar o que sabe e o
  que não sabe.
- Nenhuma migration: `items_available` e `notes` já existem.

## 4. Como se prova
1. Unitário (vitest, `/tests`): resolvedor (cenário Ludmila + 8 variações), `ProdutoCotado`,
   guarda de aceite, detector de sugestão, intents pós-cotação, ranqueador (Fixare/Daflon),
   extrator de setor, consentimento de rótulo, `perguntaJaRespondida`, guarda de afirmação.
2. Cego com modelo real (harness em scratchpad): agente com "só tenho o Venaflon" e
   `substitutes_ok` nulo; Xarlote lendo foto → `source:'foto'`; "é o daflon flex?" com o bloco novo.
3. Typecheck + suíte completa; deploy api+worker; `uptime_s` zerado; logs 30 min.
4. Reparo do pedido da Ludmila (identidade + frete) e mensagem honesta a ela — **com OK do fundador**.

## 5. Fora deste plano (registrado)
- Clínica da Duda (bot de menu, dedupe por assunto, "3" bloqueado pela sanidade) — próxima leva.
- Farmácias que não respondem (tipo de número) — `PLANO_FARMACIA_VIDA_REAL.md`.
