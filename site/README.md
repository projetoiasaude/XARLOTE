# Site da Xarlote — landing page

Landing page estática da Xarlote (xarlote.com.br ou similar). **Zero dependências de build**:
HTML + CSS + JS puros — é só servir a pasta.

```
site/
  index.html     ← página única (todo o conteúdo/copy)
  styles.css     ← design system + cenas + responsivo + reduced-motion
  main.js        ← motor: vídeo WebGL, nadador, cenas com scrub, reveals
  assets/        ← marca (copiados de apps/web/public)
```

## ⚠️ Antes de publicar (2 minutos)

1. **Número do WhatsApp** — em [main.js](main.js), primeira linha de config:
   ```js
   const WHATSAPP_NUMBER = '5562XXXXXXXXX'; // ← número OFICIAL da Xarlote (só dígitos, DDI+DDD)
   ```
   Enquanto for placeholder, os botões apontam pra `#cta` (e o console avisa).
2. **og:image** — em [index.html](index.html), troque `assets/xarlote-icon-512.png`
   pela **URL absoluta** do domínio final (crawlers de WhatsApp/Meta não resolvem
   caminho relativo), ex.: `https://xarlote.com.br/assets/xarlote-icon-512.png`.

## Rodar local

```bash
python3 -m http.server 3005 -d site --bind 127.0.0.1
# → http://localhost:3005
```
(ou o launch config `xarlote-site` no `.claude/launch.json`)

## Deploy

Qualquer host estático. Vercel (mesma conta do dashboard):

```bash
cd site && npx vercel --prod --yes
```

## Como funciona (pro futuro-eu)

- **Herói 3D**: `xarlote-alpha.mp4` é um MP4 empilhado (cor em cima, máscara embaixo),
  recomposto com alpha via WebGL — mesma técnica do app (`XarloteVideoAlpha.tsx`),
  roda em iOS e Android. **Gotcha aprendido**: chame `gl.viewport()` depois de
  redimensionar o canvas (o contexto nasce 300×150). Sem GPU/erro → cai no mascote SVG.
- **Nadador**: o MESMO render 3D do herói num mini-canvas WebGL (um único `<video>`
  alimenta os dois contextos; cada um pinta só quando visível). Viaja por waypoints
  interpolados pelo scroll (`buildWaypoints`/`applySwimmer`), vira pro lado do
  movimento, doca no centro da órbita da memória e no CTA final. Clique nele:
  easter egg de corações. Fallback (sem GL): ícone oficial em squircle glass girando.
  O SVG rigado (template `#mascotTpl`) segue existindo como fallback do herói.
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
