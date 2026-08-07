import type { ExpoConfig } from 'expo/config';

/**
 * Identidade e build do app Xarlote.
 *
 * Config DINÂMICA (ts, não json) porque no F2 o Firebase entra via EAS secrets
 * (googleServicesFile por env) e as URLs de API variam por canal de build —
 * development aponta pra staging local, preview/production pra Railway.
 *
 * bundle/package `com.iasaude.xarlote`: o MESMO id da casca Capacitor abandonada —
 * o fundador ainda não publicou nada com ele, então herdamos o id sem conflito.
 */
const API_URL = process.env['EXPO_PUBLIC_API_URL'] ?? 'https://ia-da-saude-api-production.up.railway.app';

const config: ExpoConfig = {
  name: 'Xarlote',
  slug: 'xarlote',
  version: '1.0.0',
  scheme: 'xarlote',
  orientation: 'portrait',
  icon: './assets/images/icon.png',
  // Dark SEMPRE: o design system Liquid Glass é dark-only (paridade com o web /app).
  userInterfaceStyle: 'dark',
  backgroundColor: '#04041a',
  ios: {
    bundleIdentifier: 'com.iasaude.xarlote',
    supportsTablet: false,
    infoPlist: {
      // Strings de uso em PT-BR — exigência de revisão da Apple pra app de saúde.
      NSCameraUsageDescription:
        'A câmera é usada pra você fotografar exames e receitas e enviar pra Xarlote guardar no seu histórico de saúde.',
      NSPhotoLibraryUsageDescription:
        'O acesso às fotos permite enviar exames e receitas já salvos no seu aparelho.',
      NSMicrophoneUsageDescription:
        'O microfone é usado pra você mandar mensagens de voz pra Xarlote.',
      NSFaceIDUsageDescription:
        'O Face ID protege o seu histórico de saúde caso outra pessoa pegue o seu celular.',
    },
  },
  android: {
    package: 'com.iasaude.xarlote',
    adaptiveIcon: {
      backgroundColor: '#04041a',
      foregroundImage: './assets/images/android-icon-foreground.png',
      monochromeImage: './assets/images/android-icon-monochrome.png',
    },
    permissions: ['android.permission.RECORD_AUDIO', 'android.permission.POST_NOTIFICATIONS'],
  },
  plugins: [
    'expo-router',
    'expo-secure-store',
    [
      'expo-splash-screen',
      {
        backgroundColor: '#04041a',
        image: './assets/images/splash-icon.png',
        imageWidth: 160,
      },
    ],
    [
      'expo-build-properties',
      {
        // Preparado pro @react-native-firebase (F2): o SDK iOS do Firebase exige
        // frameworks estáticos. Ligar desde já evita um rebuild de config depois.
        ios: { useFrameworks: 'static' },
      },
    ],
  ],
  experiments: {
    typedRoutes: true,
    reactCompiler: true,
  },
  extra: {
    apiUrl: API_URL,
  },
};

export default config;
