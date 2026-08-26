/**
 * Perfil — "quem sou eu, e quem manda nos meus dados?"
 *
 * ## A tela cabe numa tela — e a conta foi feita, não estimada
 *
 * A versão anterior desenhava os até 80 memory cards aqui dentro, um cartão de vidro
 * cada, e por isso o botão "Sair da conta" ficava no fim de uma rolagem que crescia com o
 * tempo de uso do paciente. Agora são: a identidade (editável), TRÊS linhas de controle,
 * a memória atrás de UM cabeçalho recolhido com contador, e sair.
 *
 * A primeira tentativa de recolher ainda não cabia: o bloco de memória abria com o seu
 * próprio cabeçalho, o campo de busca e QUATRO subseções, ~370pt entre a última linha de
 * privacidade e o "Sair da conta" — que voltava pra fora do viewport de um Android
 * intermediário (~740–800pt). Somando as alturas declaradas hoje: 105 de topo + 76 da
 * identidade + 79 do cabeçalho de seção + 234 das três linhas + 92 da memória recolhida +
 * 84 do sair ≈ 670. Sair fica visível sem rolagem; a memória continua a um toque, e
 * aberta ela rola — o que rola é o acervo, nunca o controle da conta.
 *
 * ## O que saiu de texto morto
 *
 * O rodapé antigo mandava resolver duas coisas no chat que esta mesma tela já resolve uma
 * polegada acima ("Meus dados"), e anunciava uma frase mágica que não é a frase
 * ("APAGAR MEUS DADOS" — o app pede "APAGAR MINHA CONTA", e o chat pede "CONFIRMO
 * APAGAR"). Quem seguisse a instrução digitava no WhatsApp, recebia um pedido de OUTRA
 * frase, e concluía que apagar dados é difícil de propósito — exatamente o dano que a
 * tela de privacidade foi construída pra evitar.
 *
 * ## Por que o Perfil re-pergunta quem você é ao voltar
 *
 * O nome é gravado pela Xarlote, no chat (ver `features/profile/nome.ts`). Quem pede a
 * mudança sai desta tela pro chat e volta — e as abas do expo-router ficam MONTADAS, então
 * sem invalidar `me` no foco o paciente voltaria e veria o nome antigo, concluindo que o
 * pedido não pegou.
 */
import { useCallback, useEffect, useState } from 'react';
import { Alert, RefreshControl, StyleSheet, Switch, Text, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import * as LocalAuthentication from 'expo-local-authentication';
import { useQueryClient } from '@tanstack/react-query';
import { ChevronRight, Fingerprint, LogOut, ShieldCheck, Stethoscope, HeartHandshake} from 'lucide-react-native';
import { GlassCard, LoadFailure, SectionHeader } from '@/components/ui';
import { Screen } from '@/components/xarlote/Screen';
import { useMe } from '@/lib/api/use-me';
import { useAgora } from '@/features/health/use-agora';
import { CartaoIdentidade } from '@/features/profile/CartaoIdentidade';
import { BlocoMemoria } from '@/features/profile/BlocoMemoria';
import { useMemoria } from '@/features/profile/use-memoria';
import { rotuloDeVersao } from '@/lib/app-version';
import { useSession } from '@/lib/auth/session';
import { colors, FONTE_CLINICA, FONTE_MINIMA } from '@/theme';

export default function PerfilScreen() {
  const router = useRouter();
  const qc = useQueryClient();
  const { user, lockEnabled, setLockEnabled, signOut } = useSession();
  const { data } = useMe();
  const memoria = useMemoria();
  const agora = useAgora();
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

  // Voltou do chat (talvez com o nome novo): re-pergunta quem é. É a chamada mais barata
  // do app — só identidade e flags, sem prontuário.
  useFocusEffect(
    useCallback(() => {
      void qc.invalidateQueries({ predicate: (q) => q.queryKey[0] === 'me' });
    }, [qc]),
  );

  const alternarCadeado = useCallback(
    async (ligar: boolean) => {
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
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

  const atualizar = useCallback(() => {
    memoria.recarregar();
    void qc.invalidateQueries({ predicate: (q) => q.queryKey[0] === 'me' });
    // Háptico no FIM do gesto: é o que diz "acabei", num gesto que não tem outro fim
    // visível quando nada mudou.
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  }, [memoria, qc]);

  const nome = data?.user.preferredName ?? data?.user.fullName ?? user?.preferredName ?? null;
  const telefone = data?.user.phoneE164 ?? user?.phoneE164 ?? '';
  // Sem resposta do `/me` ainda, assume LIGADA: o pessimismo aqui esconderia o único
  // caminho de editar o nome por causa de meio segundo de rede.
  const xarloteLigada = data?.flags.xarloteEnabled !== false;

  return (
    <Screen
      title="Perfil"
      refreshControl={
        <RefreshControl
          refreshing={memoria.recarregando}
          onRefresh={atualizar}
          tintColor={colors.accentHi}
          colors={[colors.accentHi]}
        />
      }
    >
      <CartaoIdentidade nome={nome} telefone={telefone} xarloteLigada={xarloteLigada} />

      <SectionHeader
        title="Privacidade e dados"
        subtitle="quem abre este app, e o que sai dele"
        style={styles.secao}
      />

      {/*
        A linha inteira é o interruptor.

        O `Switch` sozinho tem ~31pt de alvo, abaixo do piso de 44 — e é o controle que
        tranca o prontuário de alguém. Com `pointerEvents="none"` ele passa a ser só o
        INDICADOR: quem recebe o toque é a linha de 68pt. Isso também elimina o risco de
        toque duplo (linha + switch disparando a mesma troca).
      */}
      <GlassCard
        style={styles.linha}
        {...(biometriaDisponivel ? { onPress: () => void alternarCadeado(!lockEnabled) } : {})}
      >
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
        <View pointerEvents="none">
          <Switch
            value={lockEnabled}
            disabled={!biometriaDisponivel}
            trackColor={{ false: 'rgba(255,255,255,0.12)', true: 'rgba(124,135,255,0.6)' }}
            thumbColor={colors.textOnFill}
          />
        </View>
      </GlassCard>

      {/*
        A porta pra exportar e apagar. Fica aqui, na seção de Privacidade, e não escondida
        num submenu: a Apple exige que a exclusão de conta seja ACHÁVEL (Review 5.1.1(v)),
        e a LGPD não vale muito se o caminho pro direito for difícil de encontrar.
      */}
      <GlassCard style={styles.linha} onPress={() => router.push('/perfil/privacidade')}>
        <View style={styles.linhaEsquerda}>
          <ShieldCheck size={18} color={colors.info} />
          <View style={styles.linhaTexto}>
            <Text style={styles.linhaTitulo}>Meus dados</Text>
            <Text style={styles.linhaHint}>Baixar tudo que eu guardo, ou apagar a conta.</Text>
          </View>
        </View>
        <ChevronRight size={18} color={colors.textDim} />
      </GlassCard>

      {/*
        O link do médico. Fica logo abaixo de "Meus dados" porque é da mesma família —
        as duas coisas que o paciente faz com o próprio prontuário: levar embora e mostrar.
      */}
      <GlassCard style={styles.linha} onPress={() => router.push('/perfil/compartilhar')}>
        <View style={styles.linhaEsquerda}>
          <Stethoscope size={18} color={colors.accentHi} />
          <View style={styles.linhaTexto}>
            <Text style={styles.linhaTitulo}>Mostrar ao meu médico</Text>
            <Text style={styles.linhaHint}>Um link com seu resumo, que expira sozinho.</Text>
          </View>
        </View>
        <ChevronRight size={18} color={colors.textDim} />
      </GlassCard>

      {/*
        Cuidar de alguém fica JUNTO das outras duas: levar embora, mostrar ao médico e
        dividir com quem cuida são a mesma família de decisão — quem mais, além de mim,
        toca no meu prontuário.
      */}
      <GlassCard style={styles.linha} onPress={() => router.push('/perfil/cuidar')}>
        <View style={styles.linhaEsquerda}>
          <HeartHandshake size={18} color={colors.accentHi} />
          <View style={styles.linhaTexto}>
            <Text style={styles.linhaTitulo}>Cuidar de alguém</Text>
            <Text style={styles.linhaHint}>Acompanhe a saúde de quem você cuida — e veja quem acompanha a sua.</Text>
          </View>
        </View>
        <ChevronRight size={18} color={colors.textDim} />
      </GlassCard>

      {/*
        Erro NÃO é vazio.

        Se o overview falhou, desenhar as seções de memória com contador zero afirmaria
        que a Xarlote não lembra de nada — no lugar onde essa afirmação é mais assustadora.
        Falha vira tela de falha, com o motivo separado (rede x servidor) e um botão.
      */}
      {memoria.erro && memoria.cards.length === 0 ? (
        <View style={styles.blocoFalha}>
          <LoadFailure
            erro={memoria.erro}
            onTentarDeNovo={memoria.recarregar}
            oQue="o que eu lembro de você"
            tentando={memoria.recarregando}
          />
        </View>
      ) : memoria.carregando ? (
        // Sem shimmer: um esqueleto varrendo degradê é animação de fundo justamente
        // quando a rede está ruim. Uma linha parada diz a mesma coisa e custa zero.
        <Text style={styles.carregando}>Abrindo minhas anotações sobre você…</Text>
      ) : (
        <BlocoMemoria cards={memoria.cards} resumo={memoria.resumo} agoraMs={agora} />
      )}

      <GlassCard style={styles.linhaSair} onPress={sair}>
        <LogOut size={18} color={colors.textDim} />
        <Text style={styles.sairTexto}>Sair da conta</Text>
      </GlassCard>

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
  secao: { marginTop: 28, marginBottom: 12 },
  linha: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    padding: 16,
    minHeight: 68,
    marginBottom: 10,
  },
  linhaEsquerda: { flexDirection: 'row', alignItems: 'center', gap: 12, flexShrink: 1 },
  linhaTexto: { flexShrink: 1, gap: 2 },
  linhaTitulo: { color: colors.text, fontSize: 15, fontWeight: '500' },
  /** 12 é o piso; este texto explica um controle, então não desce mais. */
  linhaHint: { color: colors.textDim, fontSize: FONTE_MINIMA, lineHeight: 17 },
  blocoFalha: { marginTop: 28 },
  carregando: { color: colors.textDim, fontSize: FONTE_CLINICA, marginTop: 28 },
  /** Sair é uma linha como as outras — 44pt garantidos, e não um `<Text>` no rodapé. */
  linhaSair: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 16,
    minHeight: 56,
    marginTop: 28,
  },
  sairTexto: { color: colors.textDim, fontSize: 15, fontWeight: '500' },
  versao: { color: colors.textDim, fontSize: FONTE_MINIMA, marginTop: 24, textAlign: 'center' },
});
