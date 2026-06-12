# Xarlote — App Nativo (iOS + Android) via Capacitor

> O app nativo é uma **casca fina** que carrega o app web de produção
> (`https://web-jade-ten-53.vercel.app/app`) dentro de um webview nativo e injeta
> os recursos do celular: **push notification**, status bar, botão voltar, haptics.
>
> **Vantagem:** toda atualização que você faz no app web aparece NA HORA no app
> nativo — sem reenviar pra loja. Você só reenvia pra loja quando muda algo
> nativo (ícone, permissões, plugins).

O projeto Capacitor vive em [`native/`](../native). O código que conversa com os
plugins nativos (registrar push, abrir rota ao tocar na notificação) já está no
app web em [`apps/web/components/xarlote/CapacitorBridge.tsx`](../apps/web/components/xarlote/CapacitorBridge.tsx).

---

## O que já está pronto (feito no código)

✅ Projeto Capacitor configurado (`native/capacitor.config.ts`) — appId `com.iasaude.xarlote`, carrega o Vercel
✅ Plataformas **iOS** e **Android** geradas (`native/ios`, `native/android`)
✅ Ícone e splash do app com a **logo oficial** sobre o navy da marca (100 tamanhos Android + 13 iOS)
✅ Android pré-configurado pra Firebase (aplica o google-services automático quando você dropar o `google-services.json`)
✅ Ponte de push no app web — pede permissão, registra o token, abre o chat ao tocar na notificação
✅ Backend de push completo: tabela `device_tokens`, endpoints `/app/push/register` e `/app/push/unregister`, e envio de push no `reminder-dispatcher` (quando a Xarlote acorda e fala primeiro, vai WhatsApp **e** push)

## O que falta (precisa do seu Mac + contas)

O envio de push usa **Firebase Cloud Messaging (FCM)** — um canal só que entrega
pra Android e iOS. Você precisa criar o projeto Firebase e as contas de loja.

---

## Passo a passo

### 0. Pré-requisitos no seu Mac
```bash
# Xcode completo (da App Store) — não só as command line tools
xcode-select --install            # se ainda não tiver
# Android Studio (https://developer.android.com/studio) — traz o Android SDK + Java
# CocoaPods NÃO é necessário (Capacitor 8 usa Swift Package Manager)
```

### 1. Criar o projeto Firebase (push) — grátis
1. https://console.firebase.google.com → **Adicionar projeto** → nome "Xarlote".
2. **Android:** Adicionar app → package name `com.iasaude.xarlote` → baixar
   `google-services.json` → colocar em `native/android/app/google-services.json`.
3. **iOS:** Adicionar app → bundle ID `com.iasaude.xarlote` → baixar
   `GoogleService-Info.plist` → no Xcode, arrastar pra dentro de `App/App/`.
4. **APNs (iOS):** Apple Developer → Certificates → Keys → criar uma **APNs Auth
   Key** (.p8) → no Firebase: Configurações do Projeto → Cloud Messaging → Apple
   app → subir a chave .p8 + Key ID + Team ID.

### 2. Pegar as credenciais do backend (service account)
1. Firebase → Configurações do Projeto → **Contas de serviço** → **Gerar nova
   chave privada** → baixa um JSON.
2. Desse JSON, pegue 3 campos e configure no **Railway** (services `ia-da-saude-api`
   E `worker`):
   ```
   FCM_PROJECT_ID    = project_id        (do JSON)
   FCM_CLIENT_EMAIL  = client_email      (do JSON)
   FCM_PRIVATE_KEY   = private_key        (do JSON — cola inteiro, com os \n)
   ```
   Enquanto esses 3 não existirem, o push é **no-op** (não quebra nada — o
   lembrete continua chegando pelo WhatsApp).

### 3. Buildar e rodar

```bash
cd native
npm install                 # se ainda não rodou

# sincroniza a config + plugins com os projetos nativos (rode após mudar o config)
npx cap sync

# ANDROID — abre no Android Studio, rode no emulador ou no seu celular
npx cap open android

# iOS — abre no Xcode
npx cap open ios
```

**No Xcode (iOS), uma vez:**
- Selecione o time de desenvolvimento (sua conta Apple) em *Signing & Capabilities*.
- Clique **+ Capability** → adicione **Push Notifications**.
- **+ Capability** → **Background Modes** → marque *Remote notifications*.

### 4. Publicar nas lojas
- **Apple App Store** (US$ 99/ano): no Xcode, *Product → Archive* → *Distribute App*
  → App Store Connect. Preencha a ficha do app (precisa de política de privacidade —
  exigida pra apps de saúde). Revisão: 1–3 dias.
- **Google Play** (US$ 25, taxa única): no Android Studio, *Build → Generate Signed
  Bundle (.aab)* → suba no Play Console. Revisão: algumas horas a 1 dia.

---

## Como testar o push end-to-end (depois do passo 2)

1. Instale o app no seu celular (via Xcode/Android Studio), entre com seu número.
   → o app pede permissão de notificação e registra o token (confira na tabela
   `device_tokens` do Supabase que apareceu uma linha pro seu usuário).
2. Crie um lembrete pra daqui 1 minuto ("me lembra de beber água em 1 minuto").
3. **Feche o app.** No horário, deve chegar a notificação nativa **e** a mensagem
   no WhatsApp. Tocar na notificação abre o app direto no chat.

---

## Decisões de arquitetura (pra quando precisar mexer)

- **Por que casca fina (`server.url`) e não empacotar o web?** Porque o app de
  saúde muda toda semana — assim você não depende da revisão da Apple (1-3 dias)
  pra cada ajuste. Se um dia quiser modo offline, troca `server.url` por um
  `next export` copiado pro `webDir` e mantém todo o resto.
- **Por que FCM pra iOS também?** Um canal só (Firebase) entrega pros dois. Menos
  código, menos credencial pra gerenciar. O FCM repassa pro APNs da Apple por baixo.
- **Push é no-op sem credencial** — mesmo padrão de Sentry/Telegram do projeto.
  O backend nunca quebra por falta de push; o WhatsApp continua sendo o canal
  garantido. O push é a camada que faz a Xarlote te alcançar com o **app fechado**.
- **O `CapacitorBridge`** só age dentro do app nativo (`isNativePlatform()`); no
  navegador comum e no PWA é totalmente inerte.
```
