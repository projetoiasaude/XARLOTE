import { Stack } from 'expo-router';
import { View, StyleSheet } from 'react-native';
import { OrbNav } from '@/components/xarlote/OrbNav';

/**
 * A casca das telas logadas. O OrbNav fica FORA do Stack de propósito: ele é o mesmo
 * orb atravessando as telas, não um componente que remonta a cada navegação — é o
 * que dá a sensação de que a Xarlote está sempre ali, e não que a tela trocou.
 */
export default function MainLayout() {
  return (
    <View style={styles.root}>
      <Stack
        screenOptions={{
          headerShown: false,
          animation: 'fade',
          contentStyle: { backgroundColor: 'transparent' },
        }}
      />
      <OrbNav />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
});
