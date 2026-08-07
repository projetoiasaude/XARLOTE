/**
 * A tela da Conversa.
 *
 * Nesta etapa (F1) ela ainda não é o chat — é a PROVA de que a corrente inteira
 * fecha: telefone → código no WhatsApp → JWT no Keychain → `GET /app/me` autenticado
 * → dado real do paciente na tela. Se esta tela mostra o nome certo, a fundação está
 * de pé. O chat vivo (mensagens + SSE + push) entra em F2 no lugar do aviso abaixo.
 */
import { StyleSheet, Text, View } from 'react-native';
import { MessageCircle } from 'lucide-react-native';
import { useMe } from '@/lib/api/use-me';
import { EmptyState, GlassBadge, GlassCard, Skeleton } from '@/components/ui';
import { Screen } from '@/components/xarlote/Screen';
import { useSession } from '@/lib/auth/session';
import { colors } from '@/theme';

/** "Bom dia" pelo relógio DO APARELHO — é o fuso em que o paciente está de fato. */
function saudacao(hour: number): string {
  if (hour < 12) return 'Bom dia';
  if (hour < 18) return 'Boa tarde';
  return 'Boa noite';
}

export default function ChatScreen() {
  const { user } = useSession();
  const { data, isLoading, isError } = useMe();

  const nome = (data?.user.preferredName ?? user?.preferredName ?? '').split(' ')[0];

  return (
    <Screen>
      <View style={styles.hero}>
        <Text style={styles.greeting}>
          {saudacao(new Date().getHours())}
          {nome ? `, ${nome}` : ''}
        </Text>
        {isLoading ? (
          <Skeleton width={180} style={styles.skeleton} />
        ) : (
          <Text style={styles.sub}>Sou a Xarlote. Estou aqui pra cuidar de você.</Text>
        )}
      </View>

      {data && !data.flags.xarloteEnabled && (
        <GlassBadge tone="warn" dot style={styles.badge}>
          Estou em manutenção agora
        </GlassBadge>
      )}

      <GlassCard style={styles.card}>
        <EmptyState
          icon={<MessageCircle size={22} color={colors.textFaint} />}
          title="A conversa chega na próxima etapa"
          hint={
            isError
              ? 'E olha: não consegui falar com o servidor agora — puxa de novo daqui a pouco.'
              : 'Por enquanto continuamos no WhatsApp, do mesmo jeito de sempre. Aqui vai ficar tudo, com foto de exame e áudio.'
          }
        />
      </GlassCard>
    </Screen>
  );
}

const styles = StyleSheet.create({
  hero: { marginTop: 8, marginBottom: 20 },
  greeting: { color: colors.text, fontSize: 28, fontWeight: '700', letterSpacing: -0.6 },
  sub: { color: colors.textDim, fontSize: 14, marginTop: 6, lineHeight: 20 },
  skeleton: { marginTop: 10 },
  badge: { marginBottom: 12 },
  card: { paddingVertical: 8 },
});
