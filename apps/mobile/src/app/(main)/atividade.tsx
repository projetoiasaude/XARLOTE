/** Atividade — chega em F3 (pedidos e consultas em andamento, ao vivo). */
import { Zap } from 'lucide-react-native';
import { EmptyState, GlassCard } from '@/components/ui';
import { Screen } from '@/components/xarlote/Screen';
import { colors } from '@/theme';

export default function AtividadeScreen() {
  return (
    <Screen title="Atividade" subtitle="o que estou fazendo por você">
      <GlassCard>
        <EmptyState
          icon={<Zap size={22} color={colors.textFaint} />}
          title="Nada em andamento por aqui ainda"
          hint="Quando eu estiver cotando um remédio ou marcando uma consulta, o passo a passo aparece nesta tela."
        />
      </GlassCard>
    </Screen>
  );
}
