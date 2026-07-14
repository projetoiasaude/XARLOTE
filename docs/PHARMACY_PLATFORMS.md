# Cotação nas plataformas das grandes redes (sem parceria)

> Descoberta técnica ao vivo em 2026-07-14. Objetivo: quando não há farmácia de bairro
> com WhatsApp válido perto do usuário (só redes grandes), a Xarlote **cota na vitrine
> pública online** da rede e devolve um **link pronto pra pagar** — usuário faz o mínimo.
> Modelo consolidado no mercado (é o que CliqueFarma / Consulta Remédios fazem), só que
> conversacional e no lugar do usuário. Sem parceria; afiliação (self-service) monetiza depois.

## 1. Mapa das redes (probe real do endpoint VTEX REST público)

| Rede | Grupo | Lojas (aprox) | Stack | REST público server-side | Integração |
|---|---|---|---|---|---|
| **Drogasil** | RD | ~1600 | VTEX + BFF GraphQL + **Akamai** | ❌ 403/503 | anti-WAF + GraphQL |
| **Droga Raia** | RD | ~1400 | idem | ❌ 403 | anti-WAF + GraphQL |
| **Pague Menos** | Pague Menos | ~1200 | VTEX | ✅ 206 | conector VTEX genérico |
| **Extrafarma** | Pague Menos | ~400 | VTEX | ✅ 206 | idem (catálogo compartilhado) |
| **Drog. São Paulo** | DPSP | ~900 | VTEX | ✅ 206 | conector VTEX genérico |
| **Pacheco** | DPSP | ~650 | VTEX | ✅ 206 | idem |
| **São João** | São João | ~1200 | VTEX | ✅ 206 | conector VTEX genérico |
| **Araujo** | Araujo | ~250 | VTEX + **Akamai** | ❌ 403 | anti-WAF |
| **Nissei** | — | ~450 | próprio (SPA) | ⚠️ 404 | adaptador dedicado |
| **Panvel** | Dimed | ~500 | próprio | ⚠️ 404 | adaptador dedicado |

- **Grupo A — REST aberto (server-side direto, ZERO fricção):** Pague Menos + Extrafarma +
  DPSP (São Paulo + Pacheco) + São João ≈ **~5.000 lojas** por UM conector genérico.
- **Grupo B — Akamai (403):** RD (Drogasil + Droga Raia, a MAIOR ≈ 3.000 lojas) + Araujo.
  Exige browser headless (Playwright) OU proxy anti-bot (ScraperAPI/ZenRows/BrightData). ROI alto.
- **Grupo C — plataforma própria:** Nissei (SPA), Panvel (Dimed). Adaptador dedicado, fase posterior.

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
- **Fase 3:** Nissei, Panvel e regionais (Rosário em GO/DF etc.) com adaptadores dedicados.
```
