# Conta Cuidador — uma Xarlote que cuida de mais de uma pessoa

> Desenho técnico. Escrito em 25/08/2026 a partir de uma varredura completa do código.
> **Status em 26/08: F1 a F5 ENTREGUES. Migration 0030 APLICADA. `verify-care-link.ts` 38/38
> verde contra o banco real.** Commits `8cb7533` · `3bc9980` · `abacf9a` · `0e4a419`.
> O que mudou em relação ao desenho original está anotado em ✅/⚠️ nas seções abaixo.

## 1. O problema, em uma frase

Hoje **quem fala e de quem é o dado são a mesma pessoa**, por construção. Um pai que quer
acompanhar o filho, ou um filho que quer cuidar da mãe idosa, não tem onde existir.

Isso não é um buraco acidental: o plano estratégico (`docs/VISAO_JARVIS_SAUDE.md`, aposta ④)
já identificou a Conta Cuidador como *"provavelmente o caminho 'bilhões' mais plausível"* —
quem paga (o filho de 35-50 anos) não é quem usa (o idoso crônico), o LTV é o maior do
Brasil e um cuidador traz 2-4 pacientes junto. O mesmo documento recomenda **MVP enxuto
antes do schema multi-titular completo**, e é essa a régua deste plano.

## 2. Onde a suposição "1 telefone = 1 paciente" está cravada

Levantamento feito no código, não presumido:

| Camada | Onde | Forma |
|---|---|---|
| Identidade | `inbound-user.ts:382` | `findUserByPhone(phoneE164)` — única resolução do sistema |
| Prompt | `xarlote.system.ts:3` | `XarloteContext.user` é singular; não há campo de alvo nem de relação |
| Perfil | `packages/db/src/user360.ts:83` | `queryUser360(userId)` / RPC `query_user_360(p_user_id)` |
| Tools | `xarlote-tools.ts` (30 tools) | **Nenhum schema aceita destinatário** |
| Execução | `tool-executor.ts:87`, `tool-executor-v2.ts:32` | `userId: string` escalar; todo write é `.eq('user_id', ctx.userId)` |
| Memória | `0001_memory_pgvector.sql` | `match_user_memory(p_user_id, …)` particiona por usuário |
| App | `middleware/patient-auth.ts` | JWT `sub` = userId; nenhuma rota aceita outro alvo |
| Saída | `inbound-user.ts:2319` | responde sempre ao número que escreveu |

**E uma armadilha específica:** `inbound-user.ts:1421` (`PAST_OR_OTHER_RE`) exclui
`minha mãe|meu pai|minha avó|meu filho` da detecção de emergência. Está **certo hoje** —
sem vínculo, "minha mãe está com dor no peito" não é emergência do titular. No minuto em
que o vínculo existir, essa mesma linha vira o oposto: silêncio sobre um infarto.

## 3. O que já existe e vai ser reusado

Não inventar o que o repositório já resolveu:

- **`audit_log` já separa ator de sujeito** (`actor_type`/`actor_id` vs `user_id`, migration
  0002). É exatamente o encaixe de "o cuidador X agiu no registro de Y". Falta só um valor
  novo no CHECK — e ele vive em **dois lugares** (SQL + união `AuditActorType` em
  `packages/db/src/audit.ts:22`) sem teste que os compare. Vamos adicionar esse teste.
- **`share_grants` + `share-grants.ts`** — o único acesso de terceiro que já existe.
  De lá vêm os padrões de token com hash, TTL com teto, PIN com salt por link,
  `timingSafeEqual`, tentativas limitadas e **desfecho único** para inexistente/expirado/
  revogado (não virar oráculo). O convite de cuidador segue a mesma escola.
- **`lib/otp.ts`** — `hashOtp(code, salt, pepper)`, `evaluateOtpAttempt` devolvendo
  `ok|expired|exhausted|consumed|mismatch` na ordem certa. O código de 6 dígitos do convite
  é a mesma mecânica, com outro alvo.
- **`resolveEntityRef` / `resolveConsultationForUser`** (`entity-resolve.ts`) — o padrão de
  resolver referência do modelo contra candidatos DO PACIENTE e lançar `ToolFailure` quando
  não dá pra ter certeza. É o que vai decidir "para quem é esta ação".
- **`withUserLock`**, **`ToolFailure`**, **`writeAudit`**, **`consent_events`**.
- **`Screen.tsx`** (mobile) — moldura única de toda tela logada; é o lugar natural do seletor.
- **Chaves do React Query já são `[KEY, user?.id]`** — segmentar por sujeito é extensão, não
  reescrita.

## 4. A decisão central

> **Separar ATOR de SUJEITO, e nunca deixar o sujeito ser inferido.**

- `ator` — quem está falando (telefone no WhatsApp, `sub` do JWT no app).
- `sujeito` — de quem é o registro afetado.
- **Padrão absoluto: `sujeito = ator`.** Todo o tráfego de hoje continua idêntico.
- Agir sobre outra pessoa exige que ela seja **nomeada** e que o vínculo seja **verificado
  no servidor, a cada requisição**.

O dado **não muda de lugar**: continua nas linhas do sujeito, nas mesmas 30 tabelas. O que
muda é **quem pode lê-las e escrevê-las**. Isso evita migração de dado, desnormalização e
qualquer risco de misturar prontuários.

E a fronteira mais importante do desenho:

> **`entity_relations` (o grafo que a IA infere: `takes`, `has_condition`) NUNCA vira
> autorização.** Um vínculo de cuidador nasce só de um ato deliberado e consentido. Uma
> Xarlote que deduz "ela é minha mãe" e abre o prontuário seria a pior falha possível
> deste produto.

## 5. Modelo de dados (migration 0029)

### `care_links` — o vínculo
```
id, caregiver_user_id → users, subject_user_id → users,
relation           -- 'filho','filha','pai','mae','neto','conjuge','responsavel','cuidador'
                   -- (relação do CUIDADOR com o SUJEITO: "sou filho dela")
kind               -- 'vinculo' (os dois têm conta) | 'dependente' (o sujeito não tem WhatsApp)
status             -- 'ativo' | 'revogado'
consent_event_id → consent_events   -- a prova; NOT NULL em kind='vinculo'
created_by_user_id, activated_at, revoked_at, revoked_by_user_id
```
Índice único **parcial** em `(caregiver_user_id, subject_user_id) where status='ativo'` —
permite reconectar depois de revogar, impede duplicata viva.

### `care_invites` — o código de 6 dígitos
Espelha `otp_codes`: `subject_user_id, code_hash, salt, attempts, max_attempts, expires_at,
consumed_at, consumed_by_user_id`. **Quem gera é o SUJEITO**, na Xarlote dele, e entrega ao
cuidador. Essa direção é a mais segura que existe: o código é prova de que a pessoa
deliberadamente deu acesso — não há convite não-solicitado, nem vetor de assédio.

### Perfil dependente
`users.account_kind text default 'titular' check in ('titular','dependente')`, com
`phone_e164 = 'dep-<uuid>'` — mesmo padrão de sentinela que o forget-me já usa
(`deleted-<uuid>`), respeitando o NOT NULL UNIQUE existente.

Dependente **não consente** (uma criança de 6 anos não pode). No lugar do consentimento
entra uma **declaração de responsabilidade** do cuidador, gravada em `consent_events` com
`policy_version` própria. É a posição honesta e auditável.

## 6. O funil único de autorização

Mesma disciplina do `appointment-consent.ts`: um módulo **puro** decide, e **toda** porta
passa por ele.

**`packages/shared/src/care-access.ts`** (puro, testável frase a frase)
```ts
export type CareCapability = 'ver' | 'agir';
export function podeAtuarSobre(vinculos, sujeitoId, cap): Veredito
export function descreverVinculo(v): string   // "Maria (mãe dele)"
```

**`apps/api/src/lib/care-subject.ts`** (I/O, uma leitura por turno, cacheada)
```ts
resolveSubject(atorId, sujeitoPedido?): Promise<SujeitoResolvido>
```
Sem `sujeitoPedido` → o próprio ator. Com → valida o vínculo **sempre**, no servidor.
Vínculo ausente/revogado → recusa tipada, nunca 200 silencioso.

## 7. Como a Xarlote sabe

**No prompt** — bloco novo `## QUEM VOCÊ CUIDA`, ao lado do `## CONTEXTO DESTE USUÁRIO`:
```
Além de Hiago, você também cuida de:
- Maria (mãe dele), 78 anos — ela também fala com você pelo WhatsApp dela
- Pedro (filho dele), 6 anos — perfil sem WhatsApp próprio

Quando ele falar de uma dessas pessoas, a ação vale no registro DELA, e você diz de quem
está falando em voz alta ("anotei no da dona Maria"). Na dúvida sobre de quem é, PERGUNTE.
```

**Nas tools** — um argumento opcional `para_quem` nas ~15 tools de escrita
(`create_reminder`, `save_exam_result`, `log_medication_taken`, `save_user_profile_fact`,
`log_symptom`, `list_reminders`, …). O executor resolve pelo padrão `resolveEntityRef`
contra os sujeitos autorizados e lança `ToolFailure` na ambiguidade.

Três invariantes, na linha das regras de ouro do projeto:
1. **Ausência de `para_quem` = o próprio ator.** Silêncio nunca roteia para terceiro.
2. **Ambiguidade nunca vira chute** — o modelo é mandado perguntar.
3. **O registro afetado é dito em voz alta** na resposta ao paciente.

**Na emergência** — `PAST_OR_OTHER_RE` passa a consultar os vínculos: "minha mãe está com
dor no peito" **é** emergência quando existe vínculo com a mãe, e o `red_flag_check` roda
no registro dela. Sem vínculo, o comportamento atual (não escalar) fica intacto.

## 8. Superfícies

**App (mobile).** `Screen.tsx` ganha um chip de pessoa no topo — moldura única, uma mudança
só. Todas as rotas `/app/*` aceitam `?subject=<userId>`, validado no servidor. Chaves do
React Query viram `[KEY, user?.id, subjectId]`. Tela nova `perfil/cuidar.tsx`: quem eu
cuido, quem cuida de mim, gerar código, conectar por código, revogar.

**WhatsApp.** O sujeito continua dono da conversa dele — a Xarlote não deixa de falar com a
mãe. O cuidador age pela conversa dele mesmo, nomeando a pessoa.

**Rotas legadas.** `routes/app.ts` (token público no bundle, telefone no body) **não recebe
nada disso.** Expor cuidador ali seria entregar prontuário de terceiro atrás de um token
que está no JavaScript da página.

## 9. LGPD e transparência

- **`care_links` entra em `PLANO_LGPD`** (`lgpd-plan.ts`) — o teste `tabelasSemTratamento()`
  quebra sem isso, e é bom que quebre.
- **Revogação é unilateral e imediata**: o sujeito revoga sozinho, sem o cuidador aprovar.
- **Apagar conta** revoga os vínculos nas duas direções antes de enfileirar.
- **Export** passa a trazer `care_links` das duas pontas.
- **Auditoria**: `actor_type='caregiver'`, `actor_id=<caregiver_user_id>`, `user_id=<sujeito>`.
  Aparece no export como "quem acessou seu prontuário", que é onde o titular já procura.
- **Aviso nas ações que pesam** (decisão do fundador): criar/apagar lembrete, enviar exame,
  registrar dose. Leitura pura não notifica.

## 10. Escala

Sem armadilha embutida: `care_links` é minúscula e indexada; uma leitura por turno, cacheada;
o dado não se move nem se duplica; o JWT continua sendo sobre o ator e o sujeito é parâmetro
validado a cada requisição (nunca confiado do cliente). Crescer é adicionar linhas, não
reescrever nada.

## 11. Fases

| Fase | Escopo | Fecha quando |
|---|---|---|
| ✅ **F1 — Fundação** | migration 0029, `care-access.ts` puro, `care-subject.ts`, plano LGPD, `actor_type='caregiver'` + teste que compara CHECK e união | testes verdes; nenhuma superfície mudou ainda |
| ✅ **F2 — Conexão** | gerar/resgatar código, os dois tipos de vínculo, revogação, consentimento gravado | dois usuários reais se conectam e se desconectam em staging |
| ✅ **F3 — A IA sabe** | bloco do prompt, `para_quem` nas tools, resolução de sujeito, correção da emergência | "cria um lembrete de losartana pra minha mãe" grava no registro DELA, e a resposta diz isso |
| ✅ **F4 — App** | seletor no `Screen.tsx`, `?subject`, tela `cuidar` | trocar de pessoa troca a bolsa inteira |
| ✅ **F5 — Transparência** | avisos ao sujeito, export, forget-me, painel de acessos | apagar conta não deixa vínculo órfão; o sujeito vê quem agiu por ele |

## 12. O que mudou durante a execução

**`relation` inverteu de direção.** O desenho original guardava a relação do CUIDADOR
("sou filho dela" → `'filho'`). Não fecha: `labelMatches` exige conter todos os tokens,
`'filho'` não casa com "minha mãe", e a inversão é impossível sem saber o gênero do sujeito.
Passou a guardar **quem o SUJEITO é** ("ela é minha mãe" → `'mae'`) — que é também a pergunta
natural de fazer na tela.

**Duas defesas a mais em `resolverSujeito`.** `resolveEntityRef` tem um resgate `only-one`:
com UM candidato, devolve esse candidato mesmo sem casar o texto. Numa lista só das pessoas
cuidadas, um cuidador com UMA pessoa veria qualquer alvo irreconhecível cair calado no
prontuário dela. O ATOR entra na lista (nunca há alvo único) **e** `only-one` é recusado.

**Um furo de LGPD antecipado da F5 pra F2.** `executeForgetMe` ANONIMIZA a linha de `users`
e nunca a deleta, então o `on delete cascade` de `care_links` jamais dispara. Quem pedisse
pra ser esquecido continuaria com acesso ATIVO ao prontuário de quem ficou.

**A emergência revelou um defeito de anos.** Ao separar PASSADO de TERCEIRA PESSOA, um teste
escrito pra provar que nada mudara falhou em três termos: `\b` do JavaScript só conhece
`[A-Za-z0-9_]`, então `minha av[óo]\b` NUNCA casou com "minha avó". Três das 23 alternativas
estavam mortas em produção. Trocado por `(?<!\p{L})…(?!\p{L})` com flag `u`.
⚠️ Isso MUDOU comportamento: "minha avó com dor no peito" **sem vínculo** deixou de disparar
a orientação determinística do SAMU.

**O que NÃO foi feito, e por quê:** não há tela de "quem mexeu no meu registro" (o evento e o
export existem, o painel não); `falar` segue sem ser concedido (decisão de produto); e a
Conta Cuidador **nunca foi usada por gente de verdade** — só por usuários sintéticos.

## 13. Verificação

- Vitest sobre os módulos puros: vínculo revogado não autoriza; ausência de `para_quem` é
  sempre self; ambiguidade lança; código expirado/consumido/errado colapsa num só desfecho.
- Script `apps/api/scripts/verify-care-link.ts`, na escola do `verify-forget-me.ts`: cria
  dois usuários sintéticos, conecta, escreve no registro do sujeito pelo cuidador, confere
  que o dado caiu na linha certa, revoga, confere que a escrita passa a ser recusada, e
  apaga tudo.
- E2E em staging: gerar código na Xarlote da mãe → resgatar na do filho → criar lembrete
  pra ela → ela receber o aviso → ela revogar → o filho perder o acesso na hora.
