/**
 * Perfil — a única tela logada que já é REAL nesta etapa, porque tudo o que ela faz
 * é fundação: quem está logado, a tranca biométrica e a saída da conta.
 *
 * O resto do perfil 360 (memória, preferências, sessões, exportar, apagar conta)
 * entra em F3/F4.
 */
import { useCallback, useEffect, useState } from 'react';
import { Alert, StyleSheet, Switch, Text, View } from 'react-native';
import * as LocalAuthentication from 'expo-local-authentication';
import { Fingerprint, LogOut } from 'lucide-react-native';
import { Avatar, GlassButton, GlassCard, SectionHeader } from '@/components/ui';
import { Screen } from '@/components/xarlote/Screen';
import { useMe } from '@/lib/api/use-me';
import { useSession } from '@/lib/auth/session';
import { formatPhonePretty } from '@/lib/phone-input';
import { colors } from '@/theme';

export default function PerfilScreen() {
  const { user, lockEnabled, setLockEnabled, signOut } = useSession();
  const { data } = useMe();
  const [biometriaDisponivel, setBiometriaDisponivel] = useState(false);

  useEffect(() => {
    void (async () => {
      const [tem, cadastrada] = await Promise.all([
        LocalAuthentication.hasHardwareAsync(),
        LocalAuthentication.isEnrolledAsync(),
      ]);
      setBiometriaDisponivel(tem && cadastrada);
    })();
  }, []);

  const alternarCadeado = useCallback(
    async (ligar: boolean) => {
      if (ligar) {
        // Confirma o dedo ANTES de ligar. Sem isso dá pra trancar o app com uma
        // biometria que não funciona — e aí o dono não entra mais nos próprios dados.
        const r = await LocalAuthentication.authenticateAsync({
          promptMessage: 'Confirma pra ligar o bloqueio',
          disableDeviceFallback: true,
        });
        if (!r.success) return;
      }
      await setLockEnabled(ligar);
    },
    [setLockEnabled],
  );

  const sair = useCallback(() => {
    Alert.alert('Sair da conta?', 'Seus dados continuam guardados. É só entrar de novo com o WhatsApp.', [
      { text: 'Ficar', style: 'cancel' },
      {
        text: 'Sair',
        style: 'destructive',
        // O signOut já limpa o cache de dado clínico — não é responsabilidade da tela.
        onPress: () => void signOut(),
      },
    ]);
  }, [signOut]);

  const nome = data?.user.preferredName ?? data?.user.fullName ?? user?.preferredName ?? null;
  const telefone = data?.user.phoneE164 ?? user?.phoneE164 ?? '';

  return (
    <Screen title="Perfil">
      <GlassCard style={styles.identidade}>
        <Avatar name={nome ?? telefone} size="lg" />
        <View style={styles.identidadeTexto}>
          <Text style={styles.nome}>{nome ?? 'Sem nome ainda'}</Text>
          <Text style={styles.telefone}>{formatPhonePretty(telefone)}</Text>
        </View>
      </GlassCard>

      <SectionHeader
        title="Privacidade"
        subtitle="quem pode abrir o app neste aparelho"
        style={styles.secao}
      />

      <GlassCard style={styles.linha}>
        <View style={styles.linhaEsquerda}>
          <Fingerprint size={18} color={colors.accentHi} />
          <View style={styles.linhaTexto}>
            <Text style={styles.linhaTitulo}>Bloqueio por biometria</Text>
            <Text style={styles.linhaHint}>
              {biometriaDisponivel
                ? 'Pede o dedo ou o rosto ao abrir o app.'
                : 'Cadastre Face ID ou digital no aparelho pra usar isto.'}
            </Text>
          </View>
        </View>
        <Switch
          value={lockEnabled}
          disabled={!biometriaDisponivel}
          onValueChange={(v) => void alternarCadeado(v)}
          trackColor={{ false: 'rgba(255,255,255,0.12)', true: 'rgba(124,135,255,0.6)' }}
          thumbColor="#ffffff"
        />
      </GlassCard>

      <GlassButton
        variant="ghost"
        size="md"
        onPress={sair}
        style={styles.sair}
        icon={<LogOut size={16} color={colors.textDim} />}
      >
        Sair da conta
      </GlassButton>
    </Screen>
  );
}

const styles = StyleSheet.create({
  identidade: { flexDirection: 'row', alignItems: 'center', gap: 14, padding: 16 },
  identidadeTexto: { flexShrink: 1 },
  nome: { color: colors.text, fontSize: 17, fontWeight: '600' },
  telefone: { color: colors.textDim, fontSize: 13, marginTop: 2 },
  secao: { marginTop: 28, marginBottom: 12 },
  linha: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: 16 },
  linhaEsquerda: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, flexShrink: 1 },
  linhaTexto: { flexShrink: 1 },
  linhaTitulo: { color: colors.text, fontSize: 14, fontWeight: '500' },
  linhaHint: { color: colors.textFaint, fontSize: 11, marginTop: 2, lineHeight: 16 },
  sair: { marginTop: 28, alignSelf: 'flex-start' },
});
