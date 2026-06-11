import type { MetadataRoute } from 'next';

// PWA do Xarlote App — escopado em /app (o dashboard continua app web normal).
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Xarlote — agente de saúde 360',
    short_name: 'Xarlote',
    description:
      'A Xarlote cuida da sua saúde: conversa, lembra dos remédios, compra na farmácia e marca consultas por você.',
    id: '/app',
    start_url: '/app',
    scope: '/app',
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#04041a',
    theme_color: '#04041a',
    icons: [
      { src: '/xarlote-icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/xarlote-icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/xarlote-icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      { src: '/xarlote-icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
    ],
  };
}
