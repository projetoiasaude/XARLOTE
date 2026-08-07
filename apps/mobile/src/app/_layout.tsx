/**
 * A casca do app. Providers, o fundo aurora e — o mais importante — a guarda de
 * rota, que é UMA só e vive aqui.
 *
 * Guarda por tela é como nasce loop de redirecionamento. Aqui existe um único
 * `useEffect` comparando "onde o paciente está" com o que `decideGate` diz que
 * deveria estar. Uma comparação, um `replace`, nenhum pisca-pisca.
 */
import { useEffect } from 'react';
import { StatusBar } from 'expo-status-bar';
import { DarkTheme, Slot, ThemeProvider, useRouter, useSegments } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
import { StyleSheet, View } from 'react-native';
import { XarloteBackground } from '@/components/xarlote/XarloteBackground';
import { SessionProvider, useSession } from '@/lib/auth/session';
import { GATE_ROUTE, type AuthGate } from '@/lib/auth/route-decision';
import { queryClient, queryPersister } from '@/lib/query';
import { runSharedSmoke } from '@/lib/shared-smoke';

void SplashScreen.preventAutoHideAsync();

// O portão do Hermes roda uma vez, no arranque, só em desenvolvimento. Ele existe
// pra descobrir divergência de engine AQUI e não num lembrete errado do paciente.
if (__DEV__) runSharedSmoke();

/**
 * Tema do react-navigation com fundo TRANSPARENTE.
 *
 * Sem isto o navigator pinta o `colors.background` do tema padrão — que é BRANCO —
 * por cima do aurora, e o app inteiro fica claro com texto branco invisível.
 * `contentStyle: 'transparent'` nos Stacks não basta: ele vale pra cena, não pro
 * contêiner do navegador.
 */
const TEMA_XARLOTE = {
  ...DarkTheme,
  colors: {
    ...DarkTheme.colors,
    background: 'transparent',
    card: 'transparent',
    border: 'rgba(255,255,255,0.09)',
    primary: '#7c87ff',
    text: 'rgba(255,255,255,0.92)',
  },
};

/** Em qual porta o paciente está AGORA, lido da rota. */
function currentGate(segments: string[]): Exclude<AuthGate, 'loading'> {
  if (segments[0] === 'lock') return 'lock';
  if (segments[0] === '(auth)') return segments[1] === 'consent' ? 'consent' : 'auth';
  return 'app';
}

function GateGuard() {
  const { gate } = useSession();
  const segments = useSegments();
  const router = useRouter();

  // Rede de segurança da splash. Ela só sai quando a rota bate com a porta decidida —
  // o que é certo pra não piscar a tela errada, mas transforma qualquer engano nessa
  // conta num app PARADO na splash pra sempre. Depois de 4s, sai de qualquer jeito:
  // uma tela errada por um instante é ruim; um app que não abre é fatal.
  useEffect(() => {
    const id = setTimeout(() => void SplashScreen.hideAsync(), 4000);
    return () => clearTimeout(id);
  }, []);

  useEffect(() => {
    if (gate === 'loading') return;
    // `welcome` e `otp` são duas telas da MESMA porta ('auth') — trocar entre elas
    // não pode disparar redirecionamento, senão o paciente nunca chega no código.
    const atual = currentGate(segments as string[]);
    if (gate !== atual) {
      router.replace(GATE_ROUTE[gate] as never);
      return;
    }
    // A splash só sai quando a rota JÁ é a certa. Escondê-la antes deixa aparecer
    // um quadro da tela errada (o app monta '/' antes de a guarda redirecionar).
    void SplashScreen.hideAsync();
  }, [gate, segments, router]);

  return <Slot />;
}

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={styles.root}>
      <SafeAreaProvider>
        <PersistQueryClientProvider client={queryClient} persistOptions={{ persister: queryPersister }}>
          <SessionProvider>
            <ThemeProvider value={TEMA_XARLOTE}>
              <View style={styles.root}>
                {/* Fundo primeiro, conteúdo por cima: nenhuma tela precisa desenhar o seu. */}
                <XarloteBackground />
                <StatusBar style="light" />
                <GateGuard />
              </View>
            </ThemeProvider>
          </SessionProvider>
        </PersistQueryClientProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#04041a' },
});
