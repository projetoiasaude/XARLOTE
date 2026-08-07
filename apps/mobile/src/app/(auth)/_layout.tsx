import { Stack } from 'expo-router';

/**
 * Fluxo de entrada. Sem header e com fundo transparente — quem desenha o fundo é o
 * `_layout` raiz (o aurora tem que atravessar as telas sem recomeçar a cada push).
 */
export default function AuthLayout() {
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        animation: 'slide_from_right',
        contentStyle: { backgroundColor: 'transparent' },
      }}
    />
  );
}
