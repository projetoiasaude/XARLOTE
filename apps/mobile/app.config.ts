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
  /**
   * Conta dona do projeto no EAS. Fixado porque a sessão do fundador tem DUAS contas
   * (`xarlote` e `xarlote.ai`) — sem isto, um build pode resolver pra conta errada e
   * criar um projeto paralelo, com outro histórico de versões e outras credenciais.
   */
  owner: 'xarlote.ai',
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
  /**
   * OTA (expo-updates) — a promessa central do plano: tudo que é JS/TS pode ser
   * corrigido em minutos, sem passar por revisão da Apple. Num app de saúde isso é
   * segurança, não conveniência: um bug numa tela de medicação não pode esperar
   * cinco dias de fila da App Store.
   *
   * `fallbackToCacheTimeout: 0` — o boot NUNCA espera a rede. A atualização baixa
   * em segundo plano e vale na abertura seguinte. O contrário (esperar o download
   * na splash) transformaria rede ruim de ônibus em app que não abre.
   */
  updates: {
    url: 'https://u.expo.dev/49761909-0aa3-49e1-98e9-bdb70809f965',
    fallbackToCacheTimeout: 0,
  },
  /**
   * `fingerprint`, e não `appVersion`: a versão de runtime é derivada do código
   * NATIVO do projeto. É o que impede o acidente clássico de OTA — publicar um JS
   * que chama um módulo nativo (Firebase, câmera) num binário que não o tem, e o
   * app fechar na cara do paciente. Com fingerprint, esse update simplesmente não
   * é oferecido àquele binário; com `appVersion`, seria.
   */
  runtimeVersion: { policy: 'fingerprint' },
  experiments: {
    typedRoutes: true,
    reactCompiler: true,
  },
  extra: {
    apiUrl: API_URL,
    /**
     * Projeto no EAS, criado em 11/08/2026.
     *
     * Escrito à MÃO de propósito: o `eas init` sabe gravar isto sozinho em `app.json`,
     * mas não em config dinâmica (`app.config.ts`) — ele não reescreve TypeScript. Se
     * este id sumir, o build passa a reclamar de projeto não vinculado.
     */
    eas: {
      projectId: '49761909-0aa3-49e1-98e9-bdb70809f965',
    },
  },
};

export default config;
