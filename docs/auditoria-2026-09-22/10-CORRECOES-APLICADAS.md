# Correções dos 8 P0 — o que mudou, como publicar, como reverter

> **Estado (24/09, 16:10 BRT):** ✅ **push** (`origin/fix/auditoria-set`, 90 commits) · ✅ **web** na Vercel (`/app` → página de encerramento; `/s/`, `/login`, `/privacidade`, `/suporte` públicos; dashboard exige login) · ✅ **API** no Railway (19:06Z — rota legada `POST /app/overview` 404, antes 401; log "Rotas legadas do app: OFF") · ✅ **worker** (19:09Z, 17 workers ON, boot limpo) · ⏳ **migration 0034 NÃO aplicada**: o conector do Supabase desta sessão está logado na organização da Criate e não enxerga o projeto da Xarlote — o fundador aplica pelo SQL Editor (ou reconecta o conector) · ✅ **OTA do app** (P0-7 no celular) publicado por volta das 23:40Z no canal `preview` (grupo `24e9a09d`, confirmado no `eas update:list`) — runtime `c36997c9…` conferido igual ao do APK antes de publicar (Android update `01a0d5ca`; o ritual: abrir, esperar ~20 s, fechar pela lista de recentes, abrir de novo; o rodapé do Perfil mostra `01a0d5ca`).
> Junto foi publicado o **modo "entrega na hora"** da farmácia (`a5e1c95` + `6a84ed2` + `2498f63`) — fora do escopo dos P0; ver o log de 24/09 em `PROJECT_STATE.md`.
> Obs. de deploy: a CLI v60 da Vercel respondeu "Not authorized" no `--prod`; a v59.25.4 (`npx vercel@59.25.4 --prod --yes`) publicou normalmente. O `railway.toml` está com aviso de depreciação (funciona até 01/12/2026 — migrar pra `.railway/railway.ts`).
> **Verificação:** `pnpm -r typecheck` limpo em 9/9 workspaces · `CI=true pnpm test` **2.356 testes em 129 arquivos** (antes: 2.191 em 122) · teste de fumaça do processo isolado (sem `.env`, sem Redis, sem Supabase) com boot, rota legada 404 e shutdown limpo na ordem certa.
> Diagnóstico de cada defeito: [`00-CONSOLIDADO.md`](00-CONSOLIDADO.md) §3.

---

## Revisão adversarial (independente, depois de pronto)

Um revisor sênior que **não** escreveu o código passou o diff inteiro. Achou 3 defeitos bloqueantes e 8 pontos menores — **todos corrigidos**, com teste para cada um. Os três que não podiam chegar a paciente:

1. **A idiomática desligava a detecção de emergência da mensagem inteira.** *"tenho vontade de sumir de vez, tô morrendo de vergonha do que fiz"* devolvia `null`: o "de vergonha" de outra oração cancelava a ideação. A regra passou a ser gramatical — o complemento é descontado só quando vem **colado** ao verbo ("morrer **de vergonha**"), não em qualquer lugar da frase.
2. **Typo `preiguiça`** fazia *"quero morrer de preguiça hoje"* virar ideação suicida — botões do SAMU numa frase corriqueira.
3. **O filtro de máscara comia o prompt da Xarlote.** Descartava qualquer texto com `•`, e bullet é justamente como se escreve um prompt em tópicos: o fundador salvava, a tela dizia "salvo", nada mudava. Agora o filtro vale só para as chaves de API, ancorado no começo.

E o mais silencioso deles: o dispatcher de lembretes carimbava `delivered` **otimista** logo após enfileirar — e a conferência de duplicata da fila lê exatamente essa coluna como prova. Ou seja, a correção do P0-5 ficava sem efeito justamente para lembrete de remédio. O dispatcher agora carimba `queued`; só a fila escreve `delivered`/`failed`.

Outros corrigidos: janela de 24h do contato consultada sem a instância (podia medir a conversa errada e voltar "aberta" → texto que a Meta recusa com a Xarlote dizendo que avisou); arquivos do paciente sobrevivendo à retentativa do apagamento (agora saem **antes** das linhas que guardam o caminho); frase do escalonamento que dizia "tentei avisar" sem ter a quem; turno do **fornecedor** também drenado no shutdown; drenagem movida para depois do flush de fornecedor (senão os turnos que o flush dispara morriam); formas legítimas de pedir apagamento que o guard não reconhecia ("apague meus dados", "quero deletar tudo que você sabe sobre mim", "sim, confirmo apagar").

---

## Resumo por P0

| # | Defeito | O que passou a valer | Onde |
|---|---|---|---|
| 1 | 84 commits de produção só neste Mac | CI roda em **todo branch** (era só `main`); `scripts/deploy.sh` recusa árvore suja, roda typecheck+teste e avisa se o HEAD não está em nenhum remoto | `.github/workflows/*.yml`, `scripts/deploy.sh` |
| 2 | Prontuário legível por telefone + anon key | Rotas legadas do app **desligadas em produção**; `/app` do web fechado; fallback pro token de admin removido do bundle; migration que derruba as policies `anon_read_*` e fecha o bucket | `server.ts`, `apps/web/middleware.ts`, `app-encerrado/page.tsx`, `ApiAuth.tsx`, `0034_*.sql` |
| 3 | "confirmo apagar" por substring; apagamento quebrado no meio | Guard puro com âncora + pedido pendente de 15 min (Redis); FK solta antes de apagar mensagens; fio de clínica conta os pacientes certos; storage que falha vira sobra; retentativa recupera o telefone do job; job `failed` volta a aceitar pedido novo; export LGPD com as colunas certas | `esquecimento.ts`, `esquecimento-pendente.ts`, `forget-me.ts`, `lgpd.queue.ts`, `app-export.ts` |
| 4 | Contato de emergência nunca avisado, e a Xarlote dizia que avisou; suicídio/overdose só pelo modelo | Aviso pela **fila com prioridade 1**, janela de 24h e template HSM; sem template a Xarlote **diz a verdade** e põe o 192 na frente; botões dentro do limite de 20 caracteres; update de `red_flag_pending` deixa de falhar em silêncio; **preempção determinística passa a reconhecer ideação suicida, automutilação e overdose** (com as figuras de linguagem do português descontadas) e a categoria certa vai pro registro clínico; `EMERGENCY_KEYWORDS` (lista morta que parecia proteção) removida | `red-flag-handler.ts`, `template-registry.ts`, `emergencia-determinista.ts`, `inbound-user.ts` |
| 5 | 5xx do zpro = mensagem perdida em silêncio; Redis piscando = duplicata | Status ancorado (4xx real ≠ "400" ecoado no corpo); **um** resgate por mensagem no erro ambíguo; `duplicate` sem prova de entrega vira falha visível; `jobId` no add; produtor sem offline-queue (mata o `add` fantasma) | `outbound.queue.ts`, `queue-config.ts` |
| 6 | Deploy matava turno em voo; paciente mudo | Turnos registrados e **drenados no shutdown**; SSE fechado antes do `app.close()`; webhook devolve 503 durante o shutdown (antes de registrar idempotência); frase honesta quando o turno explode; `insertMessage` idempotente; rede de segurança de `unhandledRejection`/`uncaughtException` | `lifecycle.ts`, `server.ts`, `stream.ts`, `webhook.*.ts`, `inbound-user.ts`, `queries.ts` |
| 7 | Cuidador deslogado; ação escrevia no prontuário errado | Ação de lembrete honra `?subject=` com capacidade `agir`; 403 deixa de ser tratado como sessão morta; ações em 1ª pessoa bloqueadas com frase honesta em modo cuidador | `routes/app/reminders.ts`, `apps/mobile/**` |
| 8 | Toggle zerava a config; worker nunca via o dashboard | Patch ignora `undefined` e máscara; config compartilhada api↔worker por **Redis** com snapshot em memória (e `loadPrompts()` deixa de tocar o disco); chaves mascaradas no GET; Salvar manda só o diff; interruptor mestre pede confirmação | `config/prompts.ts`, `routes/admin.ts`, `prompts/page.tsx` |

---

## Ordem de publicação (importa)

1. **`git push -u origin fix/auditoria-set`** — antes de qualquer outra coisa. O CI agora roda no branch e é o primeiro sinal independente de que está tudo de pé.
2. **Deploy do web (Vercel)** e **deploy da API+worker** (`./scripts/deploy.sh ambos`). Os dois fecham o `/app` do navegador.
3. **Só então a migration `0034`.** Ela tira o acesso anônimo que o `/app` do web usava: aplicar antes dos deploys deixaria a tela quebrada em vez de fechada.
4. **Template `contato_emergencia` na Meta** (categoria Utilidade, pt_BR, 2 variáveis — corpo exato em `template-registry.ts`). **Não é mais caminho crítico**: enquanto ele não existe, o aviso sai pelo `lembrete_compromisso` (ver abaixo). Quando for aprovado, basta setar `ZPRO_TEMPLATE_EMERGENCIA` e ele passa a ter precedência sozinho.

### A ponte do aviso de emergência (decisão de 22/09)

Fora da janela de 24h o aviso ao contato precisa de template, e o dedicado ainda não existe. O coringa `contato_geral` foi **descartado** para este caso: está aprovado na perna do AGENTE (outro número) e o corpo é B2B — *"preciso falar com vocês… fico no aguardo, obrigada"* —, que um filho lendo às 2h sobre a mãe arquiva como mensagem comercial.

A ponte é o **`lembrete_compromisso`**, o HSM de reengajamento: já aprovado **no próprio número da Xarlote**, corpo humano, e os dois slots são exatamente "nome" + "motivo em uma frase". O contato recebe:

> Oii, **João**! Aqui é a Xarlote,
>
> Maria pode estar precisando de ajuda agora e colocou você como contato de emergência. Por favor, fale com ele(a) o quanto antes. Se houver risco imediato, ligue 192 (SAMU).
>
> Tô por aqui com você pro que precisar, é só me responder nesta conversa. 💜

O fecho ajuda: se o contato responder, a janela de 24h abre e a Xarlote passa a falar com ele direto. A cadeia é `ZPRO_TEMPLATE_EMERGENCIA` → `lembrete_compromisso` (exige `ZPRO_TEMPLATE_REENGAGE_APPROVED=true`) → mensagem honesta com o 192. O **motivo é o mesmo texto** nos dois caminhos (teste garante), e **nenhum** leva categoria clínica pro terceiro. O log registra qual saiu.

⚠️ Confirme no gerenciador da Meta que o `lembrete_compromisso` está como **Utilidade**: template de Marketing pode ser descartado em silêncio por limite/opt-out do destinatário — o pior modo de falha possível aqui.

### Variáveis novas (todas opcionais, com default seguro)

| Variável | Onde | Default | Para quê |
|---|---|---|---|
| `LEGACY_APP_ROUTES` | API | ausente = **off** em produção | Reabre as rotas legadas do app (auth por telefone) em 1 minuto, se algum paciente ainda depender delas |
| `NEXT_PUBLIC_APP_WEB_ENABLED` | Vercel | ausente = **off** | Reabre o `/app` do navegador (exige Redeploy — é embutida no build) |
| `ZPRO_TEMPLATE_EMERGENCIA` | API | ausente | Nome do HSM aprovado do contato de emergência |
| `TURN_DRAIN_MS` | API | 12000 | Quanto o shutdown espera pelos turnos em voo |
| `PROMPTS_SYNC_MS` | API + worker | 5000 | Intervalo do sync de config entre os serviços |

---

## Como verificar depois de publicar

```bash
curl -s https://<api>/health | jq '.uptime_s'                 # reiniciou
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://<api>/app/overview \
  -H 'content-type: application/json' -d '{"phone":"+5562999999999"}'   # → 404 (legado fora)
curl -s -o /dev/null -w '%{http_code}\n' https://xarlote.com.br/app     # → 200 na página de aviso
```

No dashboard `/prompts`: desligue um kill-switch de fluxo, salve o sufixo do prompt e confira que o switch **continua desligado**; o campo da chave deve mostrar `••••` e não a chave. No `railway logs -s worker`, procure a linha do sync de config.

Depois da migration:
```sql
select count(*) from pg_policies where schemaname='public' and roles @> '{anon}';  -- 0
select id, public from storage.buckets where id = 'xarlote-media';                 -- false
```

---

## Riscos assumidos, escritos

- **Emergência agora depende do worker vivo.** O aviso passou a ir pela fila (rate limit, template, carimbo de entrega, regra #5). Antes era envio direto do processo da API. Como as mensagens ao paciente no mesmo fluxo já iam pela fila, um worker morto já derrubava o fluxo inteiro — mas isso reforça a prioridade do heartbeat do worker (P1-18 da auditoria).
- **Um resgate por mensagem** no erro ambíguo (5xx/timeout): o pior caso é o paciente receber 2× uma mensagem que o zpro entregou e depois respondeu 5xx. Escolhido porque perder lembrete de remédio é pior que repetir. Desaparece quando o zpro confirmar que deduplica por `externalKey`.
- **Redis fora ⇒ ninguém apaga a conta.** A marca de "pediu esquecimento" vive no Redis; sem ela a Xarlote pergunta de novo em vez de apagar. Erro do lado seguro, e vai pro log como `error`.
- **Migration 0034 quebra o realtime anônimo** do simulador do dashboard (que já responde 404 em produção) e da tela de atividade do `/app` web (que está sendo fechada). Nenhum paciente perde função.
- **Config vive no Redis.** Se o Redis for zerado, os overrides do dashboard voltam pro arquivo local/env — nunca pior que hoje (hoje cada deploy já zerava), e some quando existir uma tabela `runtime_config`.
