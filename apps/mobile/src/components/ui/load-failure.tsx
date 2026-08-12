/**
 * "Não consegui carregar" — o estado que faltava, e a razão de ele existir.
 *
 * ## O bug que criou este componente
 *
 * A tela de Lembretes desenhava **"Nenhum lembrete por aqui"** para uma resposta 404 da
 * API. O paciente tinha lembretes; a rota ainda não existia em produção. A tela então
 * afirmou, com toda a calma, que ele não tinha nenhum — e ofereceu a dica de como criar
 * o primeiro. Falha virando sucesso, no lugar mais caro possível: alguém pode concluir
 * que a Xarlote parou de lembrar do remédio dele.
 *
 * Vazio e quebrado são estados DIFERENTES e precisam de telas diferentes. O componente
 * distingue os dois pelo `kind` da falha, nunca por texto:
 *
 *   · `network`/`timeout` → é o aparelho/a rede. "Confere a internet."
 *   · o resto            → é o servidor. "O problema é do meu lado."
 *
 * A distinção importa porque muda o que o paciente faz em seguida. Dizer "confere sua
 * internet" quando o servidor caiu manda a pessoa mexer no Wi-Fi por nada.
 */
import { CloudOff, RefreshCw, WifiOff } from 'lucide-react-native';
import { ApiError } from '@/lib/api/errors';
import { colors } from '@/theme';
import { GlassButton } from './glass-button';
import { GlassCard } from './glass-card';
import { EmptyState } from './empty-state';

interface Props {
  erro: unknown;
  onTentarDeNovo: () => void;
  /** O que não carregou, em minúsculas: 'seus lembretes', 'seu histórico'. */
  oQue: string;
  tentando?: boolean;
}

function ehFalhaDeRede(erro: unknown): boolean {
  return erro instanceof ApiError && (erro.failure.kind === 'network' || erro.failure.kind === 'timeout');
}

export function LoadFailure({ erro, onTentarDeNovo, oQue, tentando }: Props) {
  const deRede = ehFalhaDeRede(erro);

  return (
    <GlassCard>
      <EmptyState
        icon={
          deRede ? (
            <WifiOff size={22} color={colors.warn} />
          ) : (
            <CloudOff size={22} color={colors.warn} />
          )
        }
        title={`Não consegui carregar ${oQue}`}
        hint={
          deRede
            ? 'Parece que a conexão caiu. Confere a internet e tenta de novo — nada foi perdido.'
            : 'O problema é do meu lado, não seu. Tenta de novo em instantes; se continuar, me chama no WhatsApp.'
        }
        action={
          <GlassButton
            variant="secondary"
            size="sm"
            onPress={onTentarDeNovo}
            loading={tentando}
            icon={<RefreshCw size={14} color={colors.textDim} />}
          >
            Tentar de novo
          </GlassButton>
        }
      />
    </GlassCard>
  );
}
