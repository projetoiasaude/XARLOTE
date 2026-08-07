/**
 * Consentimento específico de DADOS DE SAÚDE — bloqueante, e por bons motivos.
 *
 * A LGPD trata saúde como dado sensível (art. 11): o consentimento tem que ser
 * destacado e específico, não pode vir embutido num "aceito os termos". A Apple
 * exige o mesmo in-app pra qualquer app de saúde. Por isso esta tela não tem
 * "pular": sem aceite não há app — e há um caminho claro pra sair (voltar ao login).
 *
 * O texto exibido é o MESMO que vai pro banco como evidência (`APP_CONSENT_SUMMARY`
 * em apps/api/src/routes/app/consent.ts). Se um dia divergirem, a prova não vale.
 */
import { useCallback, useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Download, FileText, ShieldCheck, Trash2 } from 'lucide-react-native';
import { GlassButton, GlassCard } from '@/components/ui';
import { apiFetch } from '@/lib/api/client';
import { ApiError } from '@/lib/api/errors';
import { useSession } from '@/lib/auth/session';
import { colors, spacing } from '@/theme';

interface ConsentInfo {
  required: boolean;
  version: string;
  text: string;
  acceptedAt: string | null;
}

const DIREITOS = [
  { icon: Download, text: 'Exportar tudo o que eu sei sobre você, quando quiser.' },
  { icon: Trash2, text: 'Apagar sua conta e seus dados, sem precisar falar com ninguém.' },
  { icon: FileText, text: 'Ver e revogar o que você autorizou, a qualquer momento.' },
];

export default function ConsentScreen() {
  const insets = useSafeAreaInsets();
  const { markConsented, signOut } = useSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<ConsentInfo | null>(null);

  // Busca o texto e a versão do servidor: o aceite tem que ser da versão CORRENTE.
  // O texto local abaixo é só fallback visual — o POST usa a versão que veio daqui.
  // `tentativa` existe pra dar RETENTATIVA: sem ela, uma falha de rede aqui prende o
  // paciente numa tela cujo único botão é sair da conta.
  const [tentativa, setTentativa] = useState(0);
  useEffect(() => {
    let cancelado = false;
    void apiFetch<ConsentInfo>('/app/consent')
      .then((r) => {
        if (!cancelado) {
          setInfo(r);
          setError(null);
        }
      })
      .catch(() => {
        if (!cancelado) setError('Não consegui carregar os termos agora.');
      });
    return () => {
      cancelado = true;
    };
  }, [tentativa]);

  const accept = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const version = info?.version;
      if (!version) throw new ApiError({ kind: 'unavailable', message: 'Não consegui carregar os termos agora.', retryable: true }, 0);
      await apiFetch('/app/consent', { method: 'POST', body: { policyVersion: version } });
      markConsented();
    } catch (err) {
      setError(err instanceof ApiError ? err.failure.message : 'Não consegui registrar o aceite.');
    } finally {
      setBusy(false);
    }
  }, [busy, info, markConsented]);

  return (
    <ScrollView
      contentContainerStyle={[
        styles.content,
        { paddingTop: insets.top + 32, paddingBottom: insets.bottom + 24 },
      ]}
      showsVerticalScrollIndicator={false}
    >
      <View style={styles.badge}>
        <ShieldCheck size={26} color={colors.accentHi} />
      </View>

      <Text style={styles.title}>Antes de começar</Text>
      <Text style={styles.lead}>
        Pra cuidar de você eu preciso guardar coisas sensíveis: seus exames, seus remédios, o que você me conta.
        Isso é seu — e você manda nele.
      </Text>

      <GlassCard style={styles.card}>
        <Text style={styles.termos}>
          {info?.text ??
            'Autorizo a Xarlote a coletar e tratar meus dados de saúde (mensagens, exames, medicamentos, ' +
              'lembretes e histórico clínico) para me acompanhar, lembrar de tratamentos, cotar medicamentos e ' +
              'agendar consultas. Posso revogar, exportar ou apagar tudo a qualquer momento pelo próprio app.'}
        </Text>
      </GlassCard>

      <View style={styles.direitos}>
        {DIREITOS.map(({ icon: Icon, text }) => (
          <View key={text} style={styles.direito}>
            <Icon size={15} color={colors.textDim} />
            <Text style={styles.direitoText}>{text}</Text>
          </View>
        ))}
      </View>

      {error && <Text style={styles.error}>{error}</Text>}

      {info === null ? (
        <GlassButton variant="secondary" size="lg" onPress={() => setTentativa((t) => t + 1)} style={styles.cta}>
          Tentar de novo
        </GlassButton>
      ) : (
        <GlassButton
          variant="primary"
          size="lg"
          loading={busy}
          onPress={() => void accept()}
          style={styles.cta}
        >
          Aceito e quero começar
        </GlassButton>
      )}

      <GlassButton variant="ghost" size="sm" onPress={() => void signOut()} style={styles.sair}>
        Agora não, sair
      </GlassButton>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { flexGrow: 1, justifyContent: 'center', paddingHorizontal: 24 },
  badge: {
    alignSelf: 'center',
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(124,135,255,0.14)',
    borderWidth: 1,
    borderColor: 'rgba(124,135,255,0.3)',
  },
  title: {
    color: colors.text,
    fontSize: 24,
    fontWeight: '700',
    letterSpacing: -0.5,
    textAlign: 'center',
    marginTop: 16,
  },
  lead: {
    color: colors.textDim,
    fontSize: 14,
    lineHeight: 21,
    textAlign: 'center',
    marginTop: 10,
  },
  card: { padding: 16, marginTop: spacing.xl },
  termos: { color: 'rgba(255,255,255,0.75)', fontSize: 13, lineHeight: 20 },
  direitos: { marginTop: 18, gap: 10 },
  direito: { flexDirection: 'row', alignItems: 'flex-start', gap: 9 },
  direitoText: { flex: 1, color: colors.textFaint, fontSize: 12, lineHeight: 18 },
  error: { color: '#fda4af', fontSize: 12, marginTop: 14, textAlign: 'center' },
  cta: { marginTop: spacing.xl, width: '100%' },
  sair: { marginTop: 8, alignSelf: 'center' },
});
