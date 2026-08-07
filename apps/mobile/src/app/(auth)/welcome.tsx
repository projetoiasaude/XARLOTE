/**
 * A porta de entrada: o paciente digita o WhatsApp dele.
 *
 * Uma escolha que parece pequena e não é: a resposta do servidor é IDÊNTICA exista
 * ou não o número (anti-enumeração). Então esta tela nunca diz "não achei seu
 * cadastro" — ela sempre segue pro código. Quem não tem cadastro nasce no verify,
 * quando provar posse do número.
 */
import { useCallback, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ArrowRight, ShieldCheck } from 'lucide-react-native';
import { toE164BR } from '@iasaude/shared';
import { GlassButton, GlassCard, GlassInput } from '@/components/ui';
import { XarloteHero } from '@/components/xarlote/XarloteHero';
import { requestOtp } from '@/lib/api/auth';
import { ApiError } from '@/lib/api/errors';
import { isSubmittablePhone, looksLikeLandline, maskPhoneBR, phoneDigitsBR } from '@/lib/phone-input';
import { colors, spacing } from '@/theme';

export default function WelcomeScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [raw, setRaw] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = useCallback(async () => {
    setError(null);
    const e164 = toE164BR(phoneDigitsBR(raw));
    if (!e164) {
      setError('Esse número não parece completo — confere o DDD?');
      return;
    }
    setSending(true);
    try {
      const { expiresInS } = await requestOtp(e164);
      router.push({
        pathname: '/(auth)/otp',
        params: { phone: e164, expiresInS: String(expiresInS), sentAt: String(Date.now()) },
      });
    } catch (err) {
      setError(err instanceof ApiError ? err.failure.message : 'Não consegui pedir o código agora.');
    } finally {
      setSending(false);
    }
  }, [raw, router]);

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView
        contentContainerStyle={[
          styles.content,
          { paddingTop: insets.top + 24, paddingBottom: insets.bottom + 32 },
        ]}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        {/* SEM animação de entrada aqui, e é uma decisão de segurança, não de estilo.
            Uma `entering` do Reanimated começa em opacity 0 e só chega a 1 se o
            worklet rodar. Quando ele não roda (engine sem worklets, versão
            incompatível, plugin do babel fora), o que sobra é a tela de login
            INVISÍVEL — o pior defeito possível na primeira tela do app. A entrada
            que existe é a do orb, que anima só translateY: se falhar, ele fica
            parado, nunca some. Animação pode enfeitar; não pode ser o que revela. */}
        <XarloteHero size={148} />

        <Text style={styles.tagline}>
          Sua saúde, cuidada por uma IA que age de verdade —{'\n'}
          lembra, compra, marca e acompanha você.
        </Text>

        <View style={styles.cardWrap}>
          <GlassCard style={styles.card}>
            <Text style={styles.label}>Seu WhatsApp</Text>
            <GlassInput
              value={maskPhoneBR(raw)}
              onChangeText={(t) => {
                setRaw(t);
                if (error) setError(null);
              }}
              placeholder="(62) 99999-9999"
              keyboardType="phone-pad"
              textContentType="telephoneNumber"
              autoComplete="tel"
              maxLength={16}
              error={error !== null}
              style={styles.input}
              onSubmitEditing={() => void submit()}
              returnKeyType="go"
            />
            {/* Botão apagado precisa dizer POR QUÊ — senão o paciente fica olhando
                pra um número que ele considera certo e um botão que não acende. */}
            {error ? (
              <Text style={styles.error}>{error}</Text>
            ) : looksLikeLandline(raw) ? (
              <Text style={styles.aviso}>
                Esse parece um telefone fixo. Preciso do celular que tem WhatsApp — é por lá que mando o código.
              </Text>
            ) : null}

            <GlassButton
              variant="primary"
              size="lg"
              loading={sending}
              disabled={!isSubmittablePhone(raw)}
              onPress={() => void submit()}
              style={styles.cta}
              icon={<ArrowRight size={16} color="#fff" />}
            >
              Receber código
            </GlassButton>

            <View style={styles.note}>
              <ShieldCheck size={13} color={colors.textFaint} />
              <Text style={styles.noteText}>
                Mando um código de 6 dígitos no seu WhatsApp. É como sei que é você.
              </Text>
            </View>
          </GlassCard>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  content: { flexGrow: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 24 },
  tagline: {
    marginTop: 4,
    color: 'rgba(255,255,255,0.55)',
    fontSize: 14,
    lineHeight: 21,
    textAlign: 'center',
  },
  cardWrap: { width: '100%', maxWidth: 380, marginTop: spacing.xl },
  card: { padding: 20 },
  label: { color: 'rgba(255,255,255,0.60)', fontSize: 12, fontWeight: '600' },
  input: { marginTop: 8 },
  error: { color: '#fda4af', fontSize: 12, marginTop: 8, lineHeight: 17 },
  aviso: { color: '#fcd34d', fontSize: 12, marginTop: 8, lineHeight: 17 },
  cta: { marginTop: 16, width: '100%' },
  note: { flexDirection: 'row', gap: 7, alignItems: 'flex-start', marginTop: 14 },
  noteText: { flex: 1, color: colors.textFaint, fontSize: 11, lineHeight: 16 },
});
