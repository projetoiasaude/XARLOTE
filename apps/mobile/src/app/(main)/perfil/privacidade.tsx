/**
 * Privacidade e dados — exportar tudo, e apagar a conta.
 *
 * ## Esta tela é obrigatória para publicar
 *
 * A Apple exige exclusão de conta DENTRO do app (Review 5.1.1(v)); a LGPD exige exclusão
 * e portabilidade a pedido do titular (art. 18). Até aqui o caminho era só pelo chat, o
 * que funciona e não satisfaz nenhuma das duas.
 *
 * ## A assimetria entre os dois botões é deliberada
 *
 * Exportar é reversível e barato: um toque. Apagar é irreversível, então pede a frase
 * digitada — o mesmo pedágio de atenção do "CONFIRMO APAGAR" do WhatsApp. Um botão
 * "apagar minha conta" sozinho, numa tela que alguém abre pra mexer na biometria, é
 * fácil demais de tocar por engano.
 *
 * ## E a tela DIZ o que sobrevive
 *
 * O registro de consentimento e o log de acessos ficam — são a prova de que o apagamento
 * foi pedido e cumprido, e a lei espera que existam. Dizer "apagamos tudo" e guardar
 * essas duas coisas sem avisar seria a mentira mais fácil de contar aqui.
 */
import { useCallback, useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { ArrowLeft, Download, FileJson, ShieldCheck, Trash2 } from 'lucide-react-native';
import { GlassBadge, GlassButton, GlassCard, GlassInput, SectionHeader } from '@/components/ui';
import { Screen } from '@/components/xarlote/Screen';
import { useApagarConta, useExportarDados } from '@/features/account/use-account';
import { colors, radii } from '@/theme';

/** Tem que casar com `FRASE_CONFIRMACAO` em apps/api/src/routes/app/account.ts. */
const FRASE = 'APAGAR MINHA CONTA';

export default function PrivacidadeScreen() {
  const router = useRouter();
  const exportar = useExportarDados();
  const apagarConta = useApagarConta();
  const [confirmacao, setConfirmacao] = useState('');
  const [mostrarApagar, setMostrarApagar] = useState(false);

  const frasePronta = confirmacao.trim().toUpperCase() === FRASE;

  const baixar = useCallback(() => {
    if (exportar.url) void WebBrowser.openBrowserAsync(exportar.url);
  }, [exportar.url]);

  const confirmarApagamento = useCallback(() => {
    Alert.alert(
      'Apagar a conta agora?',
      'Isso não tem volta. Seu histórico, seus lembretes, seus exames e o que eu aprendi ' +
        'sobre você deixam de existir.',
      [
        { text: 'Não apagar', style: 'cancel' },
        { text: 'Apagar', style: 'destructive', onPress: () => apagarConta.apagar(confirmacao) },
      ],
    );
  }, [apagarConta, confirmacao]);

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <Screen title="Privacidade e dados">
        <Pressable onPress={() => router.back()} hitSlop={12} style={styles.voltar} accessibilityRole="button">
          <ArrowLeft size={14} color={colors.textDim} />
          <Text style={styles.voltarTexto}>voltar</Text>
        </Pressable>

        {/* ── Exportar ──────────────────────────────────────────────────────── */}
        <SectionHeader
          icon={<FileJson size={16} color={colors.info} />}
          title="Baixar meus dados"
          subtitle="tudo que eu guardo sobre você, num arquivo"
          style={styles.secao}
        />
        <GlassCard style={styles.card}>
          <Text style={styles.corpo}>
            Eu monto um arquivo com o seu cadastro, o histórico de saúde, os exames, os
            lembretes, <Text style={styles.enfase}>todas as mensagens</Text> que trocamos, e
            o que eu aprendi sobre você conversando. Você pode guardar ou entregar ao seu
            médico.
          </Text>

          {exportar.status === 'ready' && exportar.url ? (
            <>
              <GlassBadge tone="success" size="xs" style={styles.badge}>
                pronto
              </GlassBadge>
              <GlassButton
                variant="primary"
                size="md"
                onPress={baixar}
                icon={<Download size={16} color="#fff" />}
              >
                Baixar o arquivo
              </GlassButton>
              {/* O link é o prontuário em texto puro: dizer que ele expira explica por que
                  o paciente não deve guardá-lo, e sim o arquivo. */}
              <Text style={styles.rodapeCard}>
                O link vale por 10 minutos, por segurança. Depois disso é só pedir de novo.
              </Text>
            </>
          ) : exportar.desistiu ? (
            <>
              <Text style={styles.aviso}>
                Está demorando mais do que devia. Pede de novo, e se continuar assim me
                chama no WhatsApp.
              </Text>
              <GlassButton variant="secondary" size="md" onPress={exportar.pedir}>
                Tentar de novo
              </GlassButton>
            </>
          ) : exportar.status === 'failed' ? (
            <>
              <Text style={styles.aviso}>Algo falhou ao preparar o arquivo.</Text>
              <GlassButton variant="secondary" size="md" onPress={exportar.pedir}>
                Tentar de novo
              </GlassButton>
            </>
          ) : exportar.status === 'pending' ? (
            <View style={styles.linhaStatus}>
              <GlassBadge tone="accent" size="xs" dot>
                preparando
              </GlassBadge>
              <Text style={styles.rodapeCard}>Pode fechar o app — quando voltar, estará aqui.</Text>
            </View>
          ) : (
            <GlassButton
              variant="secondary"
              size="md"
              onPress={exportar.pedir}
              loading={exportar.pedindo}
              icon={<FileJson size={16} color={colors.textDim} />}
            >
              Preparar meu arquivo
            </GlassButton>
          )}

          {exportar.erro ? <Text style={styles.aviso}>{exportar.erro}</Text> : null}
        </GlassCard>

        {/* ── O que sobrevive ───────────────────────────────────────────────── */}
        <SectionHeader
          icon={<ShieldCheck size={16} color={colors.success} />}
          title="O que eu guardo mesmo depois"
          style={styles.secao}
        />
        <GlassCard style={styles.card}>
          <Text style={styles.corpo}>
            Se você apagar a conta, duas coisas ficam — e é a lei que pede: o
            <Text style={styles.enfase}> registro de quando você aceitou</Text> o uso dos
            seus dados, e o <Text style={styles.enfase}>registro do próprio apagamento</Text>.
            Nenhum dos dois contém histórico clínico, mensagem ou telefone: só a data e o
            fato de ter acontecido.
          </Text>
        </GlassCard>

        {/* ── Apagar ────────────────────────────────────────────────────────── */}
        <SectionHeader
          icon={<Trash2 size={16} color={colors.danger} />}
          title="Apagar minha conta"
          subtitle="irreversível"
          style={styles.secao}
        />
        <GlassCard style={[styles.card, styles.cardPerigo]}>
          <Text style={styles.corpo}>
            Apaga o seu cadastro, o histórico de saúde, os exames, os lembretes, as
            mensagens e o que eu aprendi sobre você. Encerra a sessão neste e em qualquer
            outro aparelho, e derruba os links que você tenha dado a algum médico.
          </Text>

          {!mostrarApagar ? (
            <GlassButton
              variant="ghost"
              size="md"
              onPress={() => setMostrarApagar(true)}
              icon={<Trash2 size={16} color={colors.danger} />}
              textStyle={styles.textoPerigo}
            >
              Quero apagar minha conta
            </GlassButton>
          ) : (
            <>
              <Text style={styles.instrucao}>
                Pra confirmar, digite <Text style={styles.frase}>{FRASE}</Text> abaixo.
              </Text>
              <GlassInput
                value={confirmacao}
                onChangeText={setConfirmacao}
                placeholder={FRASE}
                autoCapitalize="characters"
                autoCorrect={false}
              />
              <GlassButton
                variant="primary"
                size="md"
                // O botão só liga quando a frase confere — e enquanto não confere, a
                // instrução acima explica o que falta. Botão desabilitado sem explicação
                // é o defeito que já apareceu na tela de login (o número fixo recusado
                // em silêncio).
                disabled={!frasePronta || apagarConta.apagando}
                loading={apagarConta.apagando}
                onPress={confirmarApagamento}
                style={frasePronta ? styles.botaoPerigo : undefined}
              >
                Apagar minha conta
              </GlassButton>
              <GlassButton variant="ghost" size="sm" onPress={() => { setMostrarApagar(false); setConfirmacao(''); }}>
                Deixa pra depois
              </GlassButton>
            </>
          )}

          {apagarConta.erro ? <Text style={styles.aviso}>{apagarConta.erro}</Text> : null}
        </GlassCard>

        <Text style={styles.rodape}>
          Qualquer dúvida sobre seus dados, me chama no WhatsApp. Você também pode pedir as
          duas coisas por lá.
        </Text>
      </Screen>
    </>
  );
}

const styles = StyleSheet.create({
  voltar: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 8, alignSelf: 'flex-start' },
  voltarTexto: { color: colors.textDim, fontSize: 13 },
  secao: { marginTop: 24, marginBottom: 12 },
  card: { padding: 16, gap: 14 },
  cardPerigo: { borderColor: 'rgba(248,113,113,0.22)', backgroundColor: 'rgba(248,113,113,0.04)' },
  corpo: { color: colors.textDim, fontSize: 13, lineHeight: 20 },
  enfase: { color: colors.text, fontWeight: '600' },
  badge: { alignSelf: 'flex-start' },
  linhaStatus: { flexDirection: 'row', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
  instrucao: { color: colors.textDim, fontSize: 12, lineHeight: 18 },
  frase: { color: colors.danger, fontWeight: '700', letterSpacing: 0.3 },
  botaoPerigo: { backgroundColor: colors.danger, borderColor: 'rgba(248,113,113,0.5)' },
  textoPerigo: { color: colors.danger },
  aviso: { color: colors.warn, fontSize: 12, lineHeight: 18 },
  rodapeCard: { color: colors.textFaint, fontSize: 11, lineHeight: 16 },
  rodape: {
    color: colors.textFaint,
    fontSize: 11,
    lineHeight: 17,
    marginTop: 28,
    textAlign: 'center',
    paddingHorizontal: 10,
    borderRadius: radii.md,
  },
});
