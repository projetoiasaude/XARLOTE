# App mobile (Expo/React Native)

> Relatório integral do especialista (auditoria read-only de 21–22/09/2026, base `b981a3d`). Consolidação e priorização cruzada em [`00-CONSOLIDADO.md`](00-CONSOLIDADO.md).

---

# Auditoria read-only — `apps/mobile` (Xarlote, Expo SDK 57 / RN 0.86)

## 1. Visão geral

O app é bem acima da média em disciplina: tokens no Keychain/Keystore, refresh em voo único, keyset em tudo, merge/resync do chat puros e testados (17 arquivos `tests/mobile-*`), datas em -03:00 fixo sem `Intl`, estados de erro separados de vazio, `reduceMotion` respeitado, `typecheck` limpo. Os defeitos que achei não são de descuido geral — são costuras entre frentes que evoluíram separadas (Conta Cuidador × lembretes/ações; API × app no contrato de reenvio; SSE × refresh), e é justamente aí que o paciente perde.

Os três P0 têm um denominador comum: **o modo "cuidando de outro" foi ligado no cache e nas leituras, mas não nas escritas.** Um cuidador que toca "Já tomei" no lembrete da mãe é **deslogado** (403 mapeado como sessão morta), e um "+ Contar alergia" na Saúde da mãe escreve **no prontuário do próprio cuidador** — o incidente do `para_quem` de 31/08 de novo, por outra porta. Em P1: o "reenviar" do chat gera `clientId` novo e **duplica o turno** (a API diz, por escrito, que reusar é o caminho seguro); um refresh que falha por rede mostra "sua sessão expirou"; áudio cortado aos 3 min é descartado sem aviso; upload sem timeout trava o compositor; o cache MMKV com o prontuário inteiro entra no backup do Android (`allowBackup` default `true`); e o consentimento nunca é re-checado após o login.

Lint: **17 erros / 18 warnings** (com `reactCompiler: true` ligado) — o warning `'subjectExtra' is assigned a value but never used` em `use-reminders.ts:135` era a pista do P0 #1. `apps/mobile/dist` **não** é versionado (`.gitignore:8`, `git ls-files` = 0). Push **não existe** no app (nenhum `expo-notifications`/Firebase; `lib/push.ts` nunca é chamado).

---

## 2. Achados

### P0

**1. Ação de lembrete em modo cuidador → 403 → cuidador DESLOGADO**
Severidade P0 · BUG + SEGURANÇA (logout indevido, cache limpo)
`apps/mobile/src/features/reminders/use-reminders.ts:134-145`
```ts
const subject = useSubjectQuery();
const subjectExtra = subject ? subject.replace('?', '&') : '';   // ← nunca usado (lint confirma)
...
mutationFn: ({ id, acao, minutos }) =>
  apiFetch<AcaoResposta>(`/app/reminders/${id}/action`, {        // ← sem ?subject=
```
`apps/api/src/routes/app/reminders.ts:791-805` — a rota de ação usa `resolveOwner` (JWT = ator, sem `?subject`) e responde `403 forbidden` quando `reminder.user_id !== userId`. Só `GET /overview`, `GET /reminders` e `POST /reminders` honram `resolverSujeitoDaRequisicao`.
`apps/mobile/src/lib/api/errors.ts:70` mapeia `403 → 'unauthenticated'`; `client.ts:179-186` faz refresh, repete, e no segundo 403 chama `bridge.onSignedOut()`.
**Cenário:** filha abre Perfil → Cuidar → "abrir registro da mãe" → Lembretes → "Já tomei" (ou o `HojeCard` no chat, que também mostra o lembrete da mãe sem chip). Resultado: rotação de refresh à toa, 403, `clearSession()` + `clearQueryCache()`, tela de login. A linha volta ao estado anterior sem nenhuma frase.
**Correção:** (a) API: `POST /reminders/:id/action` passa a resolver `?subject=` com capacidade `'agir'` (mesma função das outras duas rotas); (b) app: usar `subjectExtra` na URL da mutation; (c) ver #3 para o mapeamento de 403.
Esforço: P (2 arquivos) · Confiança: alta.

**2. "+ Contar / Cotar / Já tomei" na bolsa da mãe escreve no prontuário do CUIDADOR**
Severidade P0 · BUG (dado no registro errado — classe do incidente `para_quem` de 31/08)
`apps/mobile/src/features/health/use-falar-com-xarlote.ts:72-81`
```ts
await apiFetch('/app/messages', { method: 'POST', body: {
  clientId: Crypto.randomUUID(), text: mensagem, sentAtMs: Date.now() } });
...
router.navigate('/');
```
Mensagens montadas com o dado da tela em primeira pessoa: `insights.ts:334` `Minha ${nome} está acabando. Pode cotar uma caixa pra mim?`; `insights.ts:389` `…desde meu último ${t.rotulo}`; `saude/index.tsx:287` `Quero te contar uma alergia minha.` O `POST /app/messages` não tem noção de sujeito (`messages.ts:164-254`) — a conversa é sempre a do JWT.
**Cenário:** cuidadora vê "sua Losartana acaba em 4 dias" na Saúde da mãe, toca "Cotar" → a Xarlote cota Losartana **para a filha**, no chat da filha, e o `profile-enricher` pode inferir que a filha toma Losartana. O chip "Você está no registro de X" existe só na moldura `Screen` — o chat (`app/(main)/index.tsx`) não usa `Screen`, então lá não há chip nenhum.
**Correção:** no mínimo, `useFalarComXarlote` e `AcaoDaSecao`/`CardAviso` ficam **desabilitados** quando `cuidandoDeOutro` (texto: "pra registrar no prontuário de X, fale pelo WhatsApp dela"); o `HojeCard` deve ignorar o sujeito (`useReminders` só do próprio) ou mostrar o chip. Longo prazo: `POST /messages?subject=` com a Xarlote sabendo "quem fala por quem" (o degrau explícito que o plano da Conta Cuidador reservou).
Esforço: P (gate na UI) / M (rota) · Confiança: alta.

**3. Qualquer 403 vira "sessão morta" e desloga**
Severidade P0 · BUG/SEGURANÇA (amplificador do #1; vale pra `media.ts:256`, `messages.ts:204`, `account.ts:193` e qualquer 403 futuro)
`apps/mobile/src/lib/api/errors.ts:69-71`
```ts
function kindFromStatus(status: number): ApiErrorKind {
  if (status === 401 || status === 403) return 'unauthenticated';
```
`client.ts:184-186`: `if (retryErr.failure.kind === 'unauthenticated') bridge?.onSignedOut();`
O contrato da API (`middleware/patient-auth.ts:9-12`) é: `token_expired` → refresh; `unauthorized` → logout. 403 é autorização, não autenticação.
**Correção:** novo kind `forbidden` (403, mensagem "Você não tem acesso a isso"), sem refresh e sem `onSignedOut`; deslogar só em 401 com código `unauthorized`/`invalid_refresh`/`session_revoked` — e nunca no retry pós-refresh de um 403.
Esforço: P · Confiança: alta.

### P1

**4. "Reenviar" gera `clientId` NOVO e duplica o turno da Xarlote**
Severidade P1 · BUG (contrato invertido entre app e API)
`apps/mobile/src/features/chat/use-chat.ts:366-369`
```ts
// clientId NOVO de propósito: o antigo pode ter chegado ao servidor (só a
// resposta se perdeu). Reusá-lo seria recusado pela idempotência e a tentativa
// morreria em silêncio — a bolha ficaria falhada pra sempre.
const novo = Crypto.randomUUID();
```
A API diz o oposto — `apps/api/src/queues/app-inbound.queue.ts:58-63`: reenvio com o MESMO clientId → 202 ("o BullMQ devolve o job que já existe… Se respondêssemos erro, o app… reenviaria com um clientId NOVO — aí sim duplicando de verdade"). Segundo cinto: índice único parcial em `messages(external_id)` (`lib/app-inbound.ts:12-13`).
Agravante: `merge.ts:194` `PENDING_TIMEOUT_MS = 90_000` marca "não enviou — toque pra tentar" quando o eco não chega em 90 s — que é exatamente o que acontece com o worker lento (cadeia de fallback da LLM, ingestão de laudo de 12 páginas) ou com o SSE morto (#6).
**Cenário:** paciente manda "tomei o remédio" numa rede ruim; 202 chega, o eco não; 90 s depois a bolha fica vermelha; ele toca; a Xarlote recebe a frase duas vezes (dois turnos, duas respostas, dois `log_medication_taken` — a guarda de 30 min segura a dose, mas "me lembra do losartana às 8" pode virar dois lembretes).
**Correção:** reenviar com o MESMO `clientId` (o servidor garante idempotência nas duas camadas e o eco/resync casa a pendente pelo `clientId`); antes de marcar `failed` por timeout, disparar um `resyncAgora()` e só falhar se o `clientId` não estiver na página fresca.
Esforço: P · Confiança: alta.

**5. Refresh que falha por rede/5xx mostra "Sua sessão expirou. Entra de novo"**
Severidade P1 · RISCO SOB REDE RUIM / UX
`apps/mobile/src/lib/api/client.ts:81-87, 95-97, 179-180`
```ts
// 5xx é a API de pé mas doente… devolve null e o request original falha como 'unavailable'.
if (res.status === 401) bridge.onSignedOut();
return null;
...
const fresh = await refreshAccessToken();
if (!fresh) throw err;   // ← err é o 401 original: kind 'unauthenticated'
```
O comentário promete `'unavailable'`; o código relança o `unauthenticated` (`errors.ts:45` → "Sua sessão expirou…"). `query.ts:28` não repete `unauthenticated`, e o `LoadFailure` cai no ramo "O problema é do meu lado… me chama no WhatsApp".
**Cenário:** access venceu (15 min), túnel do metrô, timeout de 20 s no refresh → todas as telas dizem que a sessão expirou; o paciente toca "Sair" e refaz OTP à toa.
**Correção:** quando `refreshAccessToken()` devolve null por transporte/5xx, lançar `ApiError({kind: 'network'|'unavailable', retryable: true})` (guardar o motivo do último refresh em `performRefresh`).
Esforço: P · Confiança: alta.

**6. SSE: 401 + refresh falho = stream morto em silêncio (sem polling); degradado nunca volta ao SSE**
Severidade P1 · RISCO SOB REDE RUIM
`apps/mobile/src/lib/stream.ts:138-143`
```ts
if (status === 401) {
  void refreshAccessToken().then((novo) => {
    if (novo && vivo.current) void conectar(0);
  });
  return;            // ← novo === null: nem retry, nem degraded, nem polling
}
```
e `stream.ts:145-152`: após `MAX_FALHAS = 2` entra em `degraded` e só sai no `AppState → 'active'`.
**Cenário:** reconexão após 15 min, refresh cai por timeout → `connected:false, degraded:false` → `use-chat.ts:252-256` não liga o polling (só com `degraded`) → a resposta da Xarlote nunca aparece até a pessoa minimizar e voltar. Combina com #4 (pendente vira "falhou" aos 90 s).
**Correção:** no ramo 401 com `novo === null`, contar como falha e agendar retry com backoff; no modo degradado, tentar o SSE de novo a cada ~60 s (e sair do polling quando abrir).
Esforço: P · Confiança: alta.

**7. Usuário novo: `409 no_conversation` → modo degradado + polling a cada 5 s + badge "atualizando de tempos em tempos"**
Severidade P1 · UX (primeira tela de quem instala — inclusive o revisor da loja) + OTIMIZAÇÃO
`apps/api/src/routes/app/stream.ts:62` `if (!conversationId) return reply.code(409).send({ error: 'no_conversation' });`
`apps/mobile/src/lib/stream.ts:145-152` trata como falha de rede; `app/(main)/index.tsx:200-208` mostra `GlassBadge "atualizando de tempos em tempos"` + `WifiOff`.
**Cenário:** conta nova, rede perfeita: 3 tentativas (1 s, 4 s, 10 s), ícone de "sem wifi" no cabeçalho e 12 requisições/min de `GET /messages` para sempre nesta sessão.
**Correção:** no `error` com `xhrStatus === 409`, marcar `semCanal` (sem `degraded`, sem polling) e reabrir o SSE após o primeiro `POST /messages` bem-sucedido (ou a cada 30 s).
Esforço: P · Confiança: alta.

**8. Áudio cortado aos 180 s (ou por ligação) é DESCARTADO sem envio nem aviso**
Severidade P1 · BUG
`apps/mobile/src/features/media/use-gravador.ts:101-103`
```ts
useEffect(() => {
  if (gravando && segundos >= MAX_SEGUNDOS) void gravador.stop();   // ← não chama parar()/upload
}, [gravando, segundos, gravador]);
```
`Compositor.tsx:95-100` só sobe o arquivo em `pararEEnviar` (toque no botão). Quando `estado.isRecording` vira `false` sozinho, o `if (gravador.gravando)` de `Compositor.tsx:103` sai da UI de gravação e o `.m4a` fica no cache. O docblock diz "ele ainda fica com os 3 minutos que falou" — não fica.
**Cenário:** idoso relata sintomas por 3 min; a barra some; nada é enviado; nenhuma frase explica.
**Correção:** o hook expõe `terminouSozinho` (ou o efeito chama um `onLimite` do Compositor) → `pararEEnviar()`; interrupção (ligação) idem, com frase "gravação interrompida — enviei o que tinha".
Esforço: P · Confiança: alta.

**9. Upload de mídia sem timeout/cancelamento; compositor fica travado em "Enviando…"**
Severidade P1 · RISCO SOB REDE RUIM
`apps/mobile/src/features/media/use-media.ts:100-116` — `fetch(`${API_BASE_URL}/app/media`, {...})` sem `AbortController` (o `apiFetch` com timeout de `client.ts:23` não é usado aqui). `Compositor.tsx:206-217`: `editable={!ocupado}`, `placeholder 'Enviando…'`, botão de anexo `disabled={ocupado}`.
**Cenário:** foto de 4 MB (base64 ~5,5 MB) num 3G que pendura: sem progresso, sem "cancelar", e o campo de texto fica bloqueado — a pessoa não consegue nem escrever "manda depois".
**Correção:** `AbortController` com timeout proporcional ao tamanho (ex.: 60 s + 10 s/MB), botão "cancelar" na barra, e não bloquear o `TextInput` durante o upload. Progresso real exige `XMLHttpRequest.upload.onprogress` (funciona no RN) — o fetch não reporta.
Esforço: M · Confiança: alta.

**10. Prontuário em claro no MMKV + `allowBackup` default `true` → backup automático do Android leva o cache**
Severidade P1 · SEGURANÇA (exige build nativo novo)
`apps/mobile/src/lib/query.ts:18` `const storage = createMMKV({ id: 'xarlote.cache' });` (sem `encryptionKey`) — persiste chat, overview (alergias, medicamentos, memória), lembretes.
`apps/mobile/app.config.ts:48-54` não define `android.allowBackup`; `@expo/config-plugins/build/android/AllowBackup.js:26`: `return config.android?.allowBackup ?? true;`
O próprio `token-store.ts:4-6` recusa "arquivo legível por qualquer backup" — para o token; o cache com o conteúdo do prontuário fica de fora dessa decisão.
**Correção:** `android: { allowBackup: false }` (muda o fingerprint → APK novo) e/ou `createMMKV({ id, encryptionKey })` com chave gerada e guardada no SecureStore (funciona por OTA).
Esforço: P · Confiança: alta (default verificado no plugin instalado).

**11. `consentRequired` do `/app/me` nunca é consumido — após um bump de `APP_CONSENT_VERSION`, quem já está logado fica preso**
Severidade P1 · BUG latente (dispara na próxima mudança de política)
`apps/mobile/src/lib/auth/session.tsx:128-130`
```ts
// Em arranque frio o consentimento é confirmado pelo /app/me; assumir
// "pendente" aqui mostraria a tela de termos a quem já aceitou.
consentRequired: false,
```
`use-me.ts` devolve `MeResult.consentRequired` e ninguém chama um setter (grep: `markConsented` só em `consent.tsx:72`). `use-chat.ts:307-310` confia que "a guarda de rota leva pra tela de termos assim que o /app/me confirmar" — não leva. A API só gera 428 no `POST /messages` (`messages.ts:173-175`).
**Cenário:** nova versão do texto LGPD → todo envio no chat responde "Preciso do seu aceite dos termos…" e não há como aceitar sem sair da conta e refazer OTP.
**Correção:** no `useMe` (ou num efeito do `SessionProvider`), `if (data.consentRequired) setState(consentRequired: true)`; e no 428 do `despachar`, idem. Bônus: o 409 `stale_policy_version` de `consent.ts:61` deve refazer o `GET /consent` (`consent.tsx:64-78` hoje mostra "Algo saiu do esperado" e repete o mesmo POST).
Esforço: P · Confiança: alta.

### P2

**12. Falha de "Já tomei"/"+30 min"/"cancelar" é silenciosa (rollback sem frase)**
Severidade P2 · UX (regra da casa: falha nunca vira silêncio)
`lembretes.tsx:149-155` — `aoFalhar` só remove o id de `agiuAgora`; `use-reminders.ts:168-170` só restaura a lista; `HojeCard.tsx` não tem canal de erro. O cartão volta a "PASSOU DA HORA" sem dizer "não consegui registrar — tenta de novo".
**Correção:** `onError` exibe a `failure.message` numa barra dispensável (o padrão do `erroBarra` do chat).
Esforço: P · Confiança: alta.

**13. Contrato `404 user_gone` → "logout local" não existe no app**
Severidade P2 · QUALIDADE/LGPD (janela ≤15 min, porque `forget-me.ts:6-9` revoga `app_sessions` primeiro)
`apps/api/src/routes/app/me.ts:37-39`, `overview.ts:35-39`, `messages.ts:98`: "404 aqui derruba pro logout local". `errors.ts:71`: `404 → 'not_found'`; nenhum `user_gone` no mobile (grep vazio). Até o access vencer, as telas seguem desenhando o prontuário apagado do cache (`saude/index.tsx:200` só mostra `LoadFailure` quando `!data`).
**Correção:** `CODE_TO_KIND['user_gone'] = 'unauthenticated'` (ou kind próprio) + `onSignedOut()` — e corrigir os três comentários da API se ficar como está.
Esforço: P · Confiança: alta.

**14. React Query sem `focusManager`/`onlineManager`: `refetchOnReconnect`/foreground nunca disparam no RN**
Severidade P2 · BUG de frescor / OTIMIZAÇÃO
`query.ts:31` `refetchOnReconnect: true`; `_layout.tsx` não chama `focusManager.setEventListener` nem `onlineManager.setEventListener` (sem `NetInfo` nas deps). As abas ficam montadas (`OrbNav.tsx:337` `router.navigate`), então `refetchOnMount` também não roda. `lembretes.tsx:170-173` e `use-agora.ts` só reacertam o RELÓGIO.
**Cenário:** app aberto ontem à noite, volta às 9h: lembrete criado pelo WhatsApp de manhã não aparece até puxar pra atualizar; o `HojeCard` cobra a dose de ontem com dados velhos.
**Correção:** receita oficial (3 linhas): `AppState` → `focusManager.setFocused(status === 'active')`; `onlineManager` com `expo-network`/`NetInfo` (módulo nativo → build) ou, sem build, `invalidateQueries` no `active` via o mesmo listener.
Esforço: P · Confiança: alta.

**15. OTA: sem checagem em foreground nem gate de versão mínima**
Severidade P2 · QUALIDADE (a promessa do plano é "correção em minutos")
`app.config.ts:81-84` `updates: { url, fallbackToCacheTimeout: 0 }` (padrão `checkAutomatically: ON_LOAD`); nenhum `checkForUpdateAsync`/`reloadAsync` no código; `/app/me` (`me.ts:56-59`) não expõe `minAppVersion`.
**Cenário:** Android mantém o app vivo por dias; o paciente nunca "abre" de novo → a correção de uma tela de medicação nunca chega.
**Correção:** no `AppState → active` (se `otaDisponivel` e >1 h desde a última checagem) `checkForUpdateAsync` + `fetchUpdateAsync` + `reloadAsync` na próxima ida ao background; `flags.minAppVersion` no `/me` com tela "atualize pra continuar".
Esforço: P/M · Confiança: alta.

**16. Push não existe no app; `lib/push.ts` é código morto que mente; `POST_NOTIFICATIONS` declarado sem uso**
Severidade P2 · QUALIDADE (pendência conhecida: Firebase/F5)
`lib/push.ts:52-56` "Chamado no logout — e é importante…" — `registrarToken`/`darBaixaToken` não têm nenhum chamador (grep); sem `expo-notifications` nem `@react-native-firebase/*` em `package.json`; `app.config.ts:53` declara `POST_NOTIFICATIONS`; `MeResult.flags.pushConfigured` nunca é lido; sem canal Android, sem tap-para-navegar. Hoje "lembrete toca" só pelo WhatsApp.
**Correção:** enquanto o F2/F5 não vem, remover `POST_NOTIFICATIONS` (revisão de loja pergunta) ou marcar `push.ts` como "NÃO LIGADO" no docblock; quando ligar: registrar após `signIn` e a cada boot, `darBaixaToken` no `signOut`, canal Android com importância alta, `DeviceNotRegistered` já tratado no backend.
Esforço: P (higiene) / G (push real) · Confiança: alta.

**17. Sem ErrorBoundary próprio nem crash report: erro de render vira "Something went wrong" em inglês**
Severidade P2 · QUALIDADE
grep `ErrorBoundary|Sentry` em `src/` vazio; o fallback é o do expo-router (`node_modules/expo-router/build/views/ErrorBoundary.js:18` `"Something went wrong"` + botão `"Retry"`). A API tem Sentry env-gated; o app não reporta nada — um crash no aparelho do paciente é invisível.
**Correção:** `export { ErrorBoundary }` em `app/_layout.tsx` com tela PT-BR ("Deu ruim aqui do meu lado — tenta de novo / me chama no WhatsApp") e `@sentry/react-native` (módulo nativo → build) ou, por OTA, um `ErrorUtils.setGlobalHandler` que manda o stack pra um endpoint da API.
Esforço: P/M · Confiança: alta.

**18. Foto sobe sem redimensionar (base64 de 5–7 MB no heap) e sem recuperar `getPendingResultAsync` no Android**
Severidade P2 · OTIMIZAÇÃO/RISCO (Android de entrada)
`use-media.ts:202-208, 235-238` — `quality: 0.8, base64: true` sem `maxWidth`/manipulator; `use-media.ts:100-109` `JSON.stringify({ base64 })` duplica a string. Foto de 12 MP a 0.8 ≈ 3–5 MB → ~7 MB base64 + cópia no `stringify`. Sem `ImagePicker.getPendingResultAsync()` no boot: quando o Android mata a activity atrás da câmera (Xiaomi de entrada faz isso), a foto se perde.
**Correção:** `expo-image-manipulator` (nativo → build) para ≤2048 px/JPEG 0.8 — reduz upload, RAM e custo de visão; ou, sem build, `allowsEditing:false` + `quality: 0.6`. Chamar `getPendingResultAsync()` no `_layout`.
Esforço: M · Confiança: média-alta.

**19. `expo-image` cacheia pela URL ASSINADA: re-download a cada 8 min e cópias do laudo no disco**
Severidade P2 · OTIMIZAÇÃO/PRIVACIDADE
`ChatMedia.tsx:196-203` `source={{ uri: dados.url }} … cachePolicy="memory-disk"` — a URL muda a cada `staleTime` (`use-media-url.ts:39`, 8 min), então o cache de disco nunca acerta e acumula uma cópia por URL.
**Correção:** `source={{ uri, cacheKey: mediaId }}`; considerar `cachePolicy="memory"` para exames.
Esforço: P · Confiança: alta.

**20. Persistência reserializa o cache INTEIRO a cada evento; página 0 do chat cresce sem teto**
Severidade P2 · RISCO SOB CARGA (histórico grande, sessão longa)
`_layout.tsx:91` `PersistQueryClientProvider` (throttle 1 s, `JSON.stringify` do client todo na thread JS); `resync.ts:133-148` une fresca+antiga na página 0 a cada resync; `use-chat.ts:390` reordena todos os itens carregados (`mergeMessages`, O(n log n)) a cada pendente/evento. Quem rolou 60 páginas (1.800 msgs) paga ~MBs de `stringify` por resposta da Xarlote — jank visível em Android de entrada, e o blob MMKV fica com o histórico todo.
**Correção:** `persistOptions.dehydrateOptions.shouldDehydrateQuery` limitando o chat às 2 primeiras páginas (ou `serialize` que poda `pages`); `buster` com o hash do OTA pra invalidar shape antigo.
Esforço: P/M · Confiança: média.

**21. Modo de áudio fica em "gravação" depois de gravar**
Severidade P2 · BUG (iOS principalmente; Android varia por aparelho)
`use-gravador.ts:65` `setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true })` sem `allowsRecording: false` no `parar`/`cancelar`; `audio-playback.tsx:54-56` só configura na montagem. Após o primeiro áudio gravado, a reprodução das mensagens de voz sai pelo auricular/baixa.
**Correção:** no `finally` de `parar`/`cancelar`: `setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true })`; apagar o `.m4a` temporário após o upload (hoje acumula no cache).
Esforço: P · Confiança: média-alta.

**22. Falha de leitura vira "vazio" em Cuidar e Compartilhar**
Severidade P2 · UX (a mesma classe que `load-failure.tsx:5-10` documenta)
`perfil/cuidar.tsx:32,76-81` `const { data } = useVinculos()` → `cuido.length === 0` → "Você ainda não acompanha ninguém"; `perfil/compartilhar.tsx:36,222` → "Links ativos" simplesmente não aparece sem `isError`/`isLoading`.
**Cenário:** rede cai, a mãe acha que o link do médico foi derrubado e cria outro (com PIN novo).
**Correção:** `Skeleton` + `LoadFailure` como nas outras telas.
Esforço: P · Confiança: alta.

### P3 (agrupados)

**23. Sessão/cadeado — pequenos furos**
· Relock volta sempre pra `/` (`session.tsx:147-149` → `_layout.tsx:76` `router.replace`): a pessoa que estava em Lembretes cai no chat após o dedo.
· Sem tela de privacidade no app switcher (nada em `'inactive'`, sem `FLAG_SECURE`): o snapshot mostra o prontuário por até 60 s+.
· `lock.tsx:46` `user_cancel` mostra "Não reconheci".
· `client.ts:155-157` comentário diz "os dois valem" mas `signal: opts.signal ?? t.signal` DESLIGA o timeout quando há signal (latente: ninguém passa `signal` hoje; e o `signal` do React Query não é repassado → sem cancelamento ao desmontar).
Esforço: P · Confiança: alta.

**24. Datas/UX/acessibilidade**
· `Bubble.tsx:29-33` hora da bolha no fuso do APARELHO, enquanto `index.tsx:63-68` fixa a regra "tudo em `horaBrt`" — a mesma conversa mostra dois fusos pra quem viaja.
· `HojeCard.tsx:79-85` `isError` com cache válido mostra "Não consegui ver seus lembretes agora".
· `VisorFoto.tsx:49-52` `top: 52` fixo (sem `insets.top`) — botão de fechar sob a status bar em alguns Androids edge-to-edge.
· `otp.tsx:147-160` `TextInput` oculto sem `accessibilityLabel` (TalkBack não anuncia "código").
· `Compositor.tsx:296-313` botões enviar/microfone 42×42 sem `hitSlop`; `FlashList` sem `getItemType` (bolha de mídia reciclada como texto).
· 429/503: `Retry-After` ignorado; retry do RQ (1 s/2 s) morre antes de um deploy do Railway terminar — o botão "Tentar de novo" cobre.
· Nenhum `maxFontSizeMultiplier`: bom pra acessibilidade, mas alturas fixas (`iconeBotao` 42, células do OTP `aspectRatio`) quebram a 200 %.
Esforço: P · Confiança: alta.

**25. Higiene**
· `expo lint`: 17 erros (`react-hooks/immutability`, `set-state-in-effect`, refs em render em `stream.ts:71-72`, `use-chat.ts:359`) com `experiments.reactCompiler: true` (`app.config.ts:96`) — o compilador só pula essas funções, mas o sinal se perde no ruído (o `subjectExtra` do P0 #1 estava lá).
· Deps nativas sem nenhum import: `@expo/ui`, `expo-glass-effect`, `expo-symbols` (`package.json`) — removê-las muda o fingerprint (precisa de APK), então decidir junto com #10.
· Docblocks desatualizados: `use-memoria.ts:11-21` ("rota que ainda não existe" — `DELETE /app/memory/:id` existe e `APAGAR_CARD_DISPONIVEL = true` em `memoria.ts:56`); `use-gravador.ts:97-99`; `push.ts:52-56`.
· Duplicação com `apps/web/lib/xarlote/{types,use-chat,format}.ts` e `apps/web/components/xarlote/{OrbNav,LiquidCore,XarloteBackground}.tsx` (1.739 linhas) — os tipos do `Overview` (`features/health/overview.ts:241-257`) deveriam nascer de um schema Zod exportado pela API em `@iasaude/shared`; o resto morre com o `/app` web no F5.
· `typescript ~6.0.3` no mobile vs `^5.4` na raiz (typecheck passa; só registrar).
· `shared-smoke.ts`: portão de Hermes que compara `Intl`/`\p{}`/`normalize`/`nextOccurrence` com valores do vitest; roda só em `__DEV__` (`_layout.tsx:27`) — ainda "não executado num aparelho" segundo o README.
Esforço: P · Confiança: alta.

---

## 3. Tabela por tela

| Tela | Dados | Lista virtualizada? | L / E / Err / offline | Risco principal |
|---|---|---|---|---|
| `(auth)/welcome` | `requestOtp` | n/a | botão loading · erro inline · fixo detectado | — |
| `(auth)/otp` | `verifyOtp`, `requestOtp` | n/a | busy · erro · cooldown honesto (`otp-timer`) | campo oculto sem label (a11y) |
| `(auth)/consent` | `GET/POST /consent` | n/a | erro + retentativa (`tentativa`) | 409 `stale_policy_version` em loop (#11) |
| `lock` | `LocalAuthentication` | n/a | tentando · falhou | relock perde a tela; sem privacy overlay (#23) |
| `(main)/index` (Conversa) | `useInfiniteQuery ['chat']` + SSE + polling · `useReminders` (HojeCard) · `useMe` | **FlashList v2** (`maintainVisibleContentPosition`, `onStartReached`) | skeleton · `LoadFailure` · vazio só sem erro · cache MMKV | reenviar duplica (#4); stream morto (#6); 409 novo usuário (#7); HojeCard da mãe sem chip (#2) |
| `(main)/saude` | `useOverview` (14 consultas, caps 5–180) | ScrollView (capped: `ListaComTeto`, sintomas ≤20) | skeleton · `LoadFailure` · vazio por seção · cache | ação escreve no prontuário errado em modo cuidador (#2) |
| `(main)/lembretes` | `useReminders ?scope=active` · `useInfiniteQuery history` (só ao abrir) | ScrollView (≤60 vivos + 12/pág) | skeleton · `LoadFailure` · vazio · `truncado` dito · cache | ação cuidador → logout (#1); falha silenciosa (#12); sem refetch no foreground (#14) |
| `(main)/atividade` | `useOverview` | ScrollView (orders ≤10, consultas ≤5) | ok (L/Err/vazio) | — |
| `(main)/exames`, `exames/[id]` | `useOverview` (≤60) | ScrollView agrupado por mês | ok | — |
| `(main)/perfil` | `useMe` (invalidado no focus) · `useMemoria` (do overview, ≤80) | ScrollView (`BlocoMemoria` recolhido) | `LoadFailure` · RefreshControl | — |
| `perfil/compartilhar` | `useShares` + mutations | ScrollView | **sem L/Err** | falha vira "sem links" (#22) |
| `perfil/cuidar` | `useVinculos` + 3 mutations | ScrollView | **sem L/Err** | falha vira "não acompanha ninguém" (#22); `trocarPara` leva pra Saúde sem aviso sobre o chat |
| `perfil/privacidade` | export (polling 3 s, teto 60) · `DELETE /account` | ScrollView | ok · `desistiu` explícito | — |

---

## 4. O que verifiquei e está OK

- **Tokens** em `expo-secure-store` (`token-store.ts:13-23`), nunca MMKV/AsyncStorage; `WHEN_UNLOCKED_THIS_DEVICE_ONLY`; leitura fail-closed; `saveTokens` falho não derruba a sessão.
- **Refresh em voo único** (`client.ts:67-119`): N 401 simultâneos → uma rotação; `onRotated` descarta rotação tardia pós-logout (`session.tsx:100`); servidor com graça de 60 s e CAS (`refresh-token.ts`, `auth.ts:319-340`). A corrida residual (401 chegando depois da rotação) gera uma 2ª rotação válida, sem logout.
- **Relógio do aparelho errado**: `exp` só é checado no servidor; `sentAtMs` clampado (`messages.ts:228`); `brDesde` protege futuro negativo; OTP/relock/pendentes usam o mesmo relógio local dos dois lados.
- **Logout** limpa Keychain + `queryClient.clear()` + `storage.clearAll()` (`session.tsx:80-86`, `query.ts:48-51`) — também nos caminhos sem botão (`onSignedOut`).
- **Guarda de rota única e pura** (`route-decision.ts`, testada em `tests/mobile-auth-gate.test.ts`); splash com rede de segurança de 4 s; cadeado antes do consentimento; biometria confirmada antes de ligar (`perfil/index.tsx:80-95`) e destravada se a biometria foi removida.
- **Timeout real** de 20 s em todo `apiFetch` (AbortController, não `AbortSignal.timeout`); erros classificados por `kind` (`errors.ts`), mensagem do servidor vence; `retry` do RQ só em `network/timeout/unavailable`, nunca em 4xx.
- **Chat**: dedupe por `id` e por `clientId`, ordenação igual ao keyset do servidor, resync de UMA página com fusão (não `invalidateQueries`), `recomecar` honesto quando há lacuna, coalescência de 700 ms, resync adiado nunca descartado, `AppState` fecha o SSE em background e re-sincroniza no retorno, "digitando" com teto de 60 s, orb `thinking` sem segundo `LiquidCore`.
- **Idempotência do envio**: `clientId` = `randomUUID` do `expo-crypto`; `jobId` + índice único no servidor (o problema é só o reenvio, #4).
- **Teclado**: `useAnimatedKeyboard` no lugar de `KeyboardAvoidingView` (o bug do Expo 54+/edge-to-edge está documentado e corrigido por OTA).
- **Mídia**: upload em duas etapas (arquivo → mensagem) com retry só da parte barata; permissão de câmera/microfone no momento do uso; HEIC→JPEG; PDF checado por tamanho ANTES do base64 (`use-media.ts:302-305`); `requireOptionalNativeModule` para módulos que podem não estar no binário; prévia da foto mostra o que o servidor recebeu, botão "Não enviar" honesto; um único player de áudio; URL assinada re-pedida antes de vencer (`use-media-url.ts:39-40`); áudio sob demanda.
- **Datas** em -03:00 fixo, `DATE` puro ancorado na meia-noite de Brasília (`br-format.ts:78-83`), dia de calendário ≠ 24 h (`diffDiasBrt`); testes em `tests/mobile-br-format.test.ts`.
- **Lembretes**: eco otimista usa a MESMA função pura do servidor (`reminderActionPatch`), rollback obrigatório, cancelar pede confirmação, histórico paginado por cursor só quando aberto, `gcTime` curto do histórico, `truncado` dito ao paciente, invalidação de overview após ação/criação.
- **Cálculos pesados** memoizados (`adesao`, `avisos`, `agenda`, `resumo`); `AdherenceChart` recebe 30 pontos; listas capadas no servidor.
- **Acessibilidade**: `accessibilityRole/Label/State` no OrbNav, bolhas, play, 192; alvos ≥44 via `hitSlop` calculado (`glass-button.tsx:111`); `useReducedMotion` em 7 componentes; nenhum `allowFontScaling={false}`.
- **Logs**: nenhum `console.*` com dado de paciente (só o smoke em dev); eventos da API sem título de remédio/PII.
- **Config**: `runtimeVersion: fingerprint`, `fallbackToCacheTimeout: 0`, `owner` e `projectId` fixos, `scheme: xarlote`, strings de uso PT-BR, `dist/` ignorado, `app.json` proibido, `eas.json` com pnpm travado — coerente com a memória do projeto.

---

## 5. Perguntas em aberto

1. **Cuidador deve poder confirmar/adiar/cancelar o lembrete da pessoa cuidada?** O plano diz "vê e registra no prontuário dela" e `POST /reminders?subject=` já exige `agir`; se sim, #1 é uma rota a ajustar; se não, a UI precisa esconder os botões no modo cuidador (hoje ela mostra e desloga).
2. **"Falar com a Xarlote" em nome de outro** foi reservado como "degrau explícito que nenhum vínculo abre" — a decisão pra #2 é bloquear os botões na bolsa alheia ou abrir `POST /messages?subject=` com a persona sabendo que fala com a cuidadora sobre a mãe?
3. **Reenvio com o mesmo `clientId`** (#4): há algum motivo histórico (um 409 antigo?) pra o app achar que "seria recusado pela idempotência"? Não achei rota que rejeite.
4. **Backup do Android** (#10): aceita-se um APK novo (fingerprint muda) só pra `allowBackup: false`, ou prefere `encryptionKey` no MMKV por OTA primeiro?
5. **Push**: o F2/Firebase continua no roadmap? Enquanto não vem, tirar `POST_NOTIFICATIONS` do manifesto evita pergunta na revisão da loja.
6. **`shared-smoke.ts`** nunca rodou num aparelho real (README): dá pra pedir ao fundador abrir um dev build no Android e ler o `[smoke]` uma vez — é o que valida `nextOccurrence` no Hermes.
7. **Tempo real de um turno lento** (fallback de LLM, laudo grande): qual é o p95 hoje? Ele define se 90 s (`PENDING_TIMEOUT_MS`) é teto honesto ou fonte de "falhou" falso.
