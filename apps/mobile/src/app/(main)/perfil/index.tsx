/**
 * Perfil 360 — identidade, a tranca do aparelho, e **o que a Xarlote lembra de você**.
 *
 * ## Por que a memória aparece aqui, com a origem de cada item
 *
 * A memória é o que faz a Xarlote parecer que conhece o paciente — e é justamente por
 * isso que ela não pode ser invisível. Cada card mostra se veio de algo que a pessoa
 * DISSE (`self_reported`) ou de algo que nós DEDUZIMOS (`inferred`), porque a diferença
 * importa: uma dedução errada que a pessoa nunca vê é uma dedução que nunca é corrigida.
 * É também a metade legível da portabilidade LGPD — o export completo entra na F4.
 *
 * Apagar conta e exportar dados também são da F4; até lá o caminho é pelo chat
 * ("CONFIRMO APAGAR"), que já funciona e está testado.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, StyleSheet, Switch, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import * as LocalAuthentication from 'expo-local-authentication';
import { Brain, ChevronRight, Fingerprint, LogOut, ShieldCheck, Stethoscope } from 'lucide-react-native';
import { Avatar, GlassBadge, GlassButton, GlassCard, SectionHeader } from '@/components/ui';
import { Screen } from '@/components/xarlote/Screen';
import { useMe } from '@/lib/api/use-me';
import { useOverview } from '@/features/health/use-overview';
import { agruparMemoria } from '@/features/health/overview';
import { rotuloDeVersao } from '@/lib/app-version';
import { brDesde } from '@/lib/br-format';
import { useSession } from '@/lib/auth/session';
import { formatPhonePretty } from '@/lib/phone-input';
import { colors } from '@/theme';

export default function PerfilScreen() {
  const router = useRouter();
  const { user, lockEnabled, setLockEnabled, signOut } = useSession();
  const { data } = useMe();
  const { data: overview } = useOverview();
  const [biometriaDisponivel, setBiometriaDisponivel] = useState(false);
  const [agora] = useState(() => Date.now());

  const gruposMemoria = useMemo(
    () => (overview ? agruparMemoria(overview.memoryCards) : []),
    [overview],
  );

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

      {/*
        A porta pra exportar e apagar. Fica aqui, na seção de Privacidade, e não escondida
        num submenu: a Apple exige que a exclusão de conta seja ACHÁVEL (Review 5.1.1(v)),
        e a LGPD não vale muito se o caminho pro direito for difícil de encontrar.
      */}
      <GlassCard
        style={styles.linha}
        interactive
        onPress={() => router.push('/perfil/privacidade')}
      >
        <View style={styles.linhaEsquerda}>
          <ShieldCheck size={18} color={colors.info} />
          <View style={styles.linhaTexto}>
            <Text style={styles.linhaTitulo}>Meus dados</Text>
            <Text style={styles.linhaHint}>Baixar tudo que eu guardo, ou apagar a conta.</Text>
          </View>
        </View>
        <ChevronRight size={16} color={colors.textFaint} />
      </GlassCard>

      {/*
        O link do médico. Fica logo abaixo de "Meus dados" porque é da mesma família —
        as duas coisas que o paciente faz com o próprio prontuário: levar embora e mostrar.
      */}
      <GlassCard
        style={styles.linha}
        interactive
        onPress={() => router.push('/perfil/compartilhar')}
      >
        <View style={styles.linhaEsquerda}>
          <Stethoscope size={18} color={colors.accentHi} />
          <View style={styles.linhaTexto}>
            <Text style={styles.linhaTitulo}>Mostrar ao meu médico</Text>
            <Text style={styles.linhaHint}>Um link com seu resumo, que expira sozinho.</Text>
          </View>
        </View>
        <ChevronRight size={16} color={colors.textFaint} />
      </GlassCard>

      {/* ── O que eu lembro de você ───────────────────────────────────────── */}
      <SectionHeader
        icon={<Brain size={16} color={colors.accentHi} />}
        title="O que eu lembro de você"
        subtitle={
          gruposMemoria.length > 0
            ? 'tudo isso influencia como eu falo com você'
            : 'ainda estou te conhecendo'
        }
        style={styles.secao}
      />
      {gruposMemoria.length === 0 ? (
        <GlassCard style={styles.memoriaVazia}>
          <Text style={styles.linhaHint}>
            Conforme conversamos, eu guardo o que importa — o que você toma, do que tem
            medo, como prefere ser chamado. Aparece aqui, e você pode me pedir pra
            esquecer qualquer coisa.
          </Text>
        </GlassCard>
      ) : (
        gruposMemoria.map((g) => (
          <View key={g.kind} style={styles.grupoMemoria}>
            <Text style={styles.grupoRotulo}>{g.rotulo}</Text>
            <View style={styles.cardsMemoria}>
              {g.cards.map((c) => (
                <GlassCard key={c.id} style={styles.cardMemoria}>
                  <Text style={styles.memoriaTexto}>{c.text}</Text>
                  <View style={styles.memoriaMeta}>
                    {/* `inferred` é dito com todas as letras: "eu percebi" convida a
                        corrigir; um card sem origem seria lido como fato dado por ele. */}
                    <GlassBadge tone={c.source === 'self_reported' ? 'accent' : 'neutral'} size="xs">
                      {c.source === 'self_reported' ? 'você me disse' : 'eu percebi'}
                    </GlassBadge>
                    {c.last_seen_at ? (
                      <Text style={styles.memoriaQuando}>{brDesde(c.last_seen_at, agora)}</Text>
                    ) : null}
                  </View>
                </GlassCard>
              ))}
            </View>
          </View>
        ))
      )}

      <Text style={styles.avisoMemoria}>
        Quer que eu esqueça algo? Me fala no chat — “esquece que eu…”. Pra apagar tudo,
        é “APAGAR MEUS DADOS”.
      </Text>

      <GlassButton
        variant="ghost"
        size="md"
        onPress={sair}
        style={styles.sair}
        icon={<LogOut size={16} color={colors.textDim} />}
      >
        Sair da conta
      </GlassButton>

      {/*
        Versão do app + id da atualização OTA.
        Não é enfeite: quando um paciente relata um problema, a primeira pergunta é "qual
        versão você tem?" — e com atualização por OTA a versão da loja NÃO responde isso.
        O id do update é o que distingue dois aparelhos com o mesmo binário e JS diferente.
        Vem de `app-version.ts`, que carrega o módulo nativo de forma protegida (leia o
        cabeçalho de lá: o import direto aqui derrubou o app no simulador).
      */}
      <Text style={styles.versao}>{rotuloDeVersao()}</Text>
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
  memoriaVazia: { padding: 16 },
  grupoMemoria: { marginBottom: 18 },
  grupoRotulo: {
    color: colors.textFaint,
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.8,
    textTransform: 'uppercase',
    marginBottom: 8,
  },
  cardsMemoria: { gap: 8 },
  cardMemoria: { padding: 14, gap: 8 },
  memoriaTexto: { color: colors.text, fontSize: 13, lineHeight: 19 },
  memoriaMeta: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  memoriaQuando: { color: colors.textFaint, fontSize: 10 },
  avisoMemoria: { color: colors.textFaint, fontSize: 11, lineHeight: 17, marginTop: 6 },
  versao: { color: 'rgba(255,255,255,0.22)', fontSize: 10, marginTop: 32, textAlign: 'center' },
});
