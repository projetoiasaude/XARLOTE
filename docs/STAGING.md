# Staging — testar novas funções sem tocar produção

Objetivo: criar e testar features com segurança, **sem risco algum pra produção**
(nada de dados reais, nada de WhatsApp de verdade).

Há duas camadas de proteção, e você pode usar as duas:

1. **Kill-switches em produção** (governança do dia a dia) — no dashboard
   `/prompts` há interruptores por fluxo (Lembretes, Follow-ups, Disparo a
   farmácias, Disparo a clínicas). Uma função nova pode ir pra produção
   **desligada** e você liga só quando quiser testar, com um clique. Freio de
   emergência instantâneo, sem redeploy.

2. **Ambiente de staging isolado** (este guia) — uma cópia local da Xarlote com
   **banco separado** e **WhatsApp em modo simulador**. Impossível tocar produção.

---

## Trava de segurança (por que é impossível quebrar produção)

Quando `APP_ENV=staging`, a API **se recusa a subir** se:
- `SUPABASE_URL` apontar pro banco de produção (`niqmxiybiwrfkvdfojcq`), ou
- `WHATSAPP_MODE` não for `simulator`.

Ver `apps/api/src/server.ts` (bloco "TRAVA DE STAGING"). Produção **nunca** seta
`APP_ENV=staging`, então essa checagem jamais afeta o ambiente real.

Além disso, em `simulator` o `sendOutbound` curto-circuita — **nenhuma mensagem
sai pro WhatsApp**; tudo fica visível no simulador do dashboard.

---

## Setup local (recomendado — grátis, isolado)

Pré-requisito: **Docker** (pro Supabase local) e **Redis** (docker ou `brew install redis`).

```bash
# 1. Sobe um Supabase LOCAL (Postgres + Auth + Storage + Studio) — isolado de prod.
pnpm staging:db          # = supabase start; imprime API URL + service_role + anon keys

# 2. Aplica todas as migrations no banco local.
pnpm staging:db:reset    # = supabase db reset (recria o schema do zero)

# 3. Copia o template e preenche com o que o `supabase start` imprimiu.
cp .env.staging.example .env.staging
#    → SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / SUPABASE_ANON_KEY (do passo 1)
#    → OPENROUTER_API_KEY (pode ser a mesma; é leitura)

# 4. Sobe a Xarlote de staging (API + worker + web), já em simulador.
pnpm staging
#    → API   http://localhost:3001
#    → Web   http://localhost:3002  (dashboard + /simulator)
```

Teste os fluxos em `http://localhost:3002/simulator` — você conversa como o
usuário e como a farmácia/clínica, tudo contra o banco local. Zero efeito em prod.

Parar o banco local quando terminar: `pnpm staging:db:stop`.

---

## Fluxo de trabalho (feature nova → produção)

```
1. git checkout -b feat/minha-funcao          # branch a partir de main
2. desenvolve + `pnpm staging` pra testar no simulador (banco local)
3. `pnpm typecheck && pnpm test`               # tem que passar
4. (opcional) sobe a feature em produção DESLIGADA por trás de um kill-switch
5. PR → merge em main → deploy (railway up) → liga o switch no /prompts e observa
6. deu ruim? desliga o switch (1 clique) — sem redeploy, sem incidente
```

Promoção é por git: `main` é produção. Nada em staging é promovido
automaticamente — você decide o que sobe.

---

## Staging HOSPEDADO (opcional, custa dinheiro)

Se um dia quiser um staging acessível pela equipe (não só local):

- **Banco**: um branch do Supabase (~US$ 9,68/mês) **ou** um 2º projeto Supabase
  free. Isolado de prod por construção.
- **App**: um *environment* "staging" no Railway (2 services + Redis) apontando
  pro banco acima, com `APP_ENV=staging` + `WHATSAPP_MODE=simulator`.
- **Web**: um projeto/branch no Vercel apontando pra API de staging.

Não montei o hospedado ainda porque envolve custo recorrente — me avise que eu
provisiono. O staging LOCAL acima já cobre 100% do "criar e testar sem afetar
produção".

---

## Checklist de segurança (sempre que subir staging)

- [ ] `.env.staging` existe e **não** tem `SUPABASE_URL` de produção.
- [ ] `WHATSAPP_MODE=simulator` (a trava garante, mas confira).
- [ ] `REDIS_URL` **não** é o Redis de produção.
- [ ] `.env.staging` **nunca** é commitado (já está no `.gitignore`).
