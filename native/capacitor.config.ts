import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Config da casca nativa da Xarlote.
 *
 * ESTRATÉGIA: `server.url` aponta pro app web JÁ PUBLICADO no Vercel. A casca
 * nativa é fina — ela carrega o site de produção dentro do webview e injeta os
 * plugins nativos (push, status bar, botão voltar). Vantagens:
 *   - Toda atualização do web aparece NA HORA no app, sem reenviar pra loja.
 *   - Um código só (o Next.js) roda no navegador, no PWA e no app nativo.
 * O `webDir` (public/) só tem uma tela offline de cortesia — quase nunca usada,
 * já que o app é online por natureza.
 *
 * Se um dia quiser empacotar o web DENTRO do app (offline-first), troca-se
 * server.url por um `next export` copiado pra webDir — o resto continua igual.
 */
const config: CapacitorConfig = {
  appId: 'com.iasaude.xarlote',
  appName: 'Xarlote',
  webDir: 'public',
  server: {
    url: 'https://web-jade-ten-53.vercel.app/app',
    cleartext: false,
  },
  backgroundColor: '#04041a',
  ios: {
    contentInset: 'always',
    backgroundColor: '#04041a',
  },
  android: {
    backgroundColor: '#04041a',
  },
  plugins: {
    PushNotifications: {
      presentationOptions: ['badge', 'sound', 'alert'],
    },
  },
};

export default config;
