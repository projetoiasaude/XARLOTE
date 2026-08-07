/** Lembretes — chega em F3 (lista + ações feito/adiar/cancelar com eco otimista). */
import { AlarmClock } from 'lucide-react-native';
import { EmptyState, GlassCard } from '@/components/ui';
import { Screen } from '@/components/xarlote/Screen';
import { colors } from '@/theme';

export default function LembretesScreen() {
  return (
    <Screen title="Lembretes" subtitle="remédios, consultas e exames">
      <GlassCard>
        <EmptyState
          icon={<AlarmClock size={22} color={colors.textFaint} />}
          title="Seus lembretes continuam no WhatsApp"
          hint="Nada se perdeu — eu sigo te avisando por lá. Em breve dá pra confirmar e adiar por aqui também."
        />
      </GlassCard>
    </Screen>
  );
}
