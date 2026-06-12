/**
 * Gera o ícone "liquid glass" da Xarlote: logo oficial como tubos de vidro
 * luminosos sobre uma tile escura com profundidade aurora. Sem filtros SVG
 * (renderização 100% confiável) — todos os efeitos (brilho, sombra, bevel) são
 * pré-rasterizados em camadas via sharp e compostos como <image> no SVG final.
 */
const sharp = require('sharp');
const fs = require('fs');

const SRC = '../apps/web/public/xarlote-logo.svg';
const CANVAS = 1024;
const LOGO = Math.round(CANVAS * 0.7); // logo grande, bem distribuída no quadrado
const OFF = Math.round((CANVAS - LOGO) / 2);
const logoSvg = fs.readFileSync(SRC);

const b64 = (buf) => `data:image/png;base64,${buf.toString('base64')}`;

async function whiteLogo(size) {
  return sharp(logoSvg, { density: 500 })
    .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
}

(async () => {
  const base = await whiteLogo(LOGO);

  // Camadas derivadas (tint multiplica sobre branco → recolore preservando o alfa)
  const shadow = await sharp(base).tint({ r: 0, g: 0, b: 0 }).blur(18).png().toBuffer(); // sombra solta no chão
  const glow = await sharp(base).tint({ r: 130, g: 155, b: 255 }).blur(5).png().toBuffer(); // halo luminoso azulado, contido
  const bevelDark = await sharp(base).tint({ r: 22, g: 26, b: 55 }).png().toBuffer(); // aresta de baixo (sombra do tubo)

  const layer = (buf, x, y, opacity) =>
    `<image href="${b64(buf)}" x="${x}" y="${y}" width="${LOGO}" height="${LOGO}" opacity="${opacity}" />`;

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${CANVAS}" height="${CANVAS}" viewBox="0 0 ${CANVAS} ${CANVAS}">
  <defs>
    <linearGradient id="tile" x1="0" y1="0" x2="0.35" y2="1">
      <stop offset="0" stop-color="#0c0d24"/>
      <stop offset="0.55" stop-color="#070716"/>
      <stop offset="1" stop-color="#030308"/>
    </linearGradient>
    <radialGradient id="auroraBlue" cx="0.28" cy="0.24" r="0.55">
      <stop offset="0" stop-color="#3b6ef5" stop-opacity="0.32"/>
      <stop offset="1" stop-color="#3b6ef5" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="auroraPurple" cx="0.76" cy="0.8" r="0.55">
      <stop offset="0" stop-color="#7c4ddb" stop-opacity="0.28"/>
      <stop offset="1" stop-color="#7c4ddb" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="auroraPink" cx="0.85" cy="0.28" r="0.4">
      <stop offset="0" stop-color="#d946ef" stop-opacity="0.14"/>
      <stop offset="1" stop-color="#d946ef" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="sheen" cx="0.32" cy="0.2" r="0.7">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.14"/>
      <stop offset="0.5" stop-color="#ffffff" stop-opacity="0.03"/>
      <stop offset="1" stop-color="#ffffff" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="topGloss" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.16"/>
      <stop offset="0.22" stop-color="#ffffff" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="rim" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.35"/>
      <stop offset="0.08" stop-color="#ffffff" stop-opacity="0.06"/>
      <stop offset="0.9" stop-color="#000000" stop-opacity="0"/>
      <stop offset="1" stop-color="#000000" stop-opacity="0.3"/>
    </linearGradient>
  </defs>

  <!-- tile de vidro escuro -->
  <rect width="${CANVAS}" height="${CANVAS}" fill="url(#tile)"/>
  <!-- profundidade aurora -->
  <rect width="${CANVAS}" height="${CANVAS}" fill="url(#auroraBlue)"/>
  <rect width="${CANVAS}" height="${CANVAS}" fill="url(#auroraPurple)"/>
  <rect width="${CANVAS}" height="${CANVAS}" fill="url(#auroraPink)"/>
  <!-- reflexo de vidro -->
  <rect width="${CANVAS}" height="${CANVAS}" fill="url(#sheen)"/>

  <!-- logo em vidro luminoso: sombra → halo → corpo → aresta -->
  ${layer(shadow, OFF, OFF + 18, 0.55)}
  ${layer(glow, OFF, OFF, 0.4)}
  ${layer(bevelDark, OFF + 4, OFF + 6, 0.8)}
  ${layer(base, OFF, OFF, 1)}
  ${layer(base, OFF - 2, OFF - 3, 0.28)}

  <!-- brilho superior + borda de vidro -->
  <rect width="${CANVAS}" height="${CANVAS}" fill="url(#topGloss)"/>
  <rect x="0.5" y="0.5" width="${CANVAS - 1}" height="${CANVAS - 1}" fill="none" stroke="url(#rim)" stroke-width="2"/>
</svg>`;

  fs.writeFileSync('assets/icon-glass.svg', svg);
  await sharp(Buffer.from(svg)).png().toFile('assets/icon-preview.png');
  console.log('icon-glass.svg + icon-preview.png gerados');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
