# Xarlote — Plano de Robustez & Escala (Production Hardening Roadmap)

> Objetivo: levar a Xarlote de "protótipo brilhante" a **sistema de produção
> absurdamente robusto, seguro e pronto pra milhares de usuários** — sem perder
> a alma do produto (memória evolutiva + proatividade + segurança clínica).
>
> Este documento é a fonte de verdade do hardening. Cada item tem **DoD**
> (Definition of Done = como saber que está pronto) e **esforço** (S ≤1d ·
> M 2-4d · L 1-2sem). Marque `[x]` ao concluir.
>
> Base: auditoria técnica de 2026-05-28 (4 frentes de investigação + leitura
> de código). Referências `arquivo:linha` apontam pro estado no momento da
> auditoria.

---

## Princípios norteadores (a filosofia do sistema)

Toda decisão deste plano serve a 7 invariantes. Se um PR viola um deles, não entra.

1. **API stateless** — nada crítico vive na memória do processo. Reiniciar = zero perda.
2. **Durável por padrão** — todo trabalho com efeito colateral passa por fila persistente.
3. **Idempotente por padrão** — repetir uma operação nunca duplica efeito (pedido, msg, cobrança).
4. **Observável por padrão** — todo caminho tem trace_id, métrica e alerta.
5. **Seguro por padrão** — nega acesso por padrão; segredo nunca no código; PII nunca em log.
6. **Testado nos caminhos que machucam** — red-flag, cotação, consentimento têm teste automatizado.
7. **Consciente de custo** — cada turno de conversa tem orçamento de tokens previsível.

---

## Visão geral das fases

| Fase | Meta | Quando libera | Esforço aprox. |
|---|---|---|---|
| **F0 — Destravar** | Fechar buracos que impedem QUALQUER usuário real | imediato | ~1 semana |
| **F1 — Fundação sólida** | Soft launch controlado (50-200 usuários) | após F0 | ~2-3 semanas |
| **F2 — Escala real** | Milhares de usuários concorrentes | após F1 | ~3-4 semanas |
| **F3 — Excelência & moat** | Diferencial disruptivo + maturidade operacional | contínuo | ongoing |

> ✅ **Já feito** (Fase 1 da observabilidade): retenção de logs (`prune_system_logs` +
> pg_cron), índices no `system_logs`, `/timeline` com paginação keyset + filtros
> server-side. Isso adianta parte de F2.14.

> ### 🟢 Status 2026-05-29 — sessão de hardening (código)
> Commits `7a88aa4`→`1b34ca1` na `main` (pushados). **Nada deployado ainda** —
> tudo ativa junto no próximo `railway up`.
> - **Feito + pushado:** F1.A5 graceful shutdown · F1.B5+F0.1 health checks
>   (`/health` liveness, `/ready` + ping LLM via `GET /key`) · F1.B1 Sentry
>   (env-gated) · F2.G5 rate-limit por usuário · F1.C6 Zod na resposta da LLM ·
>   F1.C1 testes (vitest, 31 verdes — unit; integração cotação/consulta depois).
> - **Pronto mas PARADO** na branch `ci-workflows` (push exige escopo `workflow`
>   no PAT): F1.C2 CI · F1.D1 gitleaks · F1.D4 pnpm audit. **Dependabot já ativo.**
> - **F0.2–F0.7:** código pronto+pushado, **deploy pendente** (fecha o gate F0).
> - **Pendências do founder:** deploy Railway (+ `ADMIN_API_TOKEN`/`CORS_ORIGINS`,
>   volume `apps/api/data`) · F0.9 backup banco · branch protection · token com
>   escopo `workflow` · `SENTRY_DSN` (ativar Sentry).

---

# FASE 0 — DESTRAVAR (não lançar sem isto)

Buracos de segurança e de segurança-de-vida. Custo baixo, impacto existencial.

- [x] **F0.1 — Validar/rotacionar a chave OpenRouter (401 em prod).** ✅ chave válida em prod; ping leve via `GET /key` agora no `/ready` (detecta 401 sem custo). _Por quê:_ vi `401 AUTH/KEY INVÁLIDA` no stream de críticos (26/05) — se persistir, a Xarlote está muda. _DoD:_ smoke test de chat passa em prod; healthcheck inclui um ping leve à LLM; alerta se voltar a dar 401. **S**
- [ ] **F0.2 — Autenticação em `/admin/*`.** _Por quê:_ rotas 100% abertas hoje (`admin.ts`) — qualquer um lê PII clínico e troca sua chave LLM. _DoD:_ middleware exige token/sessão; sem token → 401; RBAC mínimo (papel `admin`); teste cobre rota protegida. **M**
- [ ] **F0.3 — Blindar `/api/simulate/*`.** _Por quê:_ `reset-all`/`reset` apagam produção sem auth (`simulate.ts:180`). _DoD:_ desabilitado por env em prod (`NODE_ENV==='production'` → 404) **e** atrás de auth em dev/staging. **S**
- [ ] **F0.4 — Travar CORS.** _Por quê:_ `origin:true` aceita qualquer site (`server.ts:32`). _DoD:_ allowlist explícita (dashboard local + domínio futuro); origem fora da lista bloqueada. **S**
- [ ] **F0.5 — Redação de PII em logs.** _Por quê:_ telefone/lat-lng/nome do contato + **payload bruto do webhook** em texto plano (`queries.ts:148`, `webhook.uazapi.ts:42`) — viola LGPD. _DoD:_ `writeLog` sanitiza campos sensíveis; pino com `redact`; parar de persistir payload bruto; teste garante que telefone/CPF/endereço não aparecem em nível ≥ info. **M**
- [ ] **F0.6 — Red-flag escalation durável (segurança de vida).** _Por quê:_ escalonamento de emergência vive em `setTimeout` na memória (`red-flag-handler.ts:185`) — restart nos 60s perde o aviso. _DoD:_ pendência em `red_flag_pending` (já existe a tabela) + worker que varre vencidos e escala; teste simula crash no meio e confirma que o contato é avisado. **M**
- [ ] **F0.7 — Fila + rate-limit no envio WhatsApp.** _Por quê:_ envio direto via axios, sem limite (`outbound.ts:43`); filas `outbound-whatsapp:*` definidas mas mortas (`constants.ts:44`). 1 número + rajada = ban. _DoD:_ todo envio passa por BullMQ com limiter (msgs/s configurável) + backoff em 429; nenhum `sendText` direto fora do worker da fila; teste. **M**
- [ ] **F0.8 — Backup do código (disaster recovery).** _Por quê:_ 56 commits só no seu Mac (push bloqueado). _DoD:_ `origin/main` == local; branch protection ligada; push funcionando com a conta certa. **S**
- [ ] **F0.9 — Backup do banco verificado.** _Por quê:_ sem restore testado, backup é fé. _DoD:_ PITR/backup automático confirmado no Supabase; **um restore de teste executado** e documentado. **S**

**Gate de saída da F0:** nenhuma rota sensível aberta · Xarlote responde · nenhum PII em log · emergência sobrevive a restart · envio com rate-limit · código e dados com backup testado.

---

# FASE 1 — FUNDAÇÃO SÓLIDA (soft launch)

Aqui o sistema vira confiável. Liberar pra dezenas/centenas de usuários reais.

### Workstream A — Arquitetura & Resiliência
- [ ] **F1.A1 — Separar API de workers em processos/services distintos.** _Por quê:_ hoje 10 workers no mesmo processo da API (`server.ts:48`) — crash de worker derruba HTTP; scan pesado trava o event loop. _DoD:_ 2 services no Railway (api + worker) compartilhando o monorepo; crash de worker não afeta a API; deploy independente. **L**
- [ ] **F1.A2 — Crons sob lock (sem duplicação em N réplicas).** _Por quê:_ `setInterval` em cada réplica = cron rodando N vezes. _DoD:_ crons migrados pra BullMQ repeatable jobs **ou** pg_cron com advisory lock; rodar 2 réplicas não duplica execução; teste. **M**
- [ ] **F1.A3 — Consolidação de cotação durável (farmácia + clínica).** _Por quê:_ `setTimeout`+`Set` em memória (`quote-consolidation.ts:6`); só clínica tem rescue. _DoD:_ estado em DB + dispatcher que resgata pendentes (estender o `consultation-dispatcher` pra farmácia); restart não perde consolidação; teste. **M**
- [ ] **F1.A4 — Idempotência ponta-a-ponta.** _Por quê:_ replay de webhook ou retry pode duplicar pedido/mensagem. _DoD:_ chave de idempotência em sends e tool-calls que criam recursos; reprocessar o mesmo evento é no-op; teste de replay. **M**
- [ ] **F1.A5 — Graceful shutdown (SIGTERM).** _Por quê:_ todo redeploy derruba jobs em voo. _DoD:_ ao receber SIGTERM, para de aceitar novos, drena fila/conexões, sai limpo; deploy não perde trabalho. **S**

### Workstream B — Observabilidade
- [ ] **F1.B1 — Error monitoring (Sentry) em api + worker + web.** _DoD:_ erro em prod gera evento com stack + trace_id + contexto do usuário (sem PII); alerta chega. **S**
- [ ] **F1.B2 — Correlação por trace_id no pipeline inteiro.** _DoD:_ um trace_id rastreia da entrada do webhook até o envio da resposta, atravessando filas. **M**
- [ ] **F1.B3 — Métricas + dashboard.** _DoD:_ painel com latência LLM (p50/p95/p99), taxa de erro, profundidade de fila, custo estimado/turno, msgs/s WhatsApp. **M**
- [ ] **F1.B4 — Alertas acionáveis.** _DoD:_ alerta pra: fila travada, erro LLM sustentado, indício de ban WhatsApp, red-flag disparado, custo/hora acima do teto. **S**
- [ ] **F1.B5 — Health checks profundos (liveness vs readiness).** _DoD:_ `/health` verifica DB + Redis + fila + LLM; readiness só fica verde quando dependências OK. **S**

### Workstream C — Qualidade & Entrega
- [ ] **F1.C1 — Testes dos fluxos críticos.** _Por quê:_ zero testes hoje, num app com lógica de emergência. _DoD:_ unit + integration cobrindo red-flag, cotação farmácia, fluxo de consulta, consentimento, esquece-me; rodam no CI. **L**
- [ ] **F1.C2 — CI/CD (GitHub Actions).** _DoD:_ PR roda typecheck + lint + test + build; merge bloqueado se falhar; deploy automático no merge. **M**
- [ ] **F1.C3 — Ambiente de staging.** _DoD:_ réplica de prod; fluxo deploy → staging → prod; smoke test em staging antes de promover. **M**
- [ ] **F1.C4 — Lockfile congelado no build.** _Por quê:_ `--no-frozen-lockfile` (`nixpacks.toml`) = build não-reproduzível. _DoD:_ build usa lockfile travado; falha se divergir. **S**
- [ ] **F1.C5 — Lint no backend + pre-commit hooks.** _DoD:_ `pnpm -r lint` limpo no CI; hook bloqueia commit sujo. **S**
- [ ] **F1.C6 — Zod em toda fronteira não-confiável.** _Por quê:_ resposta da LLM e webhook sem validação de schema (regra do CLAUDE.md violada em `client.ts:139`). _DoD:_ resposta da LLM e payload de webhook validados por Zod; malformado → fallback seguro, nunca crash. **M**

### Workstream D — Segurança (aprofunda F0)
- [ ] **F1.D1 — Gestão de segredos + scan no CI.** _DoD:_ todos os segredos em Railway/Vault; rotação documentada; `gitleaks` no CI bloqueia segredo commitado. **S**
- [ ] **F1.D2 — Cobertura RLS 100%.** _DoD:_ toda tabela com PII tem RLS negando por padrão; advisor do Supabase sem warnings de segurança. **M**
- [ ] **F1.D3 — Validação/sanitização de input em todas as rotas.** _DoD:_ Zod em todo body/query; payload malicioso não derruba nem injeta. **S**
- [ ] **F1.D4 — Dependency scanning.** _DoD:_ Dependabot + `pnpm audit` no CI; CVE crítico bloqueia merge. **S**

### Workstream E — Integridade de negócio
- [ ] **F1.E1 — Códigos de referência nas cotações.** _Por quê:_ fecha 100% a mistura de pedidos concorrentes na mesma farmácia (parcialmente tratado). _DoD:_ cada mensagem ao fornecedor leva `#código`; resposta roteada à cotação certa; ambiguidade vira pergunta, não palpite; teste com 2 pedidos simultâneos. **M**

**Gate de saída da F1:** API stateless · workers isolados · agendamento durável · idempotente · observável (Sentry+métricas+alertas) · CI/CD + staging · testes dos fluxos críticos verdes · RLS completa.

---

# FASE 2 — ESCALA REAL (milhares de usuários)

Agora o sistema cresce horizontalmente e o custo fica previsível.

### Workstream F — Escala horizontal
- [ ] **F2.F1 — API stateless + autoscaling.** _DoD:_ N réplicas da API sem estado compartilhado em memória; autoscale por CPU/req. **M**
- [ ] **F2.F2 — Locks distribuídos.** _DoD:_ seções críticas usam pg advisory lock ou Redis Redlock; nunca executam 2x mesmo com N réplicas. **M**
- [ ] **F2.F3 — Outbox pattern para side-effects.** _DoD:_ todo efeito (send, audit, enrich) gravado transacionalmente numa outbox e consumido por worker; zero efeito perdido em falha parcial. **L**
- [ ] **F2.F4 — Dead-letter queue + política de retry por fila.** _DoD:_ job que falha N vezes vai pra DLQ com alerta; reprocessamento manual possível. **M**
- [ ] **F2.F5 — Circuit breakers nas integrações externas.** _Por quê:_ LLM/TTS/Places/uazapi caídos não podem derrubar o app. _DoD:_ breaker por dependência; quando aberto, degrada graciosamente (ex: responde sem voz, avisa atraso). **M**

### Workstream G — Performance & Custo
- [ ] **F2.G1 — Cache (Redis) para leituras quentes.** _DoD:_ `prompts.json`, `user360`, resultados de Places cacheados com invalidação correta; hit rate medido. **M**
- [ ] **F2.G2 — Connection pooling + matar N+1 no inbound.** _Por quê:_ ~15-20 queries sequenciais por mensagem (`inbound-user.ts`). _DoD:_ Supabase pooler/PgBouncer; reduzir round-trips por turno; pool não satura sob carga. **M**
- [ ] **F2.G3 — Prompt caching + enxugar system prompt.** _Por quê:_ ~8k tokens (`xarlote.system.ts`) a cada turno = custo dominante. _DoD:_ prompt caching do provider ligado; prompt modularizado (carrega só o necessário); custo/turno cai ≥40%; latência cai. **M**
- [ ] **F2.G4 — Orçamento de tokens + truncamento inteligente.** _DoD:_ teto de tokens por turno; história/memória truncadas por relevância, não só por contagem; custo por conversa previsível. **M**
- [ ] **F2.G5 — Rate limiting por usuário (anti-flood/abuso).** _DoD:_ usuário malicioso não estoura custo nem fila; limite por janela. **S**

### Workstream H — WhatsApp em escala
- [ ] **F2.H1 — Migração para WhatsApp Business API oficial.** _Por quê:_ uazapi não-oficial tem teto baixo e risco de ban. _DoD:_ envio sancionado (lado usuário e/ou fornecedor); templates aprovados; número verificado. **L**
- [ ] **F2.H2 — Pool de números + warming + detecção de ban** (se mantiver canal não-oficial em algum ponto). _DoD:_ ban de 1 número não derruba o serviço; rotação automática; alerta de ban. **L**

### Workstream I — Dados em escala
- [ ] **F2.I1 — Particionamento + arquivamento cold (continua a obs. F1).** _DoD:_ `system_logs`/`event_log` particionados por mês; bruto arquivado em R2/Storage antes de podar; tabela quente fica pequena pra sempre. **M**
- [ ] **F2.I2 — Rollup de `event_log` → `daily_metrics`.** _DoD:_ worker agrega telemetria diária; bruto >90d arquivado; dashboards leem o agregado. **M**
- [ ] **F2.I3 — Load testing (k6/Artillery).** _DoD:_ simular milhares de conversas concorrentes; sistema sustenta meta de RPS com p95 dentro do alvo; gargalos documentados. **M**

**Gate de saída da F2:** roda com N réplicas sem duplicar efeito · custo/turno previsível e otimizado · WhatsApp sancionado/resiliente · sustenta carga-alvo em teste de carga.

---

# FASE 3 — EXCELÊNCIA & MOAT (disruptivo + maduro)

O que separa "funciona" de "absurdamente avançado" — e constrói o diferencial defensável.

### Workstream J — IA confiável (o coração do produto)
- [ ] **F3.J1 — Harness de avaliação do agente (eval).** _DoD:_ dataset de conversas-teste + asserts automáticos (red-flag dispara nos gatilhos certos? nunca sugere dose? tom correto? não alucina farmácia?); roda no CI; regressão de qualidade barra o deploy. **L**
- [ ] **F3.J2 — Guardrails de segurança clínica.** _DoD:_ camada que bloqueia respostas inseguras (diagnóstico, ajuste de dose, negar emergência); detecção de alucinação; verificação antes de enviar. **L**
- [ ] **F3.J3 — Versionamento de prompts + A/B + rollback.** _DoD:_ todo prompt é versionado; trocar é reversível; experimentos A/B medem qualidade/custo. **M**

### Workstream K — Operação de classe mundial
- [ ] **F3.K1 — Feature flags + canary/blue-green deploy.** _DoD:_ rollout gradual com kill-switch; reverter é 1 clique. **M**
- [ ] **F3.K2 — SLOs + error budgets + runbooks + on-call.** _DoD:_ SLO definido (ex: 99.5% de respostas <Xs) e medido; runbook por tipo de alerta; rodízio de plantão. **M**
- [ ] **F3.K3 — Chaos engineering + DR drills.** _DoD:_ exercícios que matam Redis/worker/LLM em staging; sistema degrada graciosamente; RTO/RPO medidos. **M**
- [ ] **F3.K4 — Pen-test + postura LGPD formal.** _DoD:_ pen-test sem achados críticos; DPA, política de retenção e base legal documentadas; (futuro) trilha pra ISO 27001/SOC2. **L**

### Workstream L — Produto transformador (o "wow")
- [ ] **F3.L1 — Motor de cuidado proativo.** _Por quê:_ é o moat — ninguém mais lembra do seu remédio. _DoD:_ jobs proativos de adesão, recompra ("seu losartana acaba em 3 dias, já cotei, quer que eu peça?") e follow-up pós-consulta, todos consentidos e auditados. **L**
- [ ] **F3.L2 — Loop de fulfillment fim-a-fim.** _DoD:_ cotação → pagamento → rastreio → confirmação dentro do fluxo; pedido fecha sem sair do WhatsApp. **L**
- [ ] **F3.L3 — Efeito de rede do fornecedor.** _DoD:_ farmácias/clínicas como malha (portal ou API); cada novo fornecedor melhora a cotação dos próximos. **L**
- [ ] **F3.L4 — Analytics de produto.** _DoD:_ dashboard executivo com retenção, conversão, NPS, custo por usuário ativo. **M**

---

## Definition of Production-Ready (gates mensuráveis)

O sistema está "pronto pra milhares" quando **todos** forem verdade:

- **Segurança:** nenhuma rota sensível sem auth · zero PII em logs · RLS 100% · pen-test sem críticos · segredos fora do código (scan no CI).
- **Resiliência:** reiniciar qualquer processo a qualquer momento = zero perda de dado/efeito · emergência (red-flag) sobrevive a crash · graceful shutdown.
- **Escala:** roda com ≥2 réplicas sem duplicar efeitos · passa no load test da carga-alvo com p95 dentro do SLO · WhatsApp sancionado/resiliente.
- **Qualidade:** fluxos críticos com teste automatizado · eval do agente no CI · CI/CD com staging · deploy reversível em 1 clique.
- **Observabilidade:** todo erro vira alerta acionável · trace_id ponta-a-ponta · custo/turno medido e dentro do orçamento.
- **Continuidade:** backup do banco com restore testado · código no GitHub com branch protection · runbooks + on-call.

---

## Como atacar (ordem recomendada)

1. **F0 inteira** antes de qualquer usuário real (1 semana, alto impacto/baixo custo).
2. **F1** em paralelo por workstream (arquitetura + observabilidade primeiro, qualidade junto).
3. **Soft launch** ao fim da F1 com poucos usuários reais; usar os dados pra priorizar F2.
4. **F2** guiada pelo que o load test e o custo real mostrarem.
5. **F3** contínua, intercalando moat de produto (L) com maturidade operacional (J/K).

> Regra de ouro: **nenhuma feature nova de produto entra enquanto F0 não fecha.**
> Fundação primeiro; o disruptivo se constrói sobre ela, nunca no lugar dela.
