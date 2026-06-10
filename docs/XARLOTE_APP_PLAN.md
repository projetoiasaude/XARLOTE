# XARLOTE APP — Plano completo (interface cliente, Liquid Glass)

> **Status:** planejado em 2026-06-10 · implementação na mesma sessão.
> **O que é:** o aplicativo do **usuário final** da Xarlote — um agente de saúde 360 pessoal.
> Desktop + mobile (PWA), estilo **Liquid Glass**, animado de ponta a ponta, **conectado 100%**
> ao backend que já roda em produção (Fastify + BullMQ + Supabase + uazapi).

---

## 0. Visão

A Xarlote já existe e funciona no WhatsApp: conversa, lembra, compra remédio em farmácia de
verdade, marca consulta, aprende sozinha (profile enricher + memory cards + knowledge graph).
O que falta é a **janela do usuário para dentro dela**: um app onde o cliente vê a mesma
conversa do WhatsApp espelhada ao vivo, conversa por ali também, e enxerga tudo que a IA
sabe e faz por ele — saúde 360, lembretes auto-programados, pedidos em andamento.

**Princípios de produto:**
1. **O chat é o app.** A primeira tela é a conversa. Todo o resto é observabilidade da vida
   do usuário — ações complexas sempre podem voltar pro chat ("fala com a Xarlote").
2. **Um cérebro só.** O app NÃO cria um segundo caminho de decisão: mensagens do app entram
   no MESMO pipeline do WhatsApp (`processInboundUser`), e ações de tela (ex.: escolher
   farmácia) viram mensagens pré-preenchidas no chat — a LLM continua dona do fluxo.
3. **Espelho honesto.** Tudo que existe nas telas vem de tabelas reais que a IA já popula
   (medications, inventory, reminders, orders/quotes, memory cards). Nada de dado fake.
4. **Vivo.** Supabase Realtime nas mensagens e cotações; o app respira junto com a IA.

---

## 1. Arquitetura da entrega

### 1.1 Onde mora
- **Frontend:** dentro de `apps/web` (mesmo Next.js 14 do dashboard), em um segmento novo
  `app/app/*` → URLs `/app`, `/app/saude`, `/app/lembretes`, `/app/atividade`, `/app/perfil`,
  `/app/entrar`. Layout próprio (SEM a Sidebar do dashboard), reusando design tokens,
  primitivos `components/ui/*`, client Supabase e o injetor `ApiAuth`.
  - *Por quê não um `apps/app` separado?* Zero duplicação de config/deploy, mesmas envs,
    mesmos primitivos de vidro. Quando o produto ganhar auth própria, extrai-se limpo.
- **Backend:** novo arquivo `apps/api/src/routes/app.ts`, prefixo **`/app`**, registrado em
  `server.ts` no role `api`. **Diferente do `/api/simulate`** (404 em prod por design),
  o `/app` fica **ATIVO em produção** — é rota de produto, não de dev.

### 1.2 Fluxo do chat espelhado (bidirecional)

```
WhatsApp do usuário ──uazapi──▶ /webhook ─▶ processInboundUser ─▶ messages (in)
                                                    │
App (composer) ──POST /app/inbound──────────────────┘   (MESMO pipeline)
                                                    ▼
                                       Xarlote LLM + tools + memória
                                                    ▼
                                            messages (out)  ──▶ fila outbound ─▶ WhatsApp
                                                    │
                              Supabase Realtime (INSERT em messages)
                                                    ▼
                                        App renderiza ao vivo (chat)
```

- Mensagem mandada **no WhatsApp** → aparece no app (realtime INSERT `direction='in'`).
- Resposta da Xarlote → aparece no app **e** chega no WhatsApp (mesma mensagem, 2 janelas).
- Mensagem mandada **no app** → entra no pipeline real; a resposta chega nos dois lugares.
- Assimetria conhecida e aceita: o texto que o usuário digita NO APP não aparece no
  aplicativo WhatsApp dele (não existe API para "enviar como o usuário") — mas fica no
  histórico canônico (DB) e portanto no app. O fio da conversa nunca se perde.

### 1.3 Autenticação (MVP honesto)
- **Pareamento por telefone**: `/app/entrar` pede o número (máscara BR, normaliza E.164),
  guarda em `localStorage['xarlote.app.phone']`. Todas as queries são escopadas por ele.
- As chamadas à API levam `x-admin-token` (já injetado pelo `ApiAuth` — mesmo modelo F0 do
  dashboard, token único compartilhado). **Suficiente para a fase atual** (produto pessoal
  do founder); a defesa real continua no servidor.
- **Próxima fase (fora deste escopo):** Supabase Auth + OTP via WhatsApp (a própria Xarlote
  manda o código pela fila outbound) + RLS por usuário (F1.D2). O plano de telas já nasce
  compatível (basta trocar o "pairing" pelo login real).

### 1.4 Realtime e frescor de dados
| Dado | Mecanismo | Detalhe |
|---|---|---|
| Mensagens do chat | Supabase Realtime `INSERT` em `messages` filtrado por `conversation_id` | igual ao dashboard/simulador (já funciona em prod) |
| Cotações de farmácia | Realtime `UPDATE` em `quotes` filtrado por `order_id` | igual ao simulador |
| Overview (saúde/lembretes/pedidos) | `GET /app/overview/:phone` + refetch on-focus + intervalo 30s nas telas que o usam | 1 round-trip agregado (Promise.all no servidor) |
| Indicador "digitando" | heurística: após enviar, mostra até chegar INSERT `out` (timeout 75s) | sem canal de typing real |

---

## 2. Backend — endpoints novos (`apps/api/src/routes/app.ts`)

Todos com `preHandler: requireAdminToken` (não usa o gate de prod do simulate).

### 2.1 `GET /app/overview/:phone`
Agrega TUDO que as telas precisam em 1 chamada (espelha e amplia o `/admin/users/:id`):

```ts
{
  user,                      // users (inclui adherence_score_30d, emergency_contact_*)
  conversationId,            // conversa party_type='user' instance sara (p/ realtime do chat)
  conditions,                // user_health_conditions ativas
  allergies,                 // user_allergies
  medications,               // user_medications ativas
  inventory,                 // medication_inventory (estoque: tablets_remaining, depletion)
  treatments,                // treatments (status ativo/pausado/etc)
  prescribers,               // médicos conhecidos
  reminders,                 // pending/sent/snoozed + últimos acknowledged/cancelled (50)
  orders,                    // últimos 10 com quotes(+suppliers) aninhadas
  consultations,             // últimas 5 com consultation_quotes(+clinics)
  memoryCards,               // memory_cards_index (kind, text, confidence, source) top 80
  symptoms,                  // symptoms_log últimos 20
  medicationLog,             // medication_log últimos 30 (adesão na linha do tempo)
}
```
- 404 `{error:'user_not_found'}` quando o telefone não existe → a UI mostra onboarding.
- Tabelas que podem não existir (try/catch tolerante como o admin já faz).

### 2.2 `POST /app/inbound` — enviar mensagem pelo app
Body `{ phone, text }` (Zod). Comportamento:
1. Respeita o interruptor mestre (`xarlote_enabled`) — 503 igual ao simulate.
2. `buildSimulatedInbound({phone, contentType:'text', text})` → `processInboundUser()`.
   - `pushName` default só afeta **criação** de usuário novo (confirmado no código) —
     usuários existentes nunca são renomeados.
3. `await` do turno completo (5–15s) e retorna `{ok, traceId, conversationId}` — a UI não
   espera por isso (bolha otimista + realtime entregam a experiência).
4. Em produção (`WHATSAPP_MODE=uazapi`) a resposta da Xarlote vai pra fila outbound →
   chega no WhatsApp real do usuário também. **Replicação bidirecional de verdade.**

### 2.3 `POST /app/reminders/:id/action` — controlar lembretes
Body `{ phone, action: 'done' | 'snooze' | 'cancel', minutes? }`.
- Verifica posse: `reminder.user_id === user(phone).id`, senão 403.
- `done` → `status='acknowledged'`; `snooze` → `next_run_at = now + minutes||30`,
  `status='pending'`; `cancel` → `status='cancelled'`.
- Grava `event_log` (`app.reminder_action`) para auditoria.

### 2.4 Registro no server.ts
```ts
if (runApi) { app.register(appRoute, { prefix: '/app' }); }
```
CORS: dev já permite localhost; em prod o founder adiciona o domínio do app em
`CORS_ORIGINS` quando publicar (ver §8).

> **Achado de backend (follow-up, NÃO mexido agora):** `reminder-dispatcher` marca
> `status='sent'` e **não recalcula `next_run_at` a partir do `rrule`** — lembrete
> recorrente dispara 1x e para. O app exibe o que existe; corrigir o dispatcher é mudança
> de comportamento em prod (risco de duplo envio) e fica para decisão do founder.

---

## 3. Identidade visual

### 3.1 Direção
Das referências (logo + mascote): fundo **navy profundo** (#05051c → #0a0a14), mascote
axolote **branco-pérola** com rim light azul→roxo→rosa, vidro líquido, glow suave. O design
system existente (`ink/accent/aurora`, `.glass*`) já é compatível — o app usa os MESMOS
tokens com um fundo ambiente próprio, mais profundo e mais azul que o do dashboard.

### 3.2 Mascote (`XarloteMascot`)
SVG vetorial leve desenhado à mão (não o PNG/SVG pesado de 220KB): cabeça arredondada,
6 brânquias (3 por lado), olhos pretos brilhantes, corpo curvado com cauda. Componente React
com **modos**: `idle` (flutua ±5px, brânquias oscilam, pisca a cada 4–7s), `thinking`
(bob mais rápido + brânquias agitadas — usado no typing), `happy` (pulinho com squash &
stretch — usado ao confirmar ações). Tudo `transform`-only (GPU), respeita
`prefers-reduced-motion` (vira estático).

### 3.3 Linguagem de movimento (regras)
- **Metáfora:** "emerge da água" — entra com `y:+10 → 0`, `opacity 0→1`, `blur 6→0`,
  `scale .97→1`; sai afundando. Springs: 320–420 stiffness / 22–36 damping.
- Stagger 0.04–0.06s em listas; `whileHover` lift −2px; `whileTap` 0.96.
- Números importantes com **count-up** (spring).
- `useReducedMotion()` do framer em TODO componente custom (fallback: fade simples).

---

## 4. Navegação "fora da caixa" — a **Bolha da Xarlote** (OrbNav)

Não existe tab bar nem menu hambúrguer. Existe a **própria Xarlote**:

- Um **orb de vidro flutuante** (64px, bottom-center, acima da safe-area) com o mascote
  vivo dentro. Ele é o elemento persistente entre todas as telas (fica no layout, não
  remonta na navegação).
- **Tap** → haptic (`navigator.vibrate(8)`) + um véu de blur sobe e **5 bolhas de vidro
  desabrocham em arco radial** (spring individual, stagger a partir do centro):
  💬 Conversa · ❤️ Saúde · ⏰ Lembretes · ⚡ Atividade · 👤 Perfil.
  A bolha da rota atual aparece acesa (accent + glow).
- **Seleção** → a bolha escolhida cresce/absorve o véu e a rota troca (page transition
  líquida); as outras afundam. **Esc / tap fora / arrastar pra baixo** fecha.
- **Estado vivo:** o orb pulsa em accent quando a Xarlote está digitando; mostra um
  **badge numérico** quando há pedido ativo em cotação (atividade ao vivo).
- **Desktop:** mesmo orb + atalhos `1–5` e setas; bolhas com labels sempre visíveis.
- **Acessibilidade:** `role="navigation"`, botões reais com `aria-label`, foco gerenciado,
  funciona 100% por teclado; reduced-motion → menu aparece com fade simples.

---

## 5. Telas (todas em `apps/web/app/app/`)

### 5.0 Layout do grupo (`layout.tsx` + `template.tsx`)
- `XarloteBackground`: gradiente navy profundo + 3 orbs aurora (reusa keyframes) + vinheta
  + grain — afinado para o clima das referências (mais azul/roxo, menos neutro).
- `PairGuard` (client): sem telefone pareado → redirect `/app/entrar`.
- `ApiAuth` montado (injeta token nas chamadas à API).
- `OrbNav` fixo; `template.tsx` aplica a transição líquida por rota.
- Meta viewport com `viewport-fit=cover` + paddings de safe-area; `theme-color` navy.

### 5.1 `/app/entrar` — Pareamento
- Hero com mascote grande (idle), wordmark **XARLOTE** com glow gradiente.
- Input de telefone (máscara BR, default +55, aceita `+` internacional), botão "Entrar".
- Valida via `GET /app/overview/:phone`: existe → salva e vai pro chat com transição;
  não existe → estado vazio elegante com CTA wa.me da Xarlote **ou** "começar por aqui"
  (deixa entrar mesmo assim; a 1ª mensagem cria o usuário e dispara o consentimento LGPD).
- Texto de transparência: "A Xarlote é uma IA. Seus dados são seus." (regra de produto).

### 5.2 `/app` — **Conversa** (tela principal)
- Header glass: avatar-mascote (pulsa quando online), "Xarlote", subtítulo de presença
  ("agente de saúde · agora" / "digitando…" animado).
- Thread: bolhas de vidro — usuário à direita (tint accent), Xarlote à esquerda (glass);
  separadores de data ("hoje", "ontem", "8 de junho"); render por `content_type`:
  texto (linkify simples), áudio (chip de voz + transcript), imagem (chip 📷 + caption),
  localização (chip 📍 + coords). Entrada com spring + stagger; auto-scroll inteligente
  (só gruda no fim se o usuário já está no fim; senão chip "↓ novas mensagens").
- **Typing indicator:** mascote mini em modo thinking + 3 pontos em onda — aparece após
  envio e some no INSERT `out` (ou timeout 75s).
- Composer glass: textarea auto-grow 1–4 linhas, botão enviar que acende/escala quando há
  texto; Enter envia (Shift+Enter quebra linha); envio **otimista** (bolha a 70% + ✓ ao
  ecoar pelo realtime, dedupe por conteúdo/janela de tempo).
- Pré-preenchimento via `?draft=` (usado pelas outras telas — ex.: escolher farmácia).
- Aviso vermelho fixo discreto: "Emergência? Ligue 192 (SAMU)" — colapsável.

### 5.3 `/app/saude` — **Saúde 360**
- Hero "Sua saúde, 360°" + pills count-up: adesão 30d (`adherence_score_30d`),
  medicamentos ativos, lembretes ativos.
- **Medicamentos** (cards): nome, dosagem/frequência; quando há inventário, **anel de
  progresso animado** com comprimidos restantes + "acaba em ~X dias"
  (`expected_depletion_at`) + barra que esquenta pra âmbar/vermelho quando <20%.
  Footer do card: "a Xarlote acompanha seu estoque e te avisa antes de acabar".
- **Condições** e **Alergias** (alergias com tint danger — segurança em 1 olhada).
- **Tratamentos**: status (ativo/pausado/concluído) com badges e datas.
- **Meus médicos** (prescribers): nome, especialidade, CRM, clínica.
- **Linha da vida** (timeline vertical animada): merge cronológico de compras entregues
  (orders handed_off), sintomas (symptoms_log), consultas (consultations), tomadas de
  remédio relevantes (medication_log: skipped/no_response em âmbar) — cada tipo com ícone
  e cor próprios; filtros por chip (Tabs com layoutId).
- Estados vazios com mascote e CTA "conta pra Xarlote no chat".

### 5.4 `/app/lembretes` — **Lembretes (a IA se programa)**
- Explicador-hero: "A Xarlote se programa sozinha pra cuidar de você" + mascote.
- **Próximo lembrete** em destaque: countdown ao vivo (atualiza por segundo), título,
  recorrência humanizada do `rrule` (FREQ=DAILY → "todo dia", BYHOUR → "às 8h").
- Lista agrupada: **Ativos** (pending/sent/snoozed) e **Histórico** (acknowledged/
  cancelled, colapsado). Card: ícone por tipo (💊 medication, 🩺 appointment, 🏃 exercise,
  💧 hydration, 😴 sleep, ⭐ custom), título, corpo, próxima execução, badge de status,
  e quando ligado a medicamento → estoque inline ("restam 12 comprimidos").
- **Ações com animação**: ✓ Feito (card celebra e desliza pro histórico), ⏰ Adiar 30min
  (relógio gira), ✕ Cancelar (afunda) → `POST /app/reminders/:id/action` com update
  otimista e rollback em erro.
- CTA: "quer um lembrete novo? pede no chat" → `/app?draft=Me lembra de `.

### 5.5 `/app/atividade` — **Atividade (a IA agindo no mundo real)**
- **Pedidos de farmácia**: card por pedido com **stepper líquido** animado:
  `Pedido → Cotando (n farmácias contatadas, m responderam) → Opções prontas → Confirmado
  → Em entrega` (mapeia `drafting/quoting/quoted/confirming/handed_off`); barra de
  progresso com gradiente aurora que "flui"; contadores ao vivo via realtime de `quotes`.
- Por pedido: mini-cards das cotações (farmácia, distância, total grande tabular, frete,
  ETA, Pix) — a melhor oferta com coroa/glow; status de cada farmácia com StatusPing
  (contatada/negociando/respondeu/indisponível).
- **Botão "Escolher esta"** → volta pro chat com draft "Quero a da {farmácia} por R$ {x}"
  (decisão SEMPRE passa pela Xarlote — um cérebro só).
- **Consultas médicas**: cards equivalentes (especialidade, urgência, modalidade, ofertas
  de horário/preço por clínica).
- Histórico de pedidos concluídos/cancelados colapsado no fim.

### 5.6 `/app/perfil` — **Perfil & privacidade**
- Hero: Avatar, nome, telefone, "cliente desde", badge LGPD (data do consentimento).
- **"O que a Xarlote lembra de você"** — memory cards agrupados por kind com os tints do
  dashboard (fact azul, preference roxo, episode rosa, affect âmbar), barra de confiança,
  badge de origem (✋ você contou / ✨ ela percebeu). Texto: "memória influencia as
  respostas; ela sempre avisa quando usa".
- Contato de emergência (exibição; editar → chat).
- **Privacidade**: exportar meus dados (JSON do overview, download client-side),
  apagar tudo (explica o fluxo `esquecer` → confirmação `CONFIRMO APAGAR` no chat, com
  botão que abre o chat com draft) — LGPD de verdade, usando o fluxo que já existe.
- Desparear aparelho (limpa localStorage) + versão do app.

---

## 6. PWA & mobile
- `app/manifest.ts` (Next metadata): nome "Xarlote", `display: standalone`,
  `theme_color #05051c`, ícones SVG (192/512, `purpose any/maskable`) com o mascote.
- Meta iOS: `apple-mobile-web-app-capable`, status bar translúcida; safe-areas via
  `env(safe-area-inset-*)` no layout e no OrbNav.
- Performance: tudo client component leve (sem libs novas além do que já existe);
  animações `transform/opacity` only; realtime com cleanup correto; lista de mensagens
  limitada a 200 com "carregar anteriores".

---

## 7. Passo a passo de implementação (ordem real)

| # | Passo | Arquivos |
|---|---|---|
| 1 | Plano (este arquivo) | `docs/XARLOTE_APP_PLAN.md` |
| 2 | Backend: rota `/app` (overview, inbound, reminder action) + registro | `apps/api/src/routes/app.ts`, `server.ts` |
| 3 | Tokens novos (keyframes float/wave/ripple, cor `xar-deep`) | `tailwind.config.ts`, `globals.css` |
| 4 | Mascote + Background + OrbNav + PairGuard + layout/template do grupo | `components/xarlote/*`, `app/app/layout.tsx`, `template.tsx` |
| 5 | Lib do app: tipos, client API, pairing, hooks (overview + chat realtime) | `lib/xarlote/*` |
| 6 | Tela Conversa (chat completo) | `app/app/page.tsx`, `components/xarlote/chat/*` |
| 7 | Telas Saúde / Lembretes / Atividade / Perfil / Entrar | `app/app/{saude,lembretes,atividade,perfil,entrar}/page.tsx` |
| 8 | PWA (manifest + ícones + metas) | `app/manifest.ts`, `public/*` |
| 9 | Verificação: typecheck + build + E2E local (API `ROLE=api WHATSAPP_MODE=simulator` + web) com telefone de teste; screenshots de todas as telas | — |
| 10 | Docs (§9 do PROJECT_STATE) + commits convencionais | `PROJECT_STATE.md` |

### Verificação E2E local (sem efeitos no mundo real)
```bash
ROLE=api WHATSAPP_MODE=simulator pnpm --filter api dev   # :3001 — sem workers, sem uazapi
NEXT_PUBLIC_API_URL=http://localhost:3001 pnpm --filter web dev  # :3002
# abrir http://localhost:3002/app/entrar e parear +5511999990001 (telefone de teste)
```
- `ROLE=api` evita rodar os 13 crons locais contra o banco de prod (sem duplicar
  reminder/enricher com o worker de prod).
- `WHATSAPP_MODE=simulator` torna os envios uazapi no-ops — a conversa acontece só no DB.
- O banco é o de prod (único), mas restrito ao número de teste do simulador; limpável via
  `POST /api/simulate/reset {phone}` local.

---

## 8. Como publicar (depende de OK do founder — NÃO feito autonomamente)
1. `railway up --service ia-da-saude-api --detach` (sobe a rota `/app`; o worker não muda).
2. Vercel: deploy do `apps/web` (já é o mesmo projeto do dashboard) — o app fica em
   `https://<dominio>/app`. Adicionar o domínio ao `CORS_ORIGINS` do service api.
3. Abrir `/app/entrar` no celular → "Adicionar à tela de início" (PWA standalone).
4. Parear com o telefone real → a conversa do WhatsApp inteira aparece; mandar "oi" pelo
   app → resposta chega no app **e** no WhatsApp.

## 9. Riscos & decisões registradas
- **Token compartilhado no bundle**: já era o modelo do dashboard (F0); o app herda.
  Mitigação futura = Supabase Auth + OTP WhatsApp + RLS por usuário (F1.D2).
- **Realtime depende das policies `anon_read_*`** existentes; se o RLS endurecer (F1.D2),
  trocar leituras diretas por endpoints `/app/*` (já concentramos quase tudo no overview).
- **`/app/inbound` aguarda o turno da LLM** (5–15s): aceitável (UI não bloqueia); se
  incomodar, trocar por `setImmediate` + retorno imediato (mesmo padrão do webhook).
- **rrule do dispatcher** (ver §2, follow-up).
- **Áudio/imagem PELO app**: fora do MVP (WhatsApp cobre); chips de mídia renderizam o
  que chega. Próxima fase: upload + `input_audio`/`image_url` no mesmo pipeline.
