# Xarlote — app nativo (iOS + Android)

Expo SDK 57 · React Native 0.86 · React 19 · expo-router · TypeScript strict.

O plano completo está em `~/.claude/plans/kind-sprouting-marble.md`. Este README é só
o que morde na prática.

## Rodar

```bash
pnpm --filter @iasaude/mobile start
```

Precisa de um **dev client** (não Expo Go — o Firebase entra em F2 e Expo Go não
carrega módulo nativo próprio). Build de desenvolvimento:

```bash
pnpm --filter @iasaude/mobile exec eas build --profile development --platform ios
```

Sem simulador à mão, dá pra conferir layout pelo export web:

```bash
pnpm --filter @iasaude/mobile exec expo export --platform web --output-dir dist-web
```

e servir com o preview `xarlote-mobile-preview` (`.claude/launch.json`, porta 3006).
Serve pra **layout**, não pra comportamento: Reanimated, SecureStore, MMKV e
biometria têm shims de web que não representam o aparelho.

## Estrutura

```
src/
  app/            rotas (expo-router) — (auth), (main), lock
  components/ui/  primitivos Liquid Glass, mesmos contratos de apps/web/components/ui
  components/xarlote/  fundo aurora, orb, OrbNav, moldura de tela
  lib/            api (cliente + erros), auth (sessão + tokens + guarda), theme
  theme/          tokens portados 1:1 do tailwind do web
```

Domínio compartilhado vem de `@iasaude/shared` (workspace, source TS direto).

## Armadilhas já pagas — não repetir

1. **`disableHierarchicalLookup` no Metro quebra o pnpm.** É a receita padrão de
   monorepo npm/yarn e é exatamente errada aqui: no pnpm as dependências de cada
   pacote moram no `node_modules` irmão dele, e desligar o walk-up faz o `expo` não
   achar o `expo-modules-core`. O sintoma é uma cascata de "Unable to resolve module"
   que parece dependência faltando e não é. Ver `metro.config.js`.

2. **Animação nunca pode ser o que revela o conteúdo.** Um `entering={FadeInDown}`
   do Reanimated começa em `opacity: 0` e só chega a 1 se o worklet rodar. Quando não
   roda, a tela de login fica INVISÍVEL. As telas de entrada não usam `entering`; a
   animação que existe (o flutuar do orb) mexe só em `translateY` — se falhar, o orb
   fica parado, nunca some.

3. **O tema do react-navigation pinta por cima do aurora.** O tema padrão é claro, e
   `contentStyle: 'transparent'` no Stack não basta (vale pra cena, não pro contêiner
   do navegador). O `_layout` raiz injeta um tema com `background: 'transparent'`.

4. **Nada de request antes de haver sessão.** A tela logada chega a montar por um
   quadro antes da guarda redirecionar; por isso `useMe()` tem `enabled` e a splash só
   sai quando a rota já bate com a porta decidida.

5. **`@types/react` 18 vs 19 no monorepo.** O pnpm hoista UMA versão em
   `.pnpm/node_modules`, e a 19 (deste app) vazava pro `apps/web` (React 18) através
   dos `.d.ts` do próprio Next, quebrando o `RefObject`. Resolvido com `typeRoots` no
   `apps/web/tsconfig.json` — se o typecheck do web voltar a reclamar de React, é aí.

6. **`app.json` é lixo.** A config é o `app.config.ts`. O `expo install` às vezes
   recria o estático ao lado; está no `.gitignore`, apague se aparecer.

7. **`eas.json` — as três coisas que derrubaram o primeiro build**, em ordem:
   (a) o perfil `development` tem `developmentClient: true`, o que **exige o pacote
   `expo-dev-client` instalado** — sem ele o EAS recusa antes de subir nada;
   (b) `"pnpm": "9.15.9"` no perfil `base` é **obrigatório** e tem que casar com o
   `packageManager` da raiz do monorepo — o EAS não adivinha a versão e morre em
   "Failed to install pnpm" (lockfile v9 não é aceito por outra major);
   (c) o `eas.json` é validado por **schema estrito e NÃO aceita comentários** —
   nem a convenção `"//campo"`. É por isso que esta explicação está aqui e não lá.

8. **`projectId` e `owner` vão à mão no `app.config.ts`.** O `eas init` grava sozinho
   em `app.json`, mas não reescreve config dinâmica em TypeScript. E o `owner`
   (`xarlote.ai`) é fixado porque a conta do fundador tem DUAS organizações — sem ele
   um build pode ir pra conta errada e criar um projeto paralelo, com outro histórico
   de versões e outras credenciais.

## Portão do Hermes

`src/lib/shared-smoke.ts` roda no boot em desenvolvimento e compara `Intl` com
timeZone, `\p{...}`, `String.normalize` e `nextOccurrence` contra os valores EXATOS
que o vitest produz no Node. Divergiu, o domínio compartilhado não é confiável nesse
engine — a resposta é polyfill (`@formatjs`), nunca afrouxar o esperado.

**Ainda não foi executado num aparelho** (esta máquina não tem Xcode nem SDK do
Android). O que já está provado: o bundle iOS e Android compila pra bytecode Hermes
com os 18 módulos do `@iasaude/shared` dentro — ou seja, sintaxe e resolução estão de
pé. Falta o runtime.
