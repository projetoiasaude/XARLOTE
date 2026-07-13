# Site da Xarlote — landing page

Landing page estática da Xarlote. **Zero dependências de build**: HTML + CSS + JS puros — é só servir a pasta.

**🌐 NO AR:** https://xarlote-site.vercel.app (Vercel, conta `diretoria-2205`, projeto `xarlote-site`).

```
site/
  index.html     ← página única (todo o conteúdo/copy)
  styles.css     ← design system + cenas + responsivo + reduced-motion
  main.js        ← motor: vídeo WebGL, nadador, cenas com scrub, reveals
  assets/        ← marca (copiados de apps/web/public)
```

## Config atual (já publicada)

- **Número do WhatsApp** — `WHATSAPP_NUMBER` em [main.js](main.js) = `5562982280719`
  (+55 62 98228-0719). Todos os CTAs abrem `wa.me/5562982280719`.
- **og:image** — URL absoluta em [index.html](index.html) apontando pro domínio Vercel.
  Se trocar pra domínio próprio (ex.: xarlote.com.br), atualize `og:url` + `og:image`.

## Rodar local

```bash
python3 -m http.server 3005 -d site --bind 127.0.0.1
# → http://localhost:3005
```
(ou o launch config `xarlote-site` no `.claude/launch.json`)

## Deploy

Vercel (projeto já linkado — `.vercel/` local, fora do git):

```bash
cd site && npx vercel --prod --yes
```
O domínio público de produção é `xarlote-site.vercel.app` (o alias limpo é público;
as URLs internas com hash ficam atrás do SSO da equipe — isso é normal e não afeta o público).
Pra domínio próprio: `npx vercel domains add <domínio>` ou pelo painel.

## Nadador — V2 (oficial) × V1

- **V2 (padrão, oficial)** — ícone de app liquid-glass com a logo em traço, girando
  em 3D (rotateY contínuo). É o que está no ar.
- **V1 (alternativa)** — `…/?v=1` → o nadador vira o render 3D do mascote (o mesmo do herói).
  Trocar o padrão: inverter a constante `SWIMMER_V2` em main.js.
- Histórico: V1 (render 3D nadando) foi salva no commit `89596b3`; o fundador
  escolheu a V2 (ícone girando) e ela virou a oficial + foi publicada.

## Como funciona (pro futuro-eu)

- **Herói 3D**: `xarlote-alpha.mp4` é um MP4 empilhado (cor em cima, máscara embaixo),
  recomposto com alpha via WebGL — mesma técnica do app (`XarloteVideoAlpha.tsx`),
  roda em iOS e Android. **Gotcha aprendido**: chame `gl.viewport()` depois de
  redimensionar o canvas (o contexto nasce 300×150). Sem GPU/erro → cai no mascote SVG.
- **Nadador (V2, oficial)**: ícone de app liquid-glass com a logo em traço, girando
  em 3D (`.sw-icon` com `rotateY` contínuo + duas faces). Viaja por waypoints
  interpolados pelo scroll (`buildWaypoints`/`applySwimmer`), inclina com a velocidade,
  doca no centro da órbita da memória e no CTA final. Clique: easter egg de corações.
  `?v=1` troca pra V1: o mesmo render 3D do herói num mini-canvas WebGL (um único
  `<video>` alimenta os dois contextos). O SVG rigado (`#mascotTpl`) é fallback do herói.
- **Cenas com scrub**: seções `[data-scene]` têm altura extra (`--len`) + conteúdo
  sticky; o progresso do scroll (0→1) anima chat/relógio/órbita — rolar pra trás rebobina.
- **Watchdog**: rAF pausa em aba oculta; um `setInterval` (200ms) aplica os alvos
  direto quando isso acontece (`step(now, true)`).
- **Acessibilidade**: `prefers-reduced-motion` desliga motor/nadador/vídeo e mostra
  estados finais; `prefers-reduced-transparency` remove blur; `<noscript>` idem.

## Guard-rails de conteúdo (produto/jurídico — NÃO remova)

O rodapé e a copy foram escritos de propósito para **não** prometer:
pagamento pelo WhatsApp, prazo de entrega, remédio tarjado sem receita,
substituir médico/farmacêutico, resposta de farmácia 24h. Emergência → SAMU 192.
Se editar a copy, mantenha essas restrições (vieram de incidentes reais).
