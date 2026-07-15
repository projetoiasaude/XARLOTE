# Cotação nas plataformas das grandes redes (sem parceria)

> Descoberta técnica ao vivo em 2026-07-14. Objetivo: quando não há farmácia de bairro
> com WhatsApp válido perto do usuário (só redes grandes), a Xarlote **cota na vitrine
> pública online** da rede e devolve um **link pronto pra pagar** — usuário faz o mínimo.
> Modelo consolidado no mercado (é o que CliqueFarma / Consulta Remédios fazem), só que
> conversacional e no lugar do usuário. Sem parceria; afiliação (self-service) monetiza depois.

## 1. Mapa das redes (probe real do endpoint VTEX REST público)

Probe ao vivo 14/07 (dipirona). **Grupo A = 10 redes VTEX-abertas LIGADAS** (`enabled:true`):

| Rede | Grupo | Stack | REST público | Status |
|---|---|---|---|---|
| **Pague Menos** | PagueMenos | VTEX | ✅ 206 | 🟢 ligada |
| **Extrafarma** | PagueMenos | VTEX | ✅ 206 | 🟢 ligada |
| **Drog. São Paulo** | DPSP | VTEX | ✅ 206 | 🟢 ligada |
| **Pacheco** | DPSP | VTEX | ✅ 206 | 🟢 ligada |
| **São João** | SaoJoao | VTEX | ✅ 206 | 🟢 ligada |
| **Drogal** (SP) | Drogal | VTEX | ✅ 206 | 🟢 ligada |
| **Venancio** (RJ) | Venancio | VTEX | ✅ 206 | 🟢 ligada |
| **Drogaria Globo** (RJ) | Globo | VTEX | ✅ 206 | 🟢 ligada |
| **Drog. Catarinense** (SC) | Catarinense | VTEX | ✅ 206 | 🟢 ligada |
| **Farmácia Indiana** | Indiana | VTEX | ✅ 206 | 🟢 ligada |
| **Drogasil** | RD | VTEX+BFF GraphQL+**Akamai** | ❌ 403 (tudo, até sitemap) | 🔒 proxy |
| **Droga Raia** | RD | idem | ❌ 403 | 🔒 proxy |
| **Onofre** | RD | idem | ❌ 403 | 🔒 proxy |
| **Araujo** | Araujo | VTEX+**Akamai** | ❌ 403 | 🔒 proxy |
| **Nissei** | Nissei | próprio (Django+ES) | ✅ 200 (API) | 🟢 ligada (adaptador) |
| **Ultrafarma** | Ultrafarma | próprio (Angular SSR) | ✅ 200 (SSR) | 🟢 ligada (adaptador) |
| **Panvel** | Dimed | próprio (Angular BFF) | ⚠️ Azion + headers | 🔧 registry-ready (desligada) |

- **Grupo A — REST aberto (LIGADO, server-side direto, sem custo):** as 10 acima. Um conector
  genérico. Regionais (Drogal/Venancio/Globo/Catarinense) cobrem SP/RJ/SC além do nacional; a
  simulação por CEP já filtra quem não entrega na região do cliente (`withoutStock` → fora do pool).
- **Grupo B — Akamai (403 em TUDO, inclusive sitemap.xml):** RD (Drogasil+Raia+Onofre, a MAIOR) +
  Araujo. **Sem caminho server-side** — SÓ com **proxy anti-bot pago** (ScraperAPI/ZenRows ~US$50/mês)
  OU browser headless. Registry pronto (`enabled:false`); ligar = decisão de custo do fundador + o
  adaptador precisa falar o **BFF GraphQL** deles (`POST /api/next/middlewareGraphql`), não o REST.
- **Grupo C — plataforma própria (adaptador dedicado por rede):** **Nissei** (Django+Elasticsearch) e
  **Ultrafarma** (Angular SSR) são ABERTAS server-side → **LIGADAS, sem proxy, sem custo** (§3b).
  **Panvel** (BFF atrás do Azion) fica registry-ready/desligada.

### Nota — CEP no link (menor fricção)
O **preço já vem pronto** (simulado no CEP do cliente → total exibido). Pré-preencher o CEP *no link
de guest* NÃO é possível no VTEX sem criar um orderForm com session (POST/PATCH shippingData) — não há
parâmetro de URL. Então a fricção mínima hoje = abrir o carrinho montado → confirmar o CEP 1× → pagar.
Eliminar o CEP por completo ("só pagar") = Fase 2 (Xarlote compradora com orderForm próprio + pagamento).

## 2. O "molde" da API VTEX (validado ao vivo)

Base = host da rede. Sales channel padrão `sc=1`. Sem auth. Provado em Pacheco, Pague Menos,
Drogaria São Paulo e São João (@ CEP 74230-100, Goiânia).

### 2.1 Busca de produto (nome, SKU, preço, link)
```
GET {host}/api/catalog_system/pub/products/search?ft={termo}&_from=0&_to={N}
```
Retorna array; por produto (evidência Pacheco, dipirona):
```jsonc
{
  "productName": "Analgésico Aspdip Dipirona 500mg 30 Comprimidos",
  "link": "https://www.drogariaspacheco.com.br/analgesico-aspdip-500mg-30-comprimidos/p", // handoff
  "items": [{
    "itemId": "900680",                 // SKU (usar na simulação e no carrinho)
    "ean": "7891106916660",
    "sellers": [{ "sellerId": "1", "sellerDefault": true,
      "commertialOffer": { "Price": 19.9, "ListPrice": 31.99, "AvailableQuantity": 99999 } }]
  }],
  "Princípio Ativo": ["Dipirona"]        // ajuda o matching medicamento↔produto
}
```

### 2.2 Preço + estoque + entrega/frete/prazo POR CEP (o núcleo)
```
POST {host}/api/checkout/pub/orderForms/simulation?sc=1
Content-Type: application/json
{ "items":[{"id":"{SKU}","quantity":1,"seller":"1"}], "postalCode":"{CEP}", "country":"BRA" }
```
Retorna (evidência Drogaria São Paulo, dipirona @ 74230-100):
```jsonc
{
  "items":[{ "price": 791, "listPrice": 791, "availability": "available" }], // centavos
  "logisticsInfo":[{ "slas":[
     { "name":"NORMAL", "shippingEstimate":"1bd", "price":689 },   // entrega em casa, frete R$6,89
     { "name":"RETIRE NA LOJA (2448)", "shippingEstimate":"60m", "price":0 }
  ]}],
  "pickupPoints":[ ... ]  // lojas físicas pra retirada
}
```
→ SP trouxe 14 SLAs (7 de entrega em domicílio). Pacheco/Pague Menos trouxeram retirada em 60min.

### 2.3 Handoff de pagamento (carrinho pré-montado)
- Link direto do produto: campo `link` acima.
- Carrinho pré-montado (padrão VTEX, **validar na implementação**):
  `{host}/checkout/cart/add?sku={SKU}&qty=1&seller=1&sc=1` → cai no carrinho com o item.
  Usuário só loga e paga. Zero credencial/cartão na Xarlote.

## 3. Grupo B (RD/Araujo) — Akamai

- `catalog_system` e `checkout/pub/*` → **403 (curl) e 503 (mesmo com cookies Akamai no browser)**:
  a RD **desligou o REST público**; só serve pelo BFF `POST {host}/api/next/middlewareGraphql`
  (Next.js), atrás de Akamai. No Chrome real a página e os preços carregam normalmente.
- Caminhos p/ produção (backend headless): (a) **proxy anti-bot** (ScraperAPI/ZenRows/BrightData,
  ~US$ dezenas/mês) fazendo a chamada REST/GraphQL; (b) **Playwright headless** próprio resolvendo
  o challenge Akamai e lendo o BFF. Fazer só depois do Grupo A (RD vale pelo tamanho).

## 3b. Grupo C (plataforma própria) — mapa das APIs (probe ao vivo 15/07)

Cada uma tem site próprio (nem VTEX nem Akamai). Um adaptador dedicado por rede.

### Nissei — Django + Elasticsearch (🟢 LIGADA, `nissei-adapter.ts`, sem proxy)
⚠️ O HTML de `/pesquisa/?q=` traz um **grid DEFAULT fixo** (ninho, gatorade… iguais pra qualquer
termo) — **NÃO os resultados**. Nunca parsear esse HTML. A busca é 100% via API:
- **csrf:** `GET {host}/pesquisa/` → cookie `csrftoken` + `<input name="csrfmiddlewaretoken">`.
- **busca:** `POST {host}/pesquisa/pesquisar` (form `csrfmiddlewaretoken` + `termo=…`, header
  `X-CSRFToken` + `Cookie: csrftoken=…`) → `{"produtos":[{"_id","_source":{"nm_produto","url_produto","is_disponivel"}}],"quantidade"}` (Elasticsearch).
- **preço:** `POST {host}/pegar/preco` (form `csrfmiddlewaretoken` + `produtos_ids[]=…`) →
  `{"precos":{"<id>":{"publico":{"valor_fim"(final),"valor_ini"("de"),"is_disponivel","produto_url"}}}}`.
- Ranqueia por `nm_produto` e só então busca o preço dos melhores ids. Preço **nacional** (não por CEP;
  filial/entrega confirmados no site → handoff). Django CSRF exige o par cookie+token junto no POST.

### Ultrafarma — Angular SSR + Linx (🟢 LIGADA, `ultrafarma-adapter.ts`, sem proxy)
A busca renderiza os cards no **próprio HTML** (SSR) — preço incluso, 1 request:
- `GET {host}/busca?q={termo}` → 302 → `{host}/lp/{termo}` (HTML com os cards).
- Card = `<div class="product-item …">` com `product-item-name`, `<a class="product-item-link" href="/{slug}">`,
  `product-item-price-info` (preço), `product-item-old-price` ("de"), img `/produtos/{id}/small`.
- Parser divide por container `product-item` (isolado — lookahead exclui `-name`/`-price`) pra não cruzar
  cards. Preço **nacional** (online-nacional; CEP/entrega no site → handoff).

### Panvel — Angular + BFF `panvel-ecommerce-bff` (🔧 registry-ready, DESLIGADA)
- Busca: `POST {host}/api/v3/search?type=CSR&uf={UF}` (JSON), mas exige **headers** `user-id`,
  `client-ip`, `sessionId` + body específico, atrás do **Azion Bot Manager** (cookies `az_botm`/`az_asm`).
  Valores sintéticos passam a validação mas dão 500 (precisam ser consistentes com a sessão).
- **ZenRows renderizando** `buscarProduto.do?termoPesquisa=…` (js_render) devolve **preço + nome**, mas o
  **link do produto não sai limpo** (Angular usa routerLink, não `href`) → handoff incompleto.
- Decisão: registry-ready + desligada até (a) capturar a sessão/headers do BFF server-side, ou (b) resolver
  o link no render ZenRows. Menos prioritária (forte no Sul; fundador em GO). Nunca quebra o pool (sem adaptador → null).

## 4. Arquitetura do conector (proposta)
```
packages/integrations/src/pharmacy-platforms/
  registry.ts        // [{name, host, salesChannel, access:'rest'|'akamai'|'custom', enabled}]
  vtex.ts            // searchProducts(host,term) · simulateByCep(host,sku,cep) · buildCartLink(host,sku)
  matching.ts        // casa pedido (nome/princípio ativo/dosagem/qtd) ↔ produto; ranking; evita kit errado
  akamai.ts          // Grupo B: proxy anti-bot / headless (fase 2)
  nissei.ts panvel.ts// Grupo C (fase 3)
  index.ts           // quoteFromPlatforms(term, cep) => PlatformQuote[]  (paralelo, cache-first)
```
- **Cache-first** por (rede, sku, cep-prefixo 5díg), TTL 30–60min (preço muda devagar).
- **Timeout + retry + concorrência baixa** (não martelar; parecer tráfego normal).
- **Matching** é o ponto crítico de qualidade: casar dosagem/quantidade/genérico-vs-marca; nunca
  cotar "Kit Novalgina+Allegra" quando pediram dipirona; confirmar com o usuário quando ambíguo.

## 5. Fluxo híbrido (WhatsApp bairro + plataformas → pool → handoff)
1. Usuário pede remédio (+ CEP). Xarlote dispara **em paralelo**:
   - (a) WhatsApp pras farmácias de bairro com número REAL (sistema de alcance já em produção);
   - (b) `quoteFromPlatforms(term, cep)` nas redes VTEX (Grupo A já; RD via anti-WAF na fase 2).
2. Conforme chegam (plataformas em segundos; WhatsApp assíncrono), monta um **pool** e apresenta:
   *"🏪 Farmácia São Jorge (bairro) R$X, entrega 40min · 💊 Drog. São Paulo R$Y, entrega 1 dia
   (R$6,89) ou retira em 1h · 💊 Pague Menos R$Z"*.
3. Cliente escolhe:
   - **plataforma** → Xarlote manda o **link de carrinho pré-montado** ("é só tocar e pagar");
   - **farmácia de bairro** → segue o fechamento atual (a farmácia entrega).
4. Filosofia: **Xarlote faz o máximo (buscar, cotar, montar carrinho); usuário faz o mínimo (pagar).**
   Resolve de vez o "só tem rede perto e não cotei nada": sempre há ao menos as opções de plataforma.

## 6. Riscos & mitigação (honesto)
1. **Akamai (RD/Araujo):** custo de proxy/headless. Grupo A não precisa. Fazer RD na fase 2.
2. **ToS / rate-limit:** consulta a catálogo público é o que comparadores fazem, mas em escala pode
   apanhar bloqueio → cache agressivo, concorrência baixa, header realista, e **afiliação oficial**
   (self-service) que legitima + monetiza (comissão por venda encaminhada).
3. **Receita/controlados:** validados no checkout da PRÓPRIA rede; a Xarlote não dispensa (vantagem
   vs. vender por dentro agora).
4. **Matching de produto:** risco de cotar dosagem/marca errada → ranking + confirmação do usuário.
5. **Manutenção:** conector VTEX é estável (plataforma padronizada); adaptadores próprios
   (Nissei/Panvel) e anti-WAF exigem cuidado contínuo.

## 7. Faseamento sugerido
- **Fase 1 (dias):** conector VTEX genérico do **Grupo A** (5 redes, ~5.000 lojas) + matching +
  cache + pool no fluxo atual + link de carrinho. Cobre a maioria dos CEPs sem parceria.
- **Fase 2:** **RD (Drogasil+Raia)** via anti-WAF (proxy/headless) — a maior rede. + afiliação.
- **Fase 3:** plataformas próprias com adaptador dedicado — **Nissei + Ultrafarma FEITAS (§3b, ligadas)**;
  Panvel registry-ready (Azion); regionais (Rosário GO/DF etc.) como follow-up.
```
