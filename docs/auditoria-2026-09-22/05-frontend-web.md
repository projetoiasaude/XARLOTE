# Frontend web (dashboard, /app PWA, página do médico)

> Relatório integral do especialista (auditoria read-only de 21–22/09/2026, base `b981a3d`). Consolidação e priorização cruzada em [`00-CONSOLIDADO.md`](00-CONSOLIDADO.md).

---

# Auditoria frontend `apps/web` — Xarlote (read-only, 21/09/2026)

Base: branch `fix/auditoria-set` @ `b981a3d`. `pnpm --filter @iasaude/web typecheck` limpo. Lint **não** rodado (não existe config ESLint no repo — ver #22). Nenhum arquivo do repo foi alterado.

## 1. Visão geral

**Sólido:** a página do médico `/s/[token]` é a melhor superfície do produto — token no corpo do POST (nunca na URL do servidor Next), `noindex/noarchive`, tema claro com folha de impressão, estados de erro que distinguem "link acabou" de "falhei agora", alvos de 44 px, `aria-label` no gráfico, comparação com a faixa do próprio laudo e `lib/medico/*` puro e coberto por `tests/share-medico.test.ts`. O login do dashboard é correto (cookie HMAC httpOnly, token de admin só em memória pós-login). `lib/br-data.ts` documenta e evita o off-by-one de coluna `DATE`. O chat do paciente tem otimismo + retry sem duplicar mensagem persistida, recarrega ao voltar do background e trata perda de websocket.

**Preocupa:** (1) o web `/app` continua no ar em `xarlote.com.br/app` com o modelo de auth "digite um telefone" — o próprio backend chama isso de "o buraco que permitia ler o prontuário de qualquer telefone" e a anon key do bundle lê **todas** as mensagens; o app nativo com OTP já existe, então a exposição hoje é gratuita. (2) O dashboard **mente com volume**: a lista de conversas mostra só as 20 mais recentes sem aviso, e a tela de uma conversa mostra as 200 mensagens **mais antigas** — conversas longas parecem paradas. (3) O "Salvar" do `/prompts` reenvia a config inteira e pode religar kill-switches desligados em outra aba; a chave OpenRouter/ElevenLabs viaja em claro pro navegador a cada 30 s em toda página. (4) O off-by-one de `DATE` que `br-data.ts` documenta foi corrigido na página do médico, mas persiste no dashboard (data de nascimento, início de tratamento). (5) Endurecimentos do backend (`BYHOUR=8,20`, `UNTIL`, `COUNT`; `handed_off` ≠ entregue) não foram espelhados no web do paciente, que mostra "Compra entregue" e "a caminho" para sempre.

## 2. Achados

### P0

**#1 · Web `/app` em produção com auth por telefone: qualquer pessoa lê o prontuário de qualquer paciente e fala com a Xarlote em nome dele** · SEGURANÇA
- `apps/web/lib/xarlote/pairing.ts:1-2` — `// Pareamento do aparelho — MVP: telefone em localStorage`
- `apps/web/components/layout/ApiAuth.tsx:7-8` — `const TOKEN = process.env['NEXT_PUBLIC_APP_API_TOKEN'] ?? process.env['NEXT_PUBLIC_ADMIN_API_TOKEN'] ?? ''` (token público no bundle; fallback pro token de ADMIN se o de app faltar no build)
- `apps/web/app/app/entrar/page.tsx:40-47` e `:56-60` — `fetchOverview(phone)` devolve o prontuário; `startFresh()` pareia um número desconhecido sem nenhuma prova de posse
- `apps/api/src/routes/app.ts:110-115` e `:122-172` — `/app/overview` e `/app/inbound` identificam pelo `phone` do body; `/inbound` chama `processInboundUser` como se fosse uma mensagem real do WhatsApp daquele número (a resposta sai pelo WhatsApp do titular)
- `apps/api/src/middleware/patient-auth.ts:4-6` — "o buraco que permitia ler o prontuário de qualquer telefone"; `apps/api/src/routes/app/index.ts:4-7` — legado vive "até o web migrar"
- `apps/web/lib/xarlote/use-chat.ts:56-67, 74-80` + `apps/web/lib/supabase.ts:4-7` — anon key lê `conversations`/`messages` direto; `PROJECT_STATE.md:217` — "qualquer um c/ a anon key do bundle lê TODAS as conversas"
- **Cenário:** alguém abre `xarlote.com.br/app`, extrai o `NEXT_PUBLIC_APP_API_TOKEN` do JS, e (a) baixa alergias/medicamentos/memória de qualquer número; (b) manda "cancela todos os meus lembretes" ou "quero apagar meus dados" como se fosse o paciente — a tool executa e o paciente recebe a resposta no WhatsApp dele; (c) com a anon key, lê o histórico inteiro de todos.
- **Correção:** o app nativo (OTP + JWT, `routes/app/auth.ts`) já cobre o caminho. Fazer o **cutover F5 agora**: `/app` no web vira página "baixe o app" (ou a mesma tela de OTP do mobile chamando `/app/auth/*`), remover `ApiAuth.tsx` e o fallback pro token de admin, mover `use-chat`/`atividade` pra rotas autenticadas, aplicar a 0027/0037 (`drop policy anon_read_*`) e tirar `NEXT_PUBLIC_SUPABASE_ANON_KEY` do bundle (plano 3-07/1A-17). Enquanto isso, mínimo: bloquear `/app` no `middleware.ts` (redirect pra loja) — 10 linhas.
- Esforço: 1–2 dias (cutover) / 30 min (bloqueio). Confiança: alta (é documentado como "decisão do founder", mas o mitigante já existe).

### P1

**#2 · Tela de conversa do dashboard mostra as 200 mensagens MAIS ANTIGAS — conversa longa parece parada** · BUG
- `apps/api/src/routes/admin.ts:182-187` — `.order('created_at', { ascending: true }).limit(200)`
- `apps/web/app/(dash)/conversations/[id]/page.tsx:45-53` — carrega tudo de uma vez a cada 5 s, sem cursor/"carregar mais"; `:74-86` rola pro fim do que veio
- **Cenário:** paciente com 300 mensagens (há 3.512 mensagens pra 26 usuários) — o fundador abre, vê as 200 primeiras e nunca a de hoje; o polling de 5 s nunca traz nada novo. Conclui que o paciente sumiu.
- **Correção:** API ordenar `desc` + `limit` + cursor keyset (já existe `lib/messages-cursor.ts`); na página, `reverse()` + botão "mensagens anteriores" no topo (padrão do `audit/page.tsx`).
- Esforço: 2 h. Confiança: alta.

**#3 · Lista de conversas = só as 20 mais recentes, sem paginação nem aviso ("20 ativas")** · RISCO SOB CARGA (já vale hoje)
- `apps/api/src/routes/admin.ts:158-166` — `limit = q['limit'] ?? '20'`, `page` default 0
- `apps/web/app/(dash)/conversations/page.tsx:23` — `adminGet('/admin/conversations')` sem `page/limit`; `:50-52` badge `{convs.length} ativas`
- Mesmo padrão sem aviso de truncagem: `users/page.tsx:36` (`limit=200`), `orders` (`admin.ts:196` → 50), `suppliers` (`admin.ts:284` → 100).
- **Correção:** paginação keyset por `last_message_at` + "carregar mais", e badge com `count` real (`select('*', { count: 'exact', head: true })`). Com 10k conversas, a lista nunca ficará lenta — ficará errada.
- Esforço: 3 h. Confiança: alta.

**#4 · "Salvar" no `/prompts` reenvia a config inteira e religa kill-switches desligados em outra aba** · BUG
- `apps/web/app/(dash)/prompts/page.tsx:278-292` — `payload = { ...config, ... }` (inclui `xarlote_enabled`, `reminders_enabled`, `pharmacy_outbound_enabled`… como estavam no mount)
- `apps/api/src/routes/admin.ts:321-343` — PUT faz merge só do que vier, então o problema é o front mandar tudo
- `apps/web/lib/hooks/use-xarlote-status.ts:21-25` — o sidebar sabe que "mudanças feitas via outra aba" existem; a página `/prompts` não recarrega `config`
- **Cenário:** aba A (ou o celular) desliga "Disparo a farmácias" às 14h; aba B, aberta desde a manhã, ajusta o sufixo do prompt e salva às 15h → farmácia religada em silêncio. Vale também pro interruptor mestre.
- **Correção:** `handleSave` enviar só um diff (`Object.fromEntries(keys.filter(k => config[k] !== original[k]))`) e nunca os booleanos (que já salvam sozinhos); opcional: `If-Match`/`updated_at` no PUT.
- Esforço: 1 h. Confiança: alta.

**#5 · Chaves OpenRouter e ElevenLabs em claro pro navegador, a cada 30 s, em TODA página do dashboard** · SEGURANÇA
- `apps/api/src/routes/admin.ts:292-294` — `GET /prompts` → `reply.send(loadPrompts())` (config inteira, chaves incluídas)
- `apps/web/lib/hooks/use-xarlote-status.ts:33,49` — `fetch(apiUrl('/admin/prompts'))` + `setInterval(load, 30_000)`, usado pelo `Sidebar.tsx:38` (todas as rotas) e `page.tsx:72`
- `apps/web/app/(dash)/prompts/page.tsx:466-472` — a chave é exibida num input (olho mostrar/ocultar)
- **Cenário:** qualquer extensão de navegador, XSS ou pessoa olhando a aba Network do fundador vê a chave; ela também fica em cache de devtools. Plano 1A-17 já prevê mascarar.
- **Correção:** endpoint leve `GET /admin/status` (só `xarlote_enabled` + modelos) pro sidebar; `GET /prompts` devolver `llm_api_key: '••••1234'` e o PUT ignorar valores mascarados.
- Esforço: 2 h. Confiança: alta.

**#6 · Web do paciente anuncia "Compra na farmácia entregue" / "a caminho" para `handed_off`, que significa "repassado à farmácia" — e para sempre** · BUG (dado errado pro paciente)
- `apps/web/app/app/saude/page.tsx:43-48` — `['handed_off','completed'].includes(ord.status)` → `title: 'Compra na farmácia entregue'`
- `apps/web/app/app/atividade/page.tsx:25` (`handed_off` é "ativo"), `:65` `delivering = handed_off || completed`, `:84-86` badge "a caminho"
- `docs/PLAN.md:1204-1207` — `handed_off` = fechamento (Pix repassado) + follow-up "chegou tudo?"; `docs/PLAN.md:309` — o enum **não tem** `completed`
- **Cenário:** o caso da Ludmila (0/10 farmácias responderam) — se um pedido chegar a `handed_off`, o paciente vê "entregue" na Saúde 360 e "a caminho" na Atividade indefinidamente; "Nada em andamento" nunca mais aparece. É o padrão "sistema anunciando o que não fez" (regra 106/117).
- **Correção:** `handed_off` → "Pedido enviado à farmácia — confirmação pendente"; tratar como ativo só dentro da janela de pós-venda (72 h, `rota-farmacia.ts:56`); remover ramos `completed`.
- Esforço: 1 h. Confiança: alta.

### P2

**#7 · `humanizeRrule` do web ignora a 2ª hora (`BYHOUR=8,20`), `UNTIL` e `COUNT`** · BUG
- `apps/web/lib/xarlote/format.ts:100-111` — `parseInt(hour.split(',')[0]!, 10)`; nenhuma leitura de `UNTIL`/`COUNT`
- **Cenário:** antibiótico 8h/20h por 10 dias (o caso de 08/09) aparece como "todo dia às 08:00", sem fim. O `countdown(next_run_at)` ao lado está certo, o texto ao lado está errado. Regra 101: "endurecimento aplicado num prompt e esquecido no outro".
- **Correção:** listar todas as horas (`BYHOUR.split(',')`) e anexar "até dd/mm" / "N vezes"; ou pedir ao `/app/overview` um `schedule_text` calculado pelo servidor (`packages/shared/src/rrule.ts` já resolve tudo).
- Esforço: 1 h. Confiança: alta.

**#8 · Off-by-one em colunas `DATE` no dashboard (nascimento e início de tratamento mostram o dia anterior)** · BUG
- `apps/web/app/(dash)/users/[id]/page.tsx:198` — `new Date(user.birth_date).toLocaleDateString('pt-BR')`; `infra/supabase/schema.sql:61` `birth_date date`
- `apps/web/app/(dash)/treatments/page.tsx:108` — `new Date(t.started_at).toLocaleDateString('pt-BR')`; `infra/supabase/migrations/0003_xarlote_v2_schema.sql:80` `started_at DATE`
- `apps/web/lib/br-data.ts:13-19` — o bug documentado ("um exame de 2026-08-01 aparecia como 31/07/2026")
- **Correção:** usar `dataBr()` de `lib/br-data.ts` nas duas linhas.
- Esforço: 10 min. Confiança: alta.

**#9 · `/logs`: "auto" rola pro log MAIS ANTIGO a cada 2 s** · BUG/UX
- `apps/web/app/(dash)/logs/page.tsx:77` — novos entram no topo (`[...newLogs, ...prev]`); `:85-87` — `bottomRef.scrollIntoView` (fim = mais antigo) sempre que `logs` muda, `autoScroll` ligado por padrão
- **Correção:** ou `bottomRef` no topo da lista, ou `flex-col-reverse`. Também: `:60-66` faz `setLogs(data)` sem checar `Array.isArray` — um 500/401 no primeiro load derruba a página (`logs.filter is not a function`).
- Esforço: 30 min. Confiança: alta.

**#10 · Simulador e "responder como farmácia" são apresentados em produção, mas `/api/simulate/*` responde 404 lá** · UX
- `apps/api/src/routes/simulate.ts:31-37` — `NODE_ENV=production` → 404
- `apps/web/app/(dash)/page.tsx:12-19` (1º card "Simulador") e `:153-159` ("Como começar: abra o Simulador…"); `Sidebar.tsx:22`
- `apps/web/components/simulator/WhatsAppSim.tsx:277-298` — falha vira `console.error`, input já limpo, nada na tela
- `apps/web/components/chat/PharmacyChatDrawer.tsx:62-71` — `alert('Falha ao enviar mensagem. Veja o console.')` em pedidos REAIS
- **Correção:** esconder card/rota/botão quando `/health` (ou uma flag `NEXT_PUBLIC_SIMULATOR=0`) disser que o simulador não existe; no drawer, trocar o composer por "somente leitura em produção".
- Esforço: 1 h. Confiança: alta.

**#11 · Interruptor mestre desliga a Xarlote com um clique, sem confirmação e sem nome acessível** · UX/ACESSIBILIDADE
- `apps/web/app/(dash)/prompts/page.tsx:229-250` — otimista, sem `confirm`; `:376-381` — `role="switch"` sem `aria-label` (os de fluxo têm, `:431`)
- **Cenário:** clique acidental → "Mensagens do WhatsApp são descartadas" para todos os pacientes até alguém notar.
- **Correção:** confirmação só no sentido ON→OFF (um `Drawer`/dialog dos primitivos com o texto do impacto) + `aria-label="Ligar ou desligar a Xarlote"`.
- Esforço: 40 min. Confiança: alta.

**#12 · No chat do paciente, o botão de emergência "192" tem ~24 px de altura; em Lembretes, "cancelar" fica a 28 px de "feito" e cancela na hora, sem desfazer** · UX/ACESSIBILIDADE
- `apps/web/app/app/page.tsx:106-112` — `px-2.5 py-1 text-[11px]`
- `apps/web/app/app/lembretes/page.tsx:214-222` — três `GlassButton size="xs"` (h-7) lado a lado; `:68-100` `act(r,'cancel')` otimista e definitivo; `:265-267` histórico rotula qualquer status não-`acknowledged` como "cancelado"
- **Correção:** 192 com `min-h-[44px]`; "cancelar" atrás de confirmação (ou swipe) e um toast "desfazer" 5 s (a API já tem `action`).
- Esforço: 1 h. Confiança: alta.

**#13 · Nenhum header de segurança em nenhuma rota (dashboard e página clínica podem ser embutidos em iframe)** · SEGURANÇA
- `apps/web/next.config.mjs` — só `rewrites()`, sem `headers()`; `apps/web/vercel.json` — só `framework`
- **Correção:** `headers()` com `X-Frame-Options: DENY` / `Content-Security-Policy: frame-ancestors 'none'`, `Referrer-Policy: strict-origin-when-cross-origin` (em `/s/:path*` usar `no-referrer` — o token está na URL), `X-Content-Type-Options: nosniff`, `Permissions-Policy`.
- Esforço: 30 min. Confiança: alta.

**#14 · Polling de 5 s em todas as listas do dashboard: sem pausa em aba oculta, sem guarda de requisição em voo, sem estado de erro** · OTIMIZAÇÃO/UX
- `conversations/page.tsx:34-38`, `orders/page.tsx:46-50`, `orders/[id]/page.tsx:77-82`, `conversations/[id]/page.tsx:55-63`, `PharmacyChatDrawer.tsx:49-51` (4 s), `logs/page.tsx:69-82` (2 s), `audit/page.tsx:121-125` (3 s), `use-xarlote-status.ts:49` (30 s, em toda página) — todos `setInterval` cru
- `conversations/page.tsx:25-29` + `:56-63` e `orders/page.tsx:37-41` + `:62-69` — erro engolido → primeiro load falhando mostra "Nenhuma conversa ainda"
- **Cenário:** 3 abas abertas o dia todo = ~2 req/s contra a API de produção; cada resposta cria um array novo e re-renderiza a lista inteira (cada `GlassCard` é `motion.div`).
- **Correção:** um hook `usePoll(fn, ms)` que respeita `document.visibilityState`, usa `AbortController`, ignora resposta fora de ordem e expõe `error` — e um `EmptyState` distinto para erro. (SWR faria isso por padrão.)
- Esforço: 3 h. Confiança: alta.

**#15 · Custo de animação no `/app` em celular fraco: 9 blobs desfocados em loop + `box-shadow` animado + 3 orbs de 70vmax com `blur(60-70px)`** · OTIMIZAÇÃO
- `apps/web/components/xarlote/LiquidCore.tsx:69-80` — 3 `motion.div` com `blur-[6px]` em `repeat: Infinity` por instância; o chat monta 3 instâncias (`page.tsx:85`, `OrbNav.tsx:175`, `TypingIndicator.tsx:15`)
- `apps/web/components/xarlote/OrbNav.tsx:167` — `animate-breathe` anima `box-shadow` (`tailwind.config.ts:116-119`) = repaint por frame
- `apps/web/components/xarlote/XarloteBackground.tsx:13-38` — 3 orbs `h-[70vmax]` com `filter: blur()` animados por transform (o blur é recalculado a cada frame)
- `apps/web/components/xarlote/chat/MessageBubble.tsx:63-67` — 200 mensagens (`use-chat.ts:10`) cada uma com spring de entrada no primeiro render
- `apps/web/app/globals.css:136-149` — reduced-motion cobre só keyframes CSS; `apps/web/app/(dash)/template.tsx:10-19` ignora `useReducedMotion` (o `app/template.tsx` respeita)
- **Correção:** `MessageBubble initial={false}` para histórico (animar só `pending`/novas); `breathe` via `opacity` de um pseudo-elemento; pausar blobs quando `document.hidden`; `will-change: transform` nos orbs e `filter` só no gradiente (não no elemento animado); um `LiquidCore` compartilhado via `layoutId`.
- Esforço: 3 h. Confiança: média-alta.

**#16 · `/app` carrega ~720 KB de JS (build local de 03/07) — supabase-js inteiro no chat e no dashboard** · OTIMIZAÇÃO
- `.next/app-build-manifest.json` — `/app/page`: 11 chunks, 719 KB; chunks `7016`/`5836ce91` (supabase, ~226 KB), `6154` (framer-motion, ~117 KB), `0a8b1846` (~173 KB)
- `apps/web/app/s/[token]/page.tsx:56` — `import { apiUrl } from '@/lib/utils'`, e `lib/utils.ts:3-4` importa `date-fns` + `ptBR`; `br-data.ts:10-11` diz que a rota não deveria arrastar `date-fns` (verificar no build se o tree-shaking remove)
- **Correção:** mover `apiUrl` para `lib/api-url.ts`; após o cutover (#1), supabase-js some do web inteiro; `next/dynamic` para `WhatsAppSim` e `XarloteVideoAlpha`.
- Esforço: 1 h. Confiança: média (build antigo).

**#17 · 500 itens `.glass` (backdrop-filter 40px) na auditoria + `AnimatePresence` em toda a lista** · RISCO SOB CARGA
- `apps/web/app/(dash)/audit/page.tsx:13` (`LIVE_CAP = 500`), `:217-236` — cada item `glass glass-spec` dentro de `AnimatePresence`
- **Correção:** `variant="lo"` sem `backdrop-filter` para linhas (só o painel externo é vidro), virtualização (`@tanstack/react-virtual`) ou `content-visibility: auto`.
- Esforço: 2 h. Confiança: média.

### P3

**#18 · Open redirect no login (`?next=//evil.com`)** · SEGURANÇA — `apps/web/app/login/page.tsx:26` — `next.startsWith('/')` aceita `//host`. Corrigir com `next.startsWith('/') && !next.startsWith('//')`. 5 min.

**#19 · Acessibilidade: contraste, foco e leitor de tela** · ACESSIBILIDADE
- Texto em `text-white/30`–`/40` sobre `#04041a`/`#0a0a0f` (≈2,5–3,6:1, abaixo de 4,5:1): `MessageBubble.tsx:81`, `saude/page.tsx:344`, `conversations/page.tsx:87,91`
- `drawer.tsx:33-40, 56-70` — sem `role="dialog"`, `aria-modal`, focus-trap ou retorno de foco; `tabs.tsx:27-41` — `role="tablist"` sem setas/`aria-controls`
- `MessageBubble.tsx:69-70` — retry é `div onClick` (sem teclado); `app/app/page.tsx:117` — thread sem `aria-live`; `Composer.tsx:51-56` — textarea só com placeholder
- `login/page.tsx:47-48`, `prompts/page.tsx:462-472, 490-492` — `<label>` sem `htmlFor`
- `manifest.ts:14` — `orientation: 'portrait'` (WCAG 1.3.4)

**#20 · Manifest PWA vinculado em TODAS as rotas, inclusive na página do médico** · UX — `apps/web/app/manifest.ts:10-13` (`start_url: /app`) é servido pelo root; evidência do `<link rel="manifest">` em `.next/server/app/suppliers.html`. Chrome Android pode oferecer "instalar Xarlote" ao médico. Corrigir com `<link rel="manifest">` só em `app/app/layout.tsx` (`metadata.manifest`).

**#21 · Nomes e textos desatualizados na UI** · QUALIDADE — `app/layout.tsx:4-7` título "IA da Saúde — Dashboard" (vale para `/login`); `Sidebar.tsx:64` "IA da Saúde"; `WhatsAppSim.tsx:537` "Xarlote — IA da Saúde"; `(dash)/page.tsx:16` "Teste a Xarlote sem uazapi" e `conversations/page.tsx:61` "mande mensagem pela uazapi" (prod é zpro); `users/[id]/page.tsx:83` "Fatos durables"; `users/[id]/page.tsx:139` erro técnico "Erro ao carregar perfil: Error: HTTP 404".

**#22 · Higiene do pacote web** · QUALIDADE
- Não há `.eslintrc` em `apps/web` nem na raiz → `next lint` (`package.json:10`) é interativo e os 6 `eslint-disable-next-line react-hooks/exhaustive-deps` não desabilitam nada
- `@capacitor/*` (`package.json:13-17`) + `CapacitorBridge.tsx:33-36` (`await import('@capacitor/core')` roda em todo load do `/app`): a casca `native/` foi superada pelo Expo em `apps/mobile` — confirmar e remover
- `apps/web/dump.rdb` (890 B, 11/jun) e `tsconfig.tsbuildinfo`: **não** versionados (`.gitignore:18-19`), só lixo local; `.next/` local é de 03/07
- Duplicação web ↔ mobile: `pairing.ts:48` e `apps/mobile/src/lib/phone-input.ts:44` (`formatPhonePretty`), `lib/xarlote/format.ts` × `apps/mobile/src/lib/br-format.ts`, `components/ui/glass-*` × `apps/mobile/src/components/ui/glass-*`, `OrbNav.tsx` nos dois — candidatos a `packages/ui-core` (puro, sem DOM/RN) quando o web deixar de ser "autossuficiente"

**#23 · `WhatsAppSim.tsx` (947 linhas)** · QUALIDADE — `:427` `h-screen` dentro do `main` com `py-6` (barra dupla); `:264-274` `pollTimerRef` nunca limpo no unmount; `:157-181` re-assina N canais realtime a cada poll de 3 s (`:246`); `:317-324` foto sem limite de tamanho (413 silencioso); `:342,366` `alert()`. Extrair: `usePharmacyQuotes` (poll+realtime), `PhoneSelector`, `UserChatPane`, `PharmacyPane`, e trocar `wa-*`/`brand-*` (27 usos, únicos no repo fora de `glass-card.tsx:32`) pelos primitivos.

**#24 · Contadores das abas calculados sobre a lista já filtrada** · UX — `treatments/page.tsx:47-51, 61-69` e `consultations/page.tsx:62-67`: na aba "Ativos" o contador de "Pausados" é 0 sempre. Trocar por contagem do servidor ou uma requisição `status=all` só para os totais. Também sem `AbortController` ao trocar de aba (`treatments/page.tsx:37-45`).

**#25 · Lembretes: poll de 30 s sobrescreve o estado otimista durante a ação; `atividade` rotula desconhecido como "falhou"** · QUALIDADE — `lembretes/page.tsx:49-51` (`setLocal(overview.reminders)` a cada overview) vs `:72-92`; `atividade/page.tsx:317`.

## 3. Tabela por página

| Rota | Fonte de dados | Polling | Paginação | L / E / Err | Risco principal |
|---|---|---|---|---|---|
| `/` (dash) | `/admin/prompts` (hook) | 30 s | — | – / – / silencioso | expõe chaves (#5); anuncia simulador morto em prod (#10) |
| `/conversations` | `/admin/conversations` | 5 s | **não** (20 fixas) | – / ✓ / engolido→empty falso | #3 |
| `/conversations/[id]` | `/admin/conversations/:id` | 5 s | **não** (200 mais antigas) | – / – / engolido | #2 |
| `/users` | `/admin/users?limit=200` | não | não | hint / ✓ / engolido | corte em 200 sem aviso |
| `/users/[id]` | `/admin/users/:id` | não | — | skeleton / – / ✓ (técnico) | nascimento off-by-one (#8) |
| `/orders` | `/admin/orders` (50) | 5 s | não | hint / ✓ / engolido | corte em 50 |
| `/orders/[id]` | `/admin/orders/:id` + drawer | 5 s + 4 s | — | texto / – / engolido | composer de farmácia morto em prod (#10) |
| `/prompts` | `/admin/prompts`, `/base`, `/tts/*` | não | — | – / – / ✓ | save sobrescreve switches (#4), chaves em claro (#5), sem confirmação (#11) |
| `/simulator` | `/api/simulate/*` + Supabase realtime | 3 s (60 s) + 2–2,5 s | — | – / ✓ / silencioso | 404 em prod (#10), leaks (#23) |
| `/logs` | `/admin/logs` | 2 s | buffer 500 | – / ✓ / crash se não-array | auto-scroll invertido (#9) |
| `/metrics` | `/admin/metrics?days=14` | não | — | skeleton / ✓ / →vazio | "hoje" = último dia agregado |
| `/audit` | `/admin/timeline` (keyset) | 3 s (pausável) | ✓ cursor | skeleton / ✓ / silencioso | 500 vidros (#17) |
| `/suppliers`, `/clinics`, `/treatments`, `/consultations` | `/admin/*` (100–200) | não | não | skeleton (3) / ✓ / →vazio | contadores errados (#24), corte sem aviso |
| `/app` (chat) | Supabase anon (`messages`) + realtime + `/app/inbound` | 30 s overview + visibilitychange | 200 últimas, sem "anteriores" | skeleton / ✓ / bolha failed+retry | **#1**; sem mídia; 192 pequeno (#12) |
| `/app/entrar` | `/app/overview` | — | — | – / – / ✓ | pareia qualquer número (#1) |
| `/app/saude` | overview (contexto) | 30 s | — | skeleton / ✓ / ✓ | "entregue" falso (#6) |
| `/app/lembretes` | overview + `/app/reminders/:id/action` | 30 s | não (todos) | skeleton / ✓ / rollback mudo | rrule incompleto (#7), cancelar sem confirmação (#12) |
| `/app/atividade` | overview + realtime `quotes` (anon) | 30 s | — | skeleton / ✓ / – | "a caminho" eterno (#6) |
| `/app/perfil` | overview | 30 s | — | skeleton / ✓ / – | exporta o JSON em memória (ok) |
| `/s/[token]` | `POST /share/resolve` (token no body) | não | — | ✓ / ✓ obrigatório / ✓ (temporário ≠ definitivo) | headers (#13), manifest (#20) |
| `/login` | `/api/auth/login` | — | — | ✓ / – / ✓ | open redirect (#18) |

## 4. O que verifiquei e está OK

- **Auth do dashboard:** `middleware.ts:31-49` só checa presença do cookie (design declarado), `lib/auth-cookie.ts:20-46` valida HMAC + expiração com `timingSafeEqual`, `api/auth/token/route.ts:11-22` entrega o token só com sessão válida e `Cache-Control: no-store`; `NEXT_PUBLIC_ADMIN_API_TOKEN` não é lido por nenhuma página do dash (só pelo `ApiAuth` do `/app`, como fallback). Matcher exclui `s/` com barra de propósito (`middleware.ts:55-58`) e cobre `/privacidade`/`/suporte`.
- **`/s/[token]`:** client component com token no corpo (`page.tsx:104-110`), `robots` no `layout.tsx:34-38`, `color-scheme: light` + `@media print` com `.nao-imprime`, `break-inside: avoid` e `a[href]:after{content:''}` (`layout.tsx:58-74`); `FALHA_TEMPORARIA` separa 429/503/rede de link revogado (`page.tsx:86, 294-338`); PIN com `inputMode`, `autoComplete="off"`, `sr-only label`, contagem de tentativas; alvos ≥ 44 px (`:247-249, 596-600`); `Grafico.tsx` com `role="img"` + `aria-label`, cor nunca como único sinal, ids de gradiente únicos; `numeros.ts` devolve `null` na dúvida (censurado, composto, ambíguo) e é testado em `tests/share-medico.test.ts`; `dataBr()` evita o off-by-one de `DATE`.
- **Chat `/app`:** dedupe por `id` no realtime (`use-chat.ts:118`), eco só casa com mensagem recente (`:82-96`), `failed` sobrevive a reload, retry recarrega antes de reenviar (evita duplicata no WhatsApp real), typing com timeout de 75 s, recarga em `visibilitychange`, auto-scroll só se já estava no fim + chip "novas mensagens"; `?draft=` consumido uma vez; textarea 16 px (sem zoom iOS); `overscroll-behavior: none` + `h-svh overflow-hidden`; `viewport` sem `maximumScale`.
- **Overview do app:** `inflight` ref evita requisições concorrentes (`app-context.tsx:44, 51-53`); refetch em `focus` + `visibilitychange`; `unknownUser` ≠ erro (`saude/page.tsx:100-110`).
- **Datas no app do paciente:** `format.ts:14-18` parseia `DATE` como local; `BYHOUR` convertido de Brasília para o fuso do aparelho (`:102-110`).
- **Segurança de conteúdo:** único `dangerouslySetInnerHTML` é CSS constante (`s/[token]/layout.tsx:80`); links externos com `rel="noreferrer"` (`entrar/page.tsx:136`, `prompts/page.tsx:476,517`); nenhum `parseInt` sem radix; `window`/`localStorage` sempre atrás de `typeof window` ou dentro de handlers/efeitos; keys por índice só em listas estáticas.
- **`prefers-reduced-transparency`** cai para opaco (`globals.css:126-134`); `useReducedMotion` em `LiquidCore`, `MessageBubble`, `OrbNav`, `XarloteLogo`, `bits.tsx`, `app/template.tsx`.
- **OrbNav:** `aria-expanded`, `aria-label` nas bolhas, Esc fecha, dígitos 1-5 só fora de inputs, véu é `<button>`, some em `/app/entrar`.
- **`XarloteVideoAlpha`:** trata `webglcontextlost`, pausa em aba oculta, guard de rede lenta, limpa textura/buffer/programa no unmount.
- **Higiene git:** `dump.rdb`, `tsconfig.tsbuildinfo`, `.env.local`, `.vercel` não versionados.

## 5. Perguntas em aberto

1. O `/app` web em `xarlote.com.br/app` ainda tem paciente real usando, ou todos migraram pro APK? Se ninguém usa, o bloqueio de #1 pode ser imediato (redirect pra loja) sem esperar o cutover completo.
2. No Vercel, `NEXT_PUBLIC_APP_API_TOKEN` está setado e `NEXT_PUBLIC_ADMIN_API_TOKEN` ausente (plano F-03)? Se o de app faltar num redeploy, `ApiAuth.tsx:7-8` cai em string vazia (app quebra) — ou, num deploy com a env errada, embute o token de **admin** no bundle público.
3. A casca `native/` (Capacitor) está aposentada de vez? Determina se #22 (5 deps + `CapacitorBridge`) pode ser removido.
4. A tela `/simulator` deve existir em produção (como "somente leitura" das cotações) ou só em local/staging? Decide a forma de #10.
5. Há intenção de o dashboard ser usado no celular? Hoje `(dash)/layout.tsx:8-15` é sidebar fixa de 240 px + `h-screen overflow-hidden`, sem breakpoint.
6. Os `anon_read_*` continuam ativos hoje em produção (`pg_policies where roles @> '{anon}'`)? A migration 0027 nunca foi escrita (não existe em `infra/supabase/migrations/`), então a resposta define se #1 inclui leitura de **todas** as conversas ou "só" o prontuário por telefone.
