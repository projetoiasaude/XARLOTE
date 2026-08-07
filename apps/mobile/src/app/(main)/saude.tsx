/** Saúde 360 — chega em F3 (overview + biblioteca de exames + gráfico de adesão). */
import { HeartPulse } from 'lucide-react-native';
import { EmptyState, GlassCard } from '@/components/ui';
import { Screen } from '@/components/xarlote/Screen';
import { colors } from '@/theme';

export default function SaudeScreen() {
  return (
    <Screen title="Saúde" subtitle="seu histórico, organizado">
      <GlassCard>
        <EmptyState
          icon={<HeartPulse size={22} color={colors.textFaint} />}
          title="Ainda estou montando esta tela"
          hint="Vai ficar aqui: seus exames por data, o que estou tomando conta, e o gráfico de como você vem seguindo o tratamento."
        />
      </GlassCard>
    </Screen>
  );
}
