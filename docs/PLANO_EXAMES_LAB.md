# Buscar exames no portal do laboratório — desenho

> Status: **construído, NÃO publicado** (decisão do fundador em 01/09/2026: "tente criar,
> não publica ainda"). Este documento é o desenho inteiro, incluindo o que foi decidido
> NÃO fazer e por quê. Leia antes de ligar em produção.

---

## 1. O que é

A pessoa fotografa o protocolo do exame — aquele papel do laboratório com **login e senha**
para ver o resultado online. A Xarlote lê a foto (já faz), pede autorização explícita, entra
no portal do laboratório com o acesso da pessoa, baixa os PDFs dos resultados, lê cada um,
guarda no prontuário dela e conta o que encontrou.

Caso que motivou: **Glauber, 31/08/2026** — mandou o acesso do Instituto Goiano de Oncologia
e Hematologia e pediu lembrete para "pegar o resultado dia 02". Hoje a Xarlote guarda o
acesso e lembra; com isto, ela busca o resultado sozinha.

## 2. O que este desenho recusa fazer — e não é negociável

Estas quatro coisas não são "fase 2". São a fronteira do produto.

| recusa | por quê |
|---|---|
| **Resolver ou contornar CAPTCHA** | É a forma que o site tem de dizer "não quero robô". Contornar é hostil ao laboratório e ao paciente, e é o tipo de coisa que quebra reputação de número, de domínio e de empresa. Ao detectar, a Xarlote **para e diz a verdade**: "esse site pede verificação humana, não consigo entrar — me manda o PDF". |
| **Passar por 2FA / código por SMS** | O código chega no celular DA PESSOA. Pedir que ela repasse para um robô é treinar o paciente a fazer exatamente o que golpista pede. Ao detectar, **para** e orienta o caminho manual. |
| **Disfarçar-se de navegador humano** (stealth, fingerprint falso, user-agent de Chrome) | O User-Agent diz quem somos: `Xarlote/1.0 (+https://xarlote.ai)`. Se o portal bloquear robô declarado, bloqueou — não escondemos. |
| **Tentar de novo depois de senha errada** | Segunda tentativa com senha errada é caminho de bloqueio de conta. Uma só, e a pessoa é avisada. |

## 3. Credencial: a decisão central

**Por padrão a senha é usada UMA vez e esquecida.** Ela existe:

1. no texto da mensagem da pessoa (já existe hoje — a foto e a transcrição ficam no
   histórico, como qualquer mensagem);
2. **cifrada** (AES-256-GCM, chave em `LAB_VAULT_KEY`) dentro do job na fila, pelos
   segundos que o job leva. Redis não cifra em repouso, então o payload vai cifrado;
3. em memória no worker, durante o login.

E em **nenhum outro lugar**:

- `assistant_tasks.tool_input` recebe `senha: "[redigido]"` — `recordTaskStart` grava os
  args crus do modelo, e sem isto a senha iria para o banco em texto puro;
- nenhum log em nível ≥ debug recebe login, senha nem URL com token;
- o job é removido da fila ao terminar (`removeOnComplete: true`, `removeOnFail: true`) —
  diferente das outras filas, aqui o payload é o segredo.

**Guardar o acesso para buscar de novo** ("me avisa quando sair o próximo") é um opt-in
separado, que **não está construído**. Quando for, a decisão está tomada: cifrado com a
mesma chave, uma linha por (pessoa, laboratório), revogável pela pessoa, listado — sem o
valor — na exportação LGPD, e apagado no forget-me.

## 4. Consentimento

A autorização é **da pessoa, na conversa, em palavras dela**, e o servidor confere:

1. A Xarlote lê a foto e pergunta, sem chamar tool nenhuma: *"Quer que eu entre no site do
   [laboratório] com esse acesso e busque seus resultados? Vou usar o login uma vez e não
   guardo a senha. Responde **sim** pra autorizar."*
2. A pessoa responde. **No turno seguinte**, o modelo chama `fetch_lab_results`.
3. O handler pega a **mensagem de entrada deste turno** (`ctx.inboundMsg`) e exige que ela
   seja uma afirmação inequívoca (`sim`, `pode`, `autorizo`, `ok`, `claro`, `vai`…). Se não
   for, **recusa**: *"NADA FOI FEITO: a pessoa ainda não autorizou explicitamente."*
4. Autorizado, grava em `consent_events` (`policy_version: 'lab-fetch-1.0'`,
   `evidence_message_id` = a mensagem dela, `evidence_text` = o que ela escreveu) **antes**
   de enfileirar.

É o mesmo padrão do gate de consentimento de consulta: a prova é a fala da pessoa, não a
afirmação do modelo de que ela concordou.

## 5. O fluxo

```
foto do protocolo ─► visão lê: laboratório, URL (se impressa), login, senha, protocolo
                  ─► Xarlote pergunta e ESPERA
pessoa: "sim"     ─► tool fetch_lab_results {laboratorio, portal_url?, login, senha, protocolo?}
                  ─► handler: gate de consentimento → consent_events → redige tool_input
                  ─► cifra credenciais → enfileira LAB_FETCH → responde "tô entrando, te aviso"
worker            ─► decifra → escolhe adapter (registry) → Chromium limpo, contexto novo
                  ─► login ─► [captcha? 2fa? senha errada? → PARA, avisa]
                  ─► lista resultados ─► baixa cada PDF (só PDF; ignora o resto)
                  ─► por PDF: extrairTextoDePdf → LLM extrai {tipo, título, data, achados}
                              → user_exam_results (source: 'portal') + app_media (kind: 'pdf')
                  ─► lab_fetches: status final + contagens (sem PII)
                  ─► audit_log ─► mensagem à pessoa: o que achou, ou por que parou
                  ─► fecha o navegador; credencial sai de escopo
```

## 6. Adapters — um por laboratório, e um genérico honesto

Igual ao registry das redes de farmácia (`pharmacy-platforms/registry.ts`):

```ts
interface LabAdapter {
  id: string;                          // 'instituto-goiano-onco'
  nome: string;                        // como aparece no protocolo
  casa(alvo: { url?: string; nome?: string }): boolean;
  login(page, creds): Promise<LoginResultado>;
  listarResultados(page): Promise<ResultadoRemoto[]>;
  baixar(page, item): Promise<Buffer>;
}
```

**`generico`** é o único que existe hoje. Ele:
- acha o formulário pelo `input[type=password]` e o campo de usuário mais próximo;
- submete **uma vez**;
- considera login falho se continuar na mesma página com campo de senha visível, ou se
  aparecer texto de erro (`inválid`, `incorret`, `não encontrado`);
- lista links/botões cujo destino ou texto indica PDF/resultado/laudo;
- se não tiver certeza em qualquer passo, devolve `portal_desconhecido` — **não chuta**.

Adapter específico só nasce depois de ver o portal real. O Instituto Goiano é o primeiro
candidato; **não foi escrito porque não há como testar sem um acesso real**, e adapter
escrito no escuro é adapter que quebra em silêncio.

## 7. Cada jeito de parar tem nome, e uma frase honesta

| código | quando | o que a Xarlote diz |
|---|---|---|
| `bloqueado_captcha` | iframe/widget de reCAPTCHA, hCaptcha, Turnstile, ou "captcha" no DOM | "esse site pede verificação humana, e isso eu não faço — me manda o PDF que eu leio na hora" |
| `bloqueado_2fa` | pedido de código/token/SMS depois do login | "o site pede um código no seu celular; não é seguro repassar isso pra mim — me manda o PDF" |
| `credenciais_invalidas` | login falhou | "o site não aceitou esse login. Confere no papel? Não vou tentar de novo pra não bloquear sua conta" |
| `portal_desconhecido` | adapter não achou formulário/resultados com confiança | "ainda não conheço o site desse laboratório. Me manda o PDF que eu guardo igual" |
| `sem_resultados` | logou, nada para baixar | "entrei, mas ainda não tem resultado liberado. Quer que eu tente de novo amanhã?" |
| `download_falhou` | link não devolveu PDF | "achei o resultado mas não consegui baixar o arquivo" |
| `timeout` | > 60 s | "o site demorou demais" |
| `erro_interno` | qualquer outra coisa | "deu um problema do meu lado" |

Todas terminam oferecendo o caminho que já funciona: **mandar o PDF**.

## 8. Higiene do navegador

- `chromium` headless, **contexto novo por job**, sem perfil persistente, fechado no `finally`
- User-Agent honesto (seção 2)
- timeouts: navegação 20 s, job inteiro 60 s
- `concurrency: 1` no worker (um Chromium é pesado; dois no mesmo container do Railway
  derrubam o healthcheck)
- **sem screenshot** — teria PHI. Erros viram código + mensagem curta, nunca imagem
- downloads só de `application/pdf`; qualquer outra coisa é descartada
- rate limit: 3 buscas por pessoa por dia

## 9. Deploy — o que muda no container

Playwright precisa do binário do Chromium e das libs de sistema. **Feito (03/09/2026)** sem
tocar no `nixpacks.toml` compartilhado com a API: a variável de build **`NIXPACKS_PKGS=chromium`
só no service `worker`** instala o Chromium do Nix (fica no PATH como `chromium`, em
`/root/.nix-profile/bin/chromium`), e `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` nos dois services
evita o download de 150 MB do Playwright em cada build. `resolverChromium()` acha o binário
(env explícita → PATH → bundled).

**Prontidão é provada, não declarada.** No start, o worker abre e fecha um Chromium
(`chromiumFunciona`); se conseguir, grava `lab-fetch:ready` no Redis (TTL 120 s, renovada a
cada 60 s) e só então escuta a fila. A API só oferece `fetch_lab_results` ao modelo quando essa
chave existe (`labFetchPronto`), e o `/health` expõe `lab_fetch_enabled` e `lab_fetch_ready`
separados — "enabled sem ready" nunca vira promessa a paciente. A sonda roda mesmo com a
flag desligada e vai ao stdout (`[lab] sonda: …`) para ser conferível pelo `railway logs`,
porque `writeLog` grava só no banco.

## 10. LGPD

- `lab_fetches` (status, contagens, sem credencial) entra no `PLANO_LGPD` como `apagar`
- os PDFs vão para o bucket privado `xarlote-app-media` como `kind: 'pdf'` (a migration
  0032 amplia o `check`) — já cobertos pelo forget-me
- `consent_events` guarda a autorização; a revogação é pedir "não busque mais"
- a política de privacidade precisa de um parágrafo sobre isto **antes de ligar**

## 11. O que ainda NÃO existe

- adapter de laboratório real (precisa de acesso real para testar) — o genérico é o único
- "lembrar acesso" (opt-in cifrado)
- "avisa quando sair" (recheck agendado)
- parágrafo na política de privacidade (`xarlote.com.br/privacidade`) — **fazer antes do
  primeiro uso com paciente que não seja o fundador**

## 12. Estado

**Ligada em produção em 03/09/2026** (migration 0032 aplicada; flag nas duas services;
`/health` → `lab_fetch_ready: true`). Nenhum paciente real passou por ela ainda.

## O primeiro paciente real (Ciro, 16–18/09/2026) — o que a frente não previu

| Sintoma | Decisão que o permitiu | O que mudou (21/09, `7d8d6db`) |
|---|---|---|
| Laudo da Dasa (12 pág) e da RM do IGR (1 pág) → "não consegui ler o texto", duas vezes | Leitor de PDF escrito à mão, sem biblioteca, cobrindo "fonte de 1 byte"; laudo moderno é Type0/Identity-H + /ToUnicode | `pdf-leitor.ts`: pdf.js lê; as recusas honestas (protegido/escaneado/ilegível) continuam com a mesma régua; o leitor antigo é fallback. Provado nos dois PDFs reais. |
| "Estou entrando no site do CDI no dia 21/09" e "Ainda não conheço o site do CDI" no mesmo segundo | A busca é assíncrona; o modelo escreveu o desfecho antes de existir | O handler fala o único fato ("tô tentando agora, já te digo"), voz única; observação proíbe data/promessa/lembrete de "buscar depois". |
| Lembrete criado pra 21/09 17:30 com "vou entrar no site… já volto com novidades" | Sanitizador do body só conhecia placeholder | Oração que promete ação da Xarlote cai (criação e disparo) — `prometeAcaoDaXarlote`. |
| Protocolo de retirada gravado 2× como "resultado de RM Crânio" | `save_exam_result` aceitava qualquer coisa com título | `pareceProtocoloDeRetirada`: zero achado clínico + fala de retirada/prazo/site → recusa com instrução honesta. |
| Senha do portal em claro em `assistant_tasks.tool_output` | Só a entrada era redigida | Saída redigida também. Linha de 16/09 precisa de reparo manual. |

Continua verdade: só existe o adapter genérico; CDI e IGR (Dasa) devolvem `portal_desconhecido`. O que o paciente mandar em PDF agora é lido de verdade.

## v2 — 21/09/2026: tarefa futura, prova antes da promessa, ingestão única (caso Ciro)

O pedido do fundador depois do caso Ciro: *"não era pra executar, era pra AGENDAR a execução;
no dia, ela entra sozinha, traz os exames e guarda no perfil; e se ele mandar o exame, ela
extrai tudo e guarda, documento e dados, formando o histórico"*. Sem remendo. O desenho:

### 1. Tarefa futura é entidade (`lab_fetches` + `scheduled_for`)
- `fetch_lab_results` ganha `quando` (ISO com fuso). O servidor decide (`interpretarQuando`):
  ≤10 min / passou há <12h → agora; futuro até 60 dias → **agendada**; senão recusa com instrução.
- Linha `lab_fetches` com status `reconhecendo` → `agendada` → (despachante, 60 s) `na_fila`
  → `rodando` → `concluida | parada | falhou`; `cancelada` a pedido (`cancel_lab_fetch`).
- **O acesso fica cifrado NA LINHA** (`credenciais_cifradas`, AES-256-GCM, chave só no
  ambiente) só enquanto pendente, e é **apagado em todo desfecho**. A 0032 dizia "sem
  credencial no Postgres" porque só existia busca imediata; a promessa que fica de pé é
  "nunca em claro, nunca depois da busca" — e a pergunta de autorização diz isso à pessoa.
- Campos que o portal exige (`camposObrigatorios` do adapter, ou descobertos no
  reconhecimento) contra o que temos (perfil `birth_date`, `document_cpf`, o que ela disse):
  falta → o servidor manda perguntar ANTES de agendar (`faltou_dado`); dado dito uma vez vai
  pro perfil (auditado).

### 2. Prova antes da promessa (reconhecimento)
Ao agendar, o worker abre o portal SEM digitar nada: aceita cookies, reconhece o formulário e
os campos. Só então a pessoa ouve *"Combinado: 21/09 a partir das 17h30 eu entro no site do
CDI…"*. Se o portal não é reconhecido: *"ainda não conheço o site… no dia eu te lembro e você
me manda o PDF"* + um lembrete honesto criado pelo servidor (nunca "vou entrar"). O modelo do
turno diz UMA coisa ("deixa eu conferir se consigo") e o handler fala com voz única; a
família `busca_no_portal` do claim-guard derruba "estou entrando no site" sem a tool.

### 3. Adapter de verdade: Synapse EIS/RIS (CDI Goiânia)
Olhado ao vivo em 21/09: `novo.cdig.com.br/resultado/` (Nuxt), banner de cookies, Protocolo +
Senha + **Data de Nascimento** (`input[type=date]`), sem CAPTCHA. `casa()` pela URL/nome,
`detecta()` pelo título da página (a URL do protocolo era a home). A listagem pós-login usa a
heurística do genérico + download por clique (SPA); o que vier de diferente para com a frase
honesta de sempre. O genérico ganhou `reconhecer` e o campo de nascimento.

### 4. Ingestão única (`apps/api/src/handlers/ingestao-de-exame.ts`)
Todo documento — PDF do portal, PDF do WhatsApp, foto — passa por AQUI antes do modelo:
arquivo no bucket privado + `app_media`; texto (pdf.js) ou leitura estruturada da foto (UMA
chamada de visão: classificação + descrição objetiva + marcadores); classificação
determinística (`classificarTextoDeDocumento`: laudo · protocolo · receita · pedido · outro);
extração com temperatura 0 e **verificação de cada valor contra o texto**
(`verificarAchadosNoTexto` — o que não está no laudo não entra); `user_exam_results` ligado ao
arquivo (`media_id`). O modelo recebe o FATO (`blocoDeIngestaoParaModelo`) e comenta; a guarda
anti-mentira vê a ingestão como `save_exam_result` executado. Protocolo nunca vira resultado.

### 5. Discutir depois
O prompt lista os últimos 6 exames (id, título, data, marcadores, amostra) e as buscas
pendentes; `get_exam_result` devolve um exame inteiro. Teste cego (glm-5.2 e gpt-4.1-mini):
A protocolo→pede agendar 3/3 · B "sim"→`quando`=21/09 3/3 · C laudo guardado→interpreta sem
re-gravar 3/3 · D protocolo+"me envia"→não diz "guardei" 3/3 — nos dois modelos.

### Dependência
Migration `0033_lab_fetch_agendada.sql` (colunas + status + índices + `media_id`). Sem ela o
código novo não sobe: o insert da busca falha (graciosamente) e o exame ingerido não grava.

### Provas em produção (21/09/2026, 11:00–11:20 BRT, no usuário do fundador)
1. **Busca agendada, ponta a ponta**: linha `agendada` (protocolo falso 0000000) → despachante
   enfileirou em ≤60 s → worker abriu `cdig.com.br`, detectou Synapse pela página, foi pra
   `novo.cdig.com.br/resultado/`, aceitou cookies, preencheu protocolo/senha/nascimento,
   submeteu UMA vez → `credenciais_invalidas` → acesso apagado → duas mensagens no WhatsApp
   ("Como combinado, tô entrando…" / "O site do CDI G não aceitou esse login…").
2. **Reconhecimento antes da promessa**: linha `reconhecendo` (agendada pra +2 dias) →
   `agendada`, adapter `synapse-eis`, campos `login+senha+nascimento`, mensagem "Combinado:
   23/09 a partir das 11h13 eu entro no site do CDI G…" — sem digitar nada. Cancelada depois.
3. **Ingestão de PDF real** (laudo Dasa de 12 páginas): 25.130 chars lidos, `laudo`, 29
   marcadores extraídos e **29 conferidos no texto**, `user_exam_results` + `app_media` +
   card + audit. Linhas de teste apagadas.
4. **O que quebrou no caminho e foi consertado**: o Chromium do Nix no container **não tinha
   nenhuma fonte** (`TextRunHarfBuzz … glyph_count: 0`) e a aba morria em qualquer página com
   texto de verdade — `NIXPACKS_PKGS=chromium liberation_ttf dejavu_fonts` + `~/.fonts`
   ligado na subida + prontidão exige fonte. O e2e com portal falso nunca viu isso.
