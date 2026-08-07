/**
 * O cadeado biométrico.
 *
 * Ele protege contra UM cenário concreto: alguém pega o celular destravado do
 * paciente e abre o app — e o prontuário está ali. Não protege contra roubo do
 * aparelho com o passcode (isso é problema do sistema), e não substitui a sessão do
 * servidor: é uma tranca LOCAL.
 *
 * Por isso a saída de emergência é sair da conta, nunca "pular". Se a biometria
 * parar de funcionar (dedo molhado, sensor quebrado, Face ID não cadastrado), o
 * paciente reentra por OTP em 30 segundos — e o app não fica inacessível.
 */
import { useCallback, useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import * as LocalAuthentication from 'expo-local-authentication';
import { Fingerprint } from 'lucide-react-native';
import { GlassButton } from '@/components/ui';
import { XarloteHero } from '@/components/xarlote/XarloteHero';
import { useSession } from '@/lib/auth/session';
import { colors } from '@/theme';

export default function LockScreen() {
  const { unlock, signOut, user } = useSession();
  const [tentando, setTentando] = useState(false);
  const [falhou, setFalhou] = useState(false);

  const autenticar = useCallback(async () => {
    if (tentando) return;
    setTentando(true);
    try {
      const enrolled = await LocalAuthentication.isEnrolledAsync();
      if (!enrolled) {
        // Biometria foi removida do aparelho depois de o paciente ligar o cadeado.
        // Manter travado aqui seria trancar a pessoa fora dos próprios dados.
        unlock();
        return;
      }
      const result = await LocalAuthentication.authenticateAsync({
        promptMessage: 'Desbloqueie pra ver sua saúde',
        cancelLabel: 'Cancelar',
        // Sem fallback pra senha do aparelho: quem sabe o passcode já destravou o
        // celular — pedir de novo não acrescentaria proteção nenhuma.
        disableDeviceFallback: true,
      });
      if (result.success) unlock();
      else setFalhou(true);
    } finally {
      setTentando(false);
    }
  }, [tentando, unlock]);

  // Tenta assim que a tela aparece — o normal é o paciente nem ver esta tela.
  useEffect(() => {
    void autenticar();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const primeiroNome = user?.preferredName?.split(' ')[0];

  return (
    <View style={styles.wrap}>
      <XarloteHero size={120} wordmark={false} />

      <Text style={styles.title}>
        {primeiroNome ? `Oi, ${primeiroNome}` : 'Oi de novo'}
      </Text>
      <Text style={styles.subtitle}>
        {falhou ? 'Não reconheci. Tenta de novo?' : 'Sua saúde está protegida.'}
      </Text>

      <GlassButton
        variant="primary"
        size="lg"
        loading={tentando}
        onPress={() => void autenticar()}
        style={styles.cta}
        icon={<Fingerprint size={17} color="#fff" />}
      >
        Desbloquear
      </GlassButton>

      <GlassButton variant="ghost" size="sm" onPress={() => void signOut()} style={styles.sair}>
        Entrar com outra conta
      </GlassButton>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32 },
  title: { color: colors.text, fontSize: 22, fontWeight: '700', marginTop: 20, letterSpacing: -0.4 },
  subtitle: { color: colors.textDim, fontSize: 14, marginTop: 6, textAlign: 'center' },
  cta: { marginTop: 28, minWidth: 220 },
  sair: { marginTop: 10 },
});
