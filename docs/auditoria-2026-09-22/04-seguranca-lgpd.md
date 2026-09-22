# Segurança de aplicação e LGPD

> Relatório integral do especialista (auditoria read-only de 21–22/09/2026, base `b981a3d`). Consolidação e priorização cruzada em [`00-CONSOLIDADO.md`](00-CONSOLIDADO.md).

---

# Auditoria AppSec/LGPD — Xarlote (rodada: auth, IDOR, segredos, cripto, entrada, web, deps)

## 1. Visão geral

A camada nova do app (`/app/*` com OTP + JWT + refresh rotativo) está bem desenhada: identidade vem do JWT, todo recurso é filtrado por `user_id` ou por vínculo de cuidado verificado a cada request, comparações de segredo são constant-time, OTP/refresh/share são guardados só como hash e o cofre do laboratório é AES-256-GCM correto. Não encontrei **nenhum IDOR** nas 14 rotas novas nem nas rotas de cuidador.

Os problemas novos concentram-se em (a) **força bruta e abuso sem teto**: o login do dashboard não tem rate limit nem lockout; o resgate de código de cuidado varre *todos* os convites abertos do sistema e gasta tentativa em cada um (qualquer conta esgota os convites de todo mundo em 6 chutes); o OTP permite lockout dirigido e serve de bomba de template pago; `POST /app/messages` não tem rate limit; (b) **segredos fora do lugar**: a senha do portal do laboratório persiste em claro em `messages` (e na foto, em bucket público) apesar da promessa "não guardo a senha"; `GET /admin/prompts` devolve as API keys em claro ao navegador; `ZPRO_WEBHOOK_SECRET` é logado a cada webhook; três chaves OpenRouter vivem no histórico git de um repo que já foi público; (c) **dependências**: `next@14.2.35` com 2 advisories críticos e `fastify@4.29.1`/`axios`/`playwright` com altos.

Sem P0 novo (os P0 já registrados — `anon_read_*`, buckets públicos, rota legada por telefone, webhook sem segredo, SSRF em `fetchInboundMedia` — seguem sendo os mais graves).

## 2. Achados (20 novos)

### P1

**1. Login do dashboard sem rate limit, lockout ou 2FA** · P1 · Autenticação · `apps/web/app/api/auth/login/route.ts:8-32`, `apps/web/lib/auth-cookie.ts:39-46`
```ts
export async function POST(req: Request) {
  ...
  if (!passwordMatches(password)) {
    return NextResponse.json({ error: 'invalid_credentials' }, { status: 401 });
  }
  res.cookies.set(SESSION_COOKIE, signSession(), { httpOnly: true, secure: true, sameSite: 'lax', ... maxAge: 7*24*60*60 });
```
Cenário: uma senha única (`DASHBOARD_PASSWORD`) protege `/api/auth/token`, que entrega o `ADMIN_API_TOKEN` — ou seja, todo prontuário, chaves de LLM, envio de WhatsApp e `/admin/reset-dev`. O endpoint aceita tentativas ilimitadas na velocidade da Vercel (serverless, sem estado); a única defesa é a entropia da senha (desconhecida). Correção: rate limit por IP + global (Upstash/KV ou Vercel WAF), backoff exponencial após N falhas, alerta no Telegram em rajada de 401, e exigir senha ≥ 20 caracteres aleatórios; idealmente segundo fator (TOTP). Esforço: P–M. Confiança: alta (controle ausente é fato; exploração depende da senha).

**2. Resgate de código de cuidado varre TODOS os convites abertos e gasta tentativa em cada um** · P1 · Autorização/DoS · `apps/api/src/lib/care-links.ts:153-184`, `apps/api/src/lib/care-invite.ts:76-78`
```ts
const { data: abertos } = await db.from('care_invites')
  .select(...).is('consumed_at', null).gt('expires_at', ...).limit(500);
for (const row of abertos ?? []) {
  // 1. CAS no contador — só avalia quem conseguiu incrementar.
  const { data: pegou } = await db.from('care_invites')
    .update({ attempts: (row.attempts as number) + 1 }).eq('id', row.id).eq('attempts', row.attempts)...
  const verdict = evaluateCareInvite({...}, { code, ... });
  if (verdict !== 'ok') continue;
```
Cenário: o código não é vinculado a quem o resgata, então cada chute é comparado contra *todos* os convites vivos do sistema e **incrementa `attempts` de todos**. Com `max_attempts = 5`, **6 chutes errados de qualquer conta autenticada** (teto é 10/h por usuário) deixam todo convite aberto de todos os pacientes `exhausted`; a senhora que acabou de ditar o código ao filho recebe "não vale mais". Secundário: o chute casa com *qualquer* vítima (5×K/1M por conta), não com um alvo. Correção: o resgate deve identificar o convite antes de comparar — pedir também o telefone/nome do sujeito ou emitir um id público de convite (ex.: prefixo de 4 chars) e comparar só contra ele; incrementar `attempts` apenas da linha alvo; pepper obrigatório (hoje `pepper()` devolve `''` se `OTP_PEPPER` faltar, `care-links.ts:27-29`). Esforço: M. Confiança: alta.

**3. Senha do portal do laboratório persiste em claro no prontuário (mensagem, transcrição da foto e a própria foto)** · P1 · Segredos/LGPD · `apps/api/src/handlers/inbound-user.ts:448-460` e `:1402`, `packages/llm/src/tools/xarlote-tools.ts:708-724`, `apps/api/src/handlers/tool-executor.ts:3148`
```ts
insertMessage({ ..., content: inbound.text ?? null, ..., raw_payload: inbound.raw,   // inbound-user.ts:448
...
'Uso o login uma vez e não guardo a senha.'                                           // xarlote-tools.ts:710
const credenciaisCifradas = cifrar(JSON.stringify({ login, senha, ... }), chave);     // tool-executor.ts:3148
```
Cenário: o cofre cifra só a *cópia* que vai pra fila/`lab_fetches` e `apagarCredenciais` (`lab-fetch.ts:212-214`) zera só essa coluna. A senha que o paciente digitou (ou que a visão leu do protocolo e gravou em `messages.transcript`) fica para sempre em `messages`, na foto do protocolo (bucket `xarlote-media`, público — P0 já registrado), no histórico enviado ao LLM nos turnos seguintes, no export LGPD e em `GET /admin/conversations/:id` (qualquer portador do token admin lê a senha do laboratório do Glauber). A promessa dita ao paciente é falsa. Correção: após `fetch_lab_results` aceitar os args, reescrever `content`/`transcript` da mensagem-fonte substituindo login/senha por `[credencial redigida]` (mesma regex de `redigirCredenciais`), e apagar/reprocessar a foto do protocolo (ou mover pro bucket privado) — ou, no mínimo, corrigir o texto da tool. Esforço: M. Confiança: alta.

### P2

**4. Três chaves OpenRouter distintas no histórico git; o repo já esteve público** · P2 · Segredos · commits `a4951b9` (adiciona `prompts.json` com chave `sk-or-v1-b485…`), `1034198` (troca `7c2c…` → `0543…`), `9ede403` ("remove chave… ficou exposta no repo público"); arquivo só saiu do índice em `8ddc181`.
Cenário: a mensagem de `9ede403` confirma revogação de UMA chave pela própria OpenRouter; o status das outras duas não está registrado. Qualquer clone/fork antigo carrega as três. Correção: confirmar no painel OpenRouter que `b485…`, `7c2c…` e `0543…` estão revogadas; rodar `gitleaks` no histórico completo (CI já tem gitleaks, mas só no diff); avaliar BFG/`filter-repo` antes de abrir o repo ou de conceder acesso a terceiros. Esforço: P. Confiança: alta (presença); revogação não confirmada.

**5. `POST /app/messages` sem rate limit → turno de LLM por request** · P2 · Abuso de custo · `apps/api/src/routes/app/messages.ts:164-254`, `apps/api/src/queues/app-inbound.queue.ts:68`
```ts
app.post('/messages', { preHandler: requirePatient }, async (req, reply) => {
  ... // consent gate, xarlote_enabled, media owner-check — nenhum checkUserRateLimit
  const resultado = await enqueueAppInbound({ userId, phoneE164: phone, clientId, text, ... });
```
Cenário: o webhook do WhatsApp e a rota legada `/app/inbound` aplicam `checkUserRateLimit` (25/20s); a rota nova não. Um paciente autenticado (ou script com o refresh de 180 dias) enfileira milhares de mensagens; o `withUserLock` serializa o processamento (1 turno por vez), mas a fila cresce sem teto e cada turno paga LLM + visão + tools. Correção: `checkUserRateLimit(\`app:msg:${userId}\`)` na rota e teto de jobs pendentes por usuário (ex.: rejeitar com 429 se > 5 na fila). Esforço: P. Confiança: alta.

**6. `GET /admin/prompts` devolve `llm_api_key` e `tts_api_key` em claro (inclusive as vindas do env) ao navegador** · P2 · Segredos · `apps/api/src/routes/admin.ts:292-294`, `apps/api/src/config/prompts.ts:97-103`
```ts
app.get('/prompts', async (_req, reply) => { return reply.send(loadPrompts()); });
// prompts.ts: if (process.env['OPENROUTER_API_KEY']) envOverrides.llm_api_key = process.env['OPENROUTER_API_KEY'];
```
Cenário: as chaves atravessam a rede, ficam no state React da tela `/prompts` e em qualquer cache/extension do browser do fundador; comprometimento do token admin ou da sessão do dashboard vira comprometimento das chaves OpenRouter/ElevenLabs. Correção: devolver as chaves mascaradas (`sk-or-…ab12`) e aceitar escrita só quando o campo vier preenchido; tratar chave como write-only. Esforço: P. Confiança: alta.

**7. `ZPRO_WEBHOOK_SECRET` vai na query string e é logado em nível `info` em cada webhook** · P2 · Segredos em log · `apps/api/src/routes/webhook.zpro.ts:89-97`, `apps/api/src/server.ts:95-101` (serializer mantém a query; `disableRequestLogging` não configurado)
```ts
url: req.url.replace(/\d{8,}/g, (m) => `${m.slice(0, 4)}…${m.slice(-2)}`),   // só mascara dígitos; `?key=<segredo>` sobrevive
```
Cenário: o Fastify loga `incoming request` com esse `url` a cada mensagem recebida — o segredo do webhook (que autentica **todo inbound do WhatsApp**) fica no log do Railway, em quem tem acesso a logs, e em qualquer drenagem de log. Correção: no serializer, remover `key` da query (`url.replace(/([?&])key=[^&]*/, '$1key=[redacted]')`); preferir o header `x-zpro-secret` se o painel permitir. Esforço: P. Confiança: alta.

**8. `trustProxy: true` — `req.ip` pode ser forjado via `X-Forwarded-For`, contornando os limites por IP** · P2 · Rate limit · `apps/api/src/server.ts:82`; consumidores em `auth.ts:126,204`, `share-public.ts:47`
Cenário: com `true`, o Fastify usa o endereço mais à esquerda do XFF. Se o edge do Railway *acrescenta* (em vez de sobrescrever) o header, o cliente escolhe o próprio "IP" e os tetos `otp:ip` 10/h, `otpv:ip` 30/h e `share:` 20/10min deixam de existir (amplifica os achados 1, 10 e 11). Correção: `trustProxy: 1` (um hop) ou lista dos IPs do proxy; teste com XFF forjado. Já está no plano (`1A-15`). Esforço: P. Confiança: média — **não confirmado** o comportamento do edge do Railway.

**9. Trava de 5 tentativas do PIN do médico é read-modify-write (não atômica)** · P2 · Auth · `apps/api/src/routes/share-public.ts:83-88`
```ts
await db.from('share_grants').update({ pin_attempts: ((grant.pin_attempts as number) ?? 0) + 1 }).eq('id', grant.id);
```
Cenário: 20 requests paralelos leem `pin_attempts=0` e todos gravam `1`; a trava de 5 vira ~5 rajadas, e com IPs múltiplos (ou achado 8) o espaço de 10.000 PINs fica alcançável em minutos. Correção: incremento no banco (`pin_attempts = pin_attempts + 1` via RPC) com CAS como no OTP (`.eq('pin_attempts', valorLido)`), e limite por token além de por IP. Esforço: P. Confiança: alta (também listado no plano-mestre).

**10. Lockout dirigido no login OTP** · P2 · Auth/DoS · `apps/api/src/routes/app/auth.ts:122-141` e `:217-225`
```ts
checkKeyedRateLimit(`otp:p15:${phone}`, { max: 3, windowS: 15*60 }), checkKeyedRateLimit(`otp:p24:${phone}`, { max: 6, ... })
...
.eq('phone_e164', phone).is('consumed_at', null).order('created_at', { ascending: false }).limit(1);   // só o ÚLTIMO código vale
```
Cenário: qualquer pessoa pede 6 códigos para o telefone da vítima ao longo do dia: o verify só aceita o código mais recente (o que a vítima recebeu vira inválido) e o teto por telefone impede a vítima de pedir outro por até 24h. Correção: no verify, aceitar qualquer código não consumido e dentro do TTL (não só o último); contabilizar o teto por telefone **e** por par (telefone, IP); reenviar o mesmo código dentro do TTL em vez de gerar novo. Esforço: P–M. Confiança: alta.

**11. `/app/auth/otp/request` como bomba de template de autenticação pago** · P2 · Abuso de custo / risco de ban · `apps/api/src/routes/app/auth.ts:172-190`
Cenário: para qualquer E.164 de 10–15 dígitos que não tenha janela de 24h aberta a rota dispara o HSM `autenticacao` (pago, e cada envio a um estranho é um "reportar spam" contra o número oficial). Só há tetos por telefone e por IP (forjável, achado 8); não há teto global nem alerta. Correção: circuit breaker global (ex.: > 50 OTPs/h → alerta Telegram e 503), teto por prefixo DDD/país, e monitorar `app.otp_sent` no anomaly-detector. Esforço: P. Confiança: alta.

**12. Landmine: `NEXT_PUBLIC_ADMIN_API_TOKEN` embutido no bundle público se a env existir na Vercel** · P2 · Segredos · `apps/web/components/layout/ApiAuth.tsx:7-8`, `.env.example:70`
```ts
const TOKEN = process.env['NEXT_PUBLIC_APP_API_TOKEN'] ?? process.env['NEXT_PUBLIC_ADMIN_API_TOKEN'] ?? '';
```
Cenário: o `.env.example` orienta a colocar o token de ADMIN numa var `NEXT_PUBLIC_*`; `ApiAuth` (montado no `/app` público) o injeta em todo fetch. Basta alguém setar essa var no projeto Vercel (ou copiar o `.env.local` de dev) para o token que apaga o banco ir para o JS público. CLAUDE.md afirma que hoje não está no bundle. Correção: apagar o fallback de `NEXT_PUBLIC_ADMIN_API_TOKEN`, e no `.env.example` orientar só `NEXT_PUBLIC_APP_API_TOKEN` (ou nenhum, após o F5). Esforço: P. Confiança: alta (código); **não confirmado** o estado da Vercel.

**13. Dependências de produção com advisories críticos/altos** · P2 · Dependências · `pnpm audit --prod` (107: 3 critical, 65 high, 36 moderate, 3 low)
| Pacote | Versão | Fix | Advisory relevante |
|---|---|---|---|
| `next` (apps/web) | 14.2.35 | ≥15.5.24 | **critical** RCE no Image Optimization com AVIF (GHSA-2xp9-vwfh-vxw4); high: DoS/SSRF em Server Actions e rewrites (GHSA-m99w-x7hq-7vfj, GHSA-p9j2-gv94-2wf4), bypass de middleware com i18n |
| `fastify` (apps/api) | 4.29.1 | ≥5.7.2 | high: tab no `Content-Type` contorna validação de body (GHSA-jx2c-rxcm-jvmq); `find-my-way` DDoS HTTP/2; `fast-uri` SSRF/host confusion |
| `axios` (integrations, whatsapp) | ^1.7 | ≥1.16.0 | high: prototype-pollution gadgets → credential injection/MitM (GHSA-35jp-ww65-95wh) |
| `playwright` (apps/api, worker de exames) | 1.49.1 | ≥1.55.1 | high: download de browser sem verificar TLS (GHSA-7mvr-c777-76hp) |
| `ws` (via supabase-js) | <8.21 | ≥8.21.0 | high: DoS por fragmentos (cliente — impacto baixo) |
| `form-data` | <4.0.6 | ≥4.0.6 | high: CRLF em multipart |
Contexto: `next/image` não é usado e a otimização roda na Vercel (mitiga o crítico, não confirmado); a API valida body com zod à mão (o bypass do Fastify não muda o veredito). Correção: atualizar `next` para a linha corrigida (15.5.x) ou o backport 14.2 mais novo se existir; `axios ≥1.16`, `playwright ≥1.55`, `fastify` 4 → 5 planejado. Esforço: M–G. Confiança: alta.

**14. CPF, nascimento, telefone e endereço completo no system prompt enviados ao OpenRouter/provedor sem restrição de retenção** · P2 · LGPD/minimização · `packages/llm/src/prompts/agent-clinic.system.ts:132-153`, `agent-pharmacy.system.ts:29-31`, `packages/llm/src/client.ts:299-300`
```ts
kd.cpf ? `- CPF: **${kd.cpf}**` : '', kd.birthDate ? `- Nascimento: **${kd.birthDate}**` : '', kd.phone ? `- Telefone: **${kd.phone}**` : '',
```
Cenário: o modelo de chat em prod é `z-ai/glm-5.2` (roteado pelo OpenRouter); a requisição não pede `provider: { data_collection: 'deny' }`/ZDR, e o header `HTTP-Referer` ainda aponta para `iadasaude.com` (domínio que virou "Radar Materno"). Dados sensíveis (art. 11) + CPF saem do país para operadores sem DPA registrado. Correção: enviar `provider.data_collection='deny'` e restringir a provedores com ZDR para os agentes de farmácia/clínica; passar CPF/telefone por placeholder substituído no `sendOutbound` (o modelo não precisa do valor, só de saber que existe); documentar operadores/transferência internacional. Esforço: M. Confiança: alta (código); política de retenção dos provedores **não confirmada**.

### P3

**15. Access token não consulta revogação; SSE sobrevive à revogação e não tem teto** · P3 · Sessão · `apps/api/src/middleware/patient-auth.ts:66-95`, `apps/api/src/routes/app/stream.ts:45-113`, `account.ts:72`
Cenário: após logout, `DELETE /account` (que apaga `app_sessions`) ou detecção de reuso, o access vale até 15 min e um `/stream` aberto continua entregando mensagens indefinidamente (cada conexão abre um cliente Redis próprio, sem limite por usuário). Correção: cache curto (Redis, 60s) de `sid` revogados consultado em `requirePatient`; fechar o SSE quando `exp` do JWT chegar; teto de 3 conexões por usuário. Esforço: P–M. Confiança: alta.

**16. Cofre do laboratório sem AAD nem versão de chave** · P3 · Cripto · `apps/api/src/lib/lab-vault.ts:59-80`
Cenário: AES-GCM está correto (IV 12 B aleatório, tag verificada, chave validada), mas o envelope não é amarrado ao `fetch_id`/`user_id`: quem tiver escrita no banco pode transplantar o ciphertext de uma linha para outra e fazer o worker digitar a credencial de um paciente no portal de outro; sem `kid`, rotação de `LAB_VAULT_KEY` invalida buscas agendadas. Correção: `setAAD(Buffer.from(fetchId))` na cifra e decifra; prefixo de versão no envelope. Esforço: P. Confiança: alta.

**17. `INCR` + `EXPIRE` não atômicos no limitador fail-closed** · P3 · Disponibilidade · `apps/api/src/middleware/rate-limit.ts:51-53`
Cenário: se o processo cai entre o `incr` e o `expire` da primeira contagem, a chave fica sem TTL e aquele telefone/IP fica bloqueado para sempre (login negado, link do médico negado). Correção: `SET key 1 EX ttl NX` + `INCR`, ou script Lua. Esforço: P. Confiança: alta.

**18. Jobs concluídos ficam no Redis com o texto — inclui o código OTP e mensagens clínicas** · P3 · Dados em repouso · `apps/api/src/queues/outbound.queue.ts:76` (`removeOnComplete: 1000`), `auth.ts:174`
Correção: `removeOnComplete: true` (ou 100) e limpar `text` no `completed`; para OTP, job com `removeOnComplete: true`. Esforço: P. Confiança: alta.

**19. Observabilidade pública/externa vaza mais do que deveria** · P3 · Info leak · `apps/api/src/server.ts:113-115` + `observability/sentry.ts:41-63`; `routes/health.ts:113-121`
Cenário: o hook `onError` manda `url` crua ao Sentry (o alias legado `GET /app/overview/:phone` põe telefone na URL — `sentry.ts` redige por *nome de chave*, não o valor de `url`); `/ready` público devolve `detail` com mensagem de erro de DB/Redis e `?llm=1` força chamada ao OpenRouter a cada hit. Correção: mascarar dígitos no `url` antes de `captureError`; `/ready` sem `detail` para não autenticados; `?llm=1` só com token admin. Esforço: P. Confiança: alta.

**20. Validação de entrada e oráculos** · P3 · Entrada · `apps/api/src/routes/app/care.ts:61-108` (sem zod: `nome` sem teto, `nascimento` cru → `birth_date`, erro do Postgres ecoado em `care-links.ts:267`), `reminders.ts:823` (`error.message` ao cliente), `media.ts:254-256`/`account.ts:191-193`/`reminders.ts:804-805` (403 ≠ 404 confirma ids alheios; `memory.ts` e `shares.ts` fazem certo), `messages-cursor.ts:30-33` (`id` do cursor não validado como UUID — já sabido). Correção: zod nas duas rotas de care (`nome` ≤ 80, `nascimento` `YYYY-MM-DD`), 404 uniforme, nunca ecoar `error.message`. Esforço: P. Confiança: alta.

## 3. Tabela de rotas

| Rota | Método | Auth | Valida body/query | Filtra por dono | Rate limit |
|---|---|---|---|---|---|
| `/health`, `/ready` | GET | nenhuma | — | — | não (`/ready?llm=1` chama OpenRouter) |
| `/webhook/uazapi/:instance` | POST | segredo **opcional** (header) — já coberto | normalize tolerante | — | por telefone 25/20s |
| `/webhook/zpro/:instance` | POST | segredo **opcional** (`?key=`/header) — já coberto; segredo logado (#7) | normalize tolerante | — | por telefone 25/20s |
| `/share/resolve` | POST | token 256 b no corpo (+PIN) | zod | por `token_hash` | IP 20/10min (fail-closed); PIN não atômico (#9) |
| `/app/auth/otp/request` | POST | pública | zod | — | tel 3/15m, 6/24h; IP 10/h (spoofável #8) |
| `/app/auth/otp/verify` | POST | pública | zod | — | IP 30/h; 3 tentativas/código (CAS) |
| `/app/auth/refresh` | POST | refresh opaco | zod | por hash | **não** (256 b, ok) |
| `/app/auth/logout` | POST | JWT | zod opcional | `sid` do token | — |
| `/app/me`, `/app/consent` | GET/POST | JWT | zod (POST) | `sub` | — |
| `/app/messages` | GET | JWT | zod (cursor ≤256) | conversa via `sub`→telefone | — |
| `/app/messages` | POST | JWT | zod (text ≤4000, mediaId uuid, clientId uuid) | `sub` + dono da mídia | **não** (#5) |
| `/app/messages/typing` | POST | JWT | — | `sub` | não |
| `/app/stream` | GET (SSE) | JWT (só na abertura) | — | conversa via `sub` | sem teto de conexões (#15) |
| `/app/devices` | POST/DELETE | JWT | zod | `user_id` no upsert/delete | — |
| `/app/overview` | GET | JWT | `?subject` validado por `care_links` ('ver') | sim | — |
| `/app/reminders` | GET/POST | JWT | zod | `?subject` ('ver'/'agir') | POST: ator 25/20s + cap de ativos |
| `/app/reminders/:id/action` | POST | **dual**: JWT **ou** APP token público + `phone` (legado, P0 já coberto) | zod | `reminder.user_id === userId` (403 oráculo) | só no caminho legado |
| `/app/account` | DELETE | JWT | zod (frase) | `sub`; revoga sessões/devices/links antes de enfileirar | — |
| `/app/export`, `/app/export/:id` | POST/GET | JWT | — | `user_id` (403 oráculo no GET) | 1/10 min |
| `/app/shares`, `/app/shares/:id` | POST/GET/DELETE | JWT | zod | `user_id` no próprio UPDATE | máx. 5 ativos |
| `/app/media` | POST | JWT | **manual** (base64/multipart), `bodyLimit` 14 MB, sniff por magic bytes | path `${userId}/${uuid}` | **não** (sem cota de storage) |
| `/app/media/:id/url` | GET | JWT | `:id` cru (uuid inválido → 404) | `user_id` (403 oráculo) | — |
| `/app/memory/:id` | DELETE | JWT | — | `user_id` no SELECT **e** no DELETE | lock por usuário |
| `/app/care/invites` | POST | JWT | — | `sub` | 5/h + máx. 3 abertos |
| `/app/care/links` | POST | JWT | **sem zod** (`codigo`, `relation` em Set) | varre **todos** os convites (#2) | 10/h |
| `/app/care/dependents` | POST | JWT | **sem zod** (#20) | `sub` | 5/24h |
| `/app/care/links`, `/app/care/links/:id` | GET/DELETE | JWT | — | ambas as pontas (`user_id` ou `caregiver_user_id`) | — |
| `/app/overview`, `/app/overview/:phone`, `/app/inbound`, `/app/push/*` (legado `routes/app.ts`) | POST/GET | APP token público + telefone — **P0 já coberto** | zod | por telefone informado (não autentica) | 25/20s por telefone |
| `/admin/*` (30 rotas) | vários | `x-admin-token` (preHandler do plugin, sha256+`timingSafeEqual`, 503 fail-closed em prod) | **nenhuma com zod** (manual) | n/a (admin) | não |
| ↳ `/admin/prompts` GET/PUT | | | | devolve chaves em claro (#6) | |
| ↳ `/admin/reset-dev` | POST | admin + `NODE_ENV!=prod` ou `ALLOW_RESET_DEV` + header `x-confirm-wipe` | | wipe total | |
| ↳ `/admin/test/cleanup` | POST | admin; **alcançável em prod** mas só apaga o telefone sintético `+5562000000009` e nomes `🧪 …` (`admin.ts:520-521`) | | | |
| ↳ `/admin/message`, `/admin/reengage/send`, `/admin/tts/test` | POST | admin | manual | envia WhatsApp real / gasta ElevenLabs (texto sem teto) | não |
| `/api/simulate/*` | vários | 404 se `NODE_ENV=production`; admin em dev (`simulate.ts:31-37`) | zod parcial | `reset-all` apaga tudo | não |

## 4. O que verifiquei e está OK

- **Admin**: comparação via `sha256` + `timingSafeEqual` (`auth.ts:18-23`); sem token em prod → 503 (fail-closed) (`auth.ts:35-46`); `preHandler` no nível do plugin cobre todas as 30 rotas (`admin.ts:29`); `/health` não expõe segredo; `/reset-dev` com trava tripla.
- **JWT** (`app-jwt.ts:64-96`): HS256 manual, assinatura verificada **antes** de ler o payload, `timingSafeEqual` com checagem de tamanho, `alg` do header ignorado (sempre HMAC — `alg:none` falha), `iss/aud/exp/sub/sid` validados, TTL 15 min, `verify` nunca lança; `patient-auth.ts` fail-closed até em dev sem `APP_JWT_SECRET`.
- **Refresh** (`refresh-token.ts`, `auth.ts:292-346`): 256 bits `randomBytes`, só sha256 no banco, rotação com CAS no hash vigente, graça de 60 s, reuso fora da graça revoga a sessão e audita, idade máxima 180 d, hash hex (sem injeção no filtro `or`).
- **OTP** (`otp.ts`, `auth.ts:116-289`): 6 dígitos via `crypto.randomInt`, `sha256(pepper:salt:code)` com salt por linha e pepper de env (fail-closed sem pepper), `attempts` incrementado por CAS antes de comparar, 3 tentativas, TTL 5 min, comparação constante, código nunca em `messages`/log/audit, resposta idêntica exista ou não o usuário, template AUTHENTICATION fora da janela de 24 h, conta demo com `constantTimeEquals`. Não há fluxo de troca de número (n/a).
- **IDOR**: todas as rotas novas derivam o dono do JWT; `resolverSujeitoDaRequisicao` consulta `care_links` a cada request sem cache, 404 uniforme, capacidade `falar` nunca concedida (`care-access.ts:88-113`); o resgate `only-one` do `resolveEntityRef` é neutralizado incluindo o ator entre os candidatos (`care-access.ts:169-198`); `DELETE /memory/:id` e `DELETE /shares/:id` repetem `eq('user_id')` na própria escrita; `revogarVinculo` aceita qualquer das duas pontas.
- **Link do médico**: token 256 b `base64url`, só sha256 no banco, TTL 72 h/máx. 7 d, PIN com salt de 16 B por link e comparação constante, `revoked/expired` avaliados antes do PIN, uma única forma de recusa, `X-Robots-Tag` + `robots: noindex/noarchive` (`layout.tsx:34-38`), token no corpo do POST, resumo congelado sem telefone/CPF/nascimento (só idade), acesso auditado sem IP; `DELETE /account` revoga todos os links.
- **Cofre**: AES-256-GCM, IV 12 B aleatório por cifra, tag de 16 B verificada, chave de 32 B validada por regex (`lab-vault.ts:26-30,59-80`); `tool_input` **e** `tool_output` redigidos (`tool-executor.ts:314,388`); credencial zerada em todo desfecho; consentimento gravado antes do insert com `evidence_message_id`; recusa de CAPTCHA/2FA por princípio.
- **Mídia**: allowlist por magic bytes (SVG/HTML/EXE rejeitados; HEIC×M4A desambiguado pela marca `ftyp`), `contentType` do Storage vem dos bytes, bucket `xarlote-app-media` privado com URL assinada de 600 s, caminho sem entrada do usuário, `bodyLimit` só nessa rota, PDF cifrado com senha vazia tratado (`pdf-cripto.ts`, RC4/MD5 só por compatibilidade com a spec, não protege dado nosso).
- **Segredos versionados**: nenhum segredo real em arquivo rastreado hoje (grep por `sk-or-`, JWT, `AKIA`, `xox`, `AIza`, `sk_`, chave privada, `service_role` só acha placeholders/menções); `.env`, `.env.staging`, `apps/api/data/prompts.json` no `.gitignore`; `prompts.json` local (não versionado) contém uma chave ElevenLabs viva — não copiada aqui.
- **Web/cookies**: cookie `dash_session` httpOnly + secure + `sameSite=lax`, HMAC-SHA256 com `timingSafeEqual`, exp 7 d; senha comparada em tempo constante; token admin só via `/api/auth/token` com `Cache-Control: no-store` e mantido em memória; **CSRF**: mutações usam header `x-admin-token` (não forjável cross-site) e CORS da API é allowlist; matcher do middleware cobre todas as rotas `(dash)` (nenhuma começa com `app`/`s/`/`login`/`api`/`icon`); headers de segurança ausentes e open redirect `//` no `next` — já sabidos.
- **Mobile**: tokens em SecureStore `WHEN_UNLOCKED_THIS_DEVICE_ONLY`; refresh em voo único; nenhum `console.*` com token/OTP; `scheme: 'xarlote'` sem handler de deep link customizado (só `tel:192`); cadeado biométrico local com saída = logout.
- **Sentry**: `sendDefaultPii:false`, cookies/headers/body/query removidos em `beforeSend`, `tracesSampleRate:0`.
- **LGPD**: `consent_events` gravado no aceite WhatsApp (`inbound-user.ts:610`), no aceite do app (`consent.ts:67`), no vínculo/dependente/revogação de cuidado (`care-links.ts:195,269,319`), na busca de exames (`tool-executor.ts:3141`) e no forget-me (`forget-me.ts:328`); compartilhamento com médico vai para `audit_log` (append-only) — aceitável; contato de emergência (`tool-executor-v2.ts:1240`) só audita — documentar a base legal (art. 7 VII/art. 11 II e). Export (`app-export.ts`) traz só dados do titular (vínculos dos dois lados apenas com ids, sem `token_hash`/PIN), inclui consentimentos e registro de acessos.
- **API**: `helmet` (nosniff/HSTS/frame-deny), CORS allowlist (nega em prod sem `CORS_ORIGINS`), redação de `authorization`/`x-admin-token`/`cookie` no logger, `bodyLimit` global 1 MB, multipart 10 MB.

## 5. Perguntas em aberto

1. `NODE_ENV=production` está setado nos dois services do Railway? É o único gate de `/api/simulate/reset-all` (404) e do fail-closed do admin.
2. O edge do Railway **sobrescreve** ou **acrescenta** `X-Forwarded-For`? Decide se o achado 8 é real.
3. As três chaves OpenRouter do histórico (`b485…`, `7c2c…`, `0543…`) estão todas revogadas? O repo `projetoiasaude/XARLOTE` continua privado e sem forks?
4. `NEXT_PUBLIC_ADMIN_API_TOKEN` está entre as 7 env vars do projeto Vercel?
5. Entropia/comprimento de `DASHBOARD_PASSWORD`, `ADMIN_API_TOKEN`, `APP_JWT_SECRET`, `OTP_PEPPER`, `LAB_VAULT_KEY` em produção (o `.env.example` orienta `openssl rand`, mas não dá para verificar).
6. Existe DPA/registro de operador para OpenRouter e para o provedor do `z-ai/glm-5.2`? Há política de retenção zero contratada?
7. `ZPRO_WEBHOOK_SECRET` está setado em prod, e o painel do zpro aceita header em vez de query?
8. A Vercel serve `/_next/image` pela própria infra neste projeto (mitiga GHSA-2xp9-vwfh-vxw4)? Há plano de sair do Next 14?
9. A senha em texto puro no exame do Glauber (backlog) já foi redigida de `messages`/`transcript` e a foto do protocolo removida do bucket público?
