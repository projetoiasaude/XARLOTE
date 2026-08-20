/**
 * A tela do código.
 *
 * Duas decisões que evitam suporte:
 *
 * 1. **Um TextInput invisível por trás de 6 células desenhadas.** Seis inputs de
 *    verdade dão um bug clássico: apagar não volta pra célula anterior, e colar o
 *    código do WhatsApp preenche só a primeira. Com um campo só, colar funciona e o
 *    `oneTimeCode` do iOS oferece o código direto no teclado.
 * 2. **O reenvio respeita os tetos do servidor** (ver lib/otp-timer.ts) em vez de
 *    deixar o paciente bater num 429 e ficar 15 minutos de fora sem entender.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import { ChevronLeft } from 'lucide-react-native';
import { GlassButton, GlassCard } from '@/components/ui';
import { requestOtp, verifyOtp } from '@/lib/api/auth';
import { ApiError } from '@/lib/api/errors';
import { useSession } from '@/lib/auth/session';
import { codeSecondsLeft, formatCountdown, resendState } from '@/lib/otp-timer';
import { formatPhonePretty } from '@/lib/phone-input';
import { colors, radii, FILL_PARENT } from '@/theme';
import Animated from 'react-native-reanimated';
import { useRecuoDoTeclado } from '@/lib/teclado';

const LENGTH = 6;

export default function OtpScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  // O teclado tampava o campo já AQUI, na primeira tela de quem instala. Ver `lib/teclado.ts`.
  const recuoDoTeclado = useRecuoDoTeclado(insets.bottom);
  const { signIn } = useSession();
  const params = useLocalSearchParams<{ phone: string; expiresInS: string; sentAt: string }>();

  const phone = params.phone ?? '';
  const ttlS = Number(params.expiresInS ?? 300);

  const input = useRef<TextInput>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sends, setSends] = useState<number[]>([Number(params.sentAt ?? Date.now())]);
  const [now, setNow] = useState(() => Date.now());

  // Um tique por segundo move os dois contadores (validade e reenvio).
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const ultimoEnvio = useMemo(() => Math.max(...sends), [sends]);
  const restaS = codeSecondsLeft(ultimoEnvio, ttlS, now);
  const reenvio = resendState(sends, now);

  const submit = useCallback(
    async (value: string) => {
      if (value.length !== LENGTH || busy) return;
      setBusy(true);
      setError(null);
      try {
        const result = await verifyOtp(phone, value);
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        // O signIn muda o gate; a guarda no _layout raiz leva pra frente. Esta tela
        // não navega — se navegasse, brigaria com a guarda e o app piscaria.
        await signIn(result);
      } catch (err) {
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        setCode('');
        setError(err instanceof ApiError ? err.failure.message : 'Não consegui conferir o código.');
      } finally {
        setBusy(false);
      }
    },
    [busy, phone, signIn],
  );

  const onChange = useCallback(
    (text: string) => {
      const digits = text.replace(/\D/g, '').slice(0, LENGTH);
      setCode(digits);
      if (error) setError(null);
      if (digits.length === LENGTH) void submit(digits);
    },
    [error, submit],
  );

  const resend = useCallback(async () => {
    if (!reenvio.canResend || busy) return;
    setBusy(true);
    setError(null);
    try {
      await requestOtp(phone);
      setSends((s) => [...s, Date.now()]);
      setCode('');
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    } catch (err) {
      setError(err instanceof ApiError ? err.failure.message : 'Não consegui reenviar agora.');
    } finally {
      setBusy(false);
    }
  }, [busy, phone, reenvio.canResend]);

  return (
    <Animated.View style={[styles.flex, recuoDoTeclado]}>
      <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Voltar"
          onPress={() => router.back()}
          hitSlop={12}
          style={styles.back}
        >
          <ChevronLeft size={22} color={colors.textDim} />
        </Pressable>
      </View>

      <View style={styles.content}>
        {/* Sem `entering` — mesma razão da tela de boas-vindas: se o worklet não
            rodar, o campo do código ficaria invisível e o login morreria aqui. */}
        <View style={styles.cardWrap}>
          <GlassCard style={styles.card}>
            <Text style={styles.title}>Digita o código</Text>
            <Text style={styles.subtitle}>
              Mandei 6 dígitos no WhatsApp {formatPhonePretty(phone)}.
            </Text>

            <Pressable onPress={() => input.current?.focus()} style={styles.cells}>
              {Array.from({ length: LENGTH }).map((_, i) => {
                const char = code[i];
                const active = i === code.length;
                return (
                  <View key={i} style={[styles.cell, active && styles.cellActive, error !== null && styles.cellError]}>
                    <Text style={styles.cellText}>{char ?? ''}</Text>
                  </View>
                );
              })}
              <TextInput
                ref={input}
                value={code}
                onChangeText={onChange}
                keyboardType="number-pad"
                // iOS oferece o código do WhatsApp direto na barra do teclado.
                textContentType="oneTimeCode"
                autoComplete="sms-otp"
                autoFocus
                maxLength={LENGTH}
                keyboardAppearance="dark"
                caretHidden
                style={styles.hiddenInput}
              />
            </Pressable>

            {error ? (
              <Text style={styles.error}>{error}</Text>
            ) : (
              <Text style={styles.hint}>
                {restaS > 0 ? `Vale por mais ${formatCountdown(restaS)}` : 'Esse código expirou — pede um novo.'}
              </Text>
            )}

            {reenvio.exhausted ? (
              <Text style={styles.exhausted}>
                Já mandei 3 códigos. Espera {formatCountdown(reenvio.waitS)} pra pedir outro — é um limite de
                segurança, não é você.
              </Text>
            ) : (
              <GlassButton
                variant="ghost"
                size="sm"
                disabled={!reenvio.canResend || busy}
                onPress={() => void resend()}
                style={styles.resend}
              >
                {reenvio.canResend ? 'Reenviar código' : `Reenviar em ${reenvio.waitS}s`}
              </GlassButton>
            )}
          </GlassCard>
        </View>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  header: { paddingHorizontal: 12 },
  back: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  content: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 24 },
  cardWrap: { width: '100%', maxWidth: 380 },
  card: { padding: 22 },
  title: { color: colors.text, fontSize: 20, fontWeight: '700', letterSpacing: -0.3 },
  subtitle: { color: colors.textDim, fontSize: 13, marginTop: 6, lineHeight: 19 },
  cells: { flexDirection: 'row', gap: 8, marginTop: 20, justifyContent: 'space-between' },
  cell: {
    flex: 1,
    aspectRatio: 0.78,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.10)',
    backgroundColor: 'rgba(255,255,255,0.04)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  cellActive: { borderColor: 'rgba(124,135,255,0.65)', backgroundColor: 'rgba(124,135,255,0.10)' },
  cellError: { borderColor: 'rgba(248,113,113,0.55)' },
  cellText: { color: colors.text, fontSize: 22, fontWeight: '600' },
  // O campo real fica sobreposto e transparente: recebe o toque, o teclado e o colar.
  hiddenInput: { ...FILL_PARENT, opacity: 0, color: 'transparent' },
  hint: { color: colors.textFaint, fontSize: 12, marginTop: 14, textAlign: 'center' },
  error: { color: '#fda4af', fontSize: 12, marginTop: 14, textAlign: 'center', lineHeight: 18 },
  exhausted: { color: colors.textFaint, fontSize: 11, marginTop: 12, textAlign: 'center', lineHeight: 17 },
  resend: { marginTop: 8, alignSelf: 'center' },
});
