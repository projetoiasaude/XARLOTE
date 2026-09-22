/**
 * Um aviso do prontuário com a saída dele do lado.
 *
 * A regra que este componente encarna: **aviso sem ação é cobrança.** Dizer "sua
 * Losartana está acabando" e deixar o paciente sozinho com a informação é pior do que
 * não dizer nada — ele já sabia, e agora tem um cartão amarelo lembrando disso. O botão
 * é a metade que faltava, e ele faz de verdade (`useFalarComXarlote` manda a mensagem;
 * não abre um campo de texto pedindo que o paciente escreva o pedido).
 *
 * Nada aqui pulsa nem entra animado: um aviso é conteúdo em repouso, e a única coisa
 * que se move na tela é resposta ao toque.
 */
import { memo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { CalendarClock, PackageOpen } from 'lucide-react-native';
import { GlassButton, GlassCard } from '@/components/ui';
import { colors, radii } from '@/theme';
import type { Aviso } from './insights';

interface Props {
  aviso: Aviso;
  /** Este aviso tem um envio em voo — o botão vira spinner e não aceita dois toques. */
  ocupado: boolean;
  /**
   * 🤝 A bolsa aberta é de outra pessoa. Vale só pra ação `perguntar`, que escreveria na
   * conversa de quem está logado; `abrirExame` é leitura e continua valendo. O porquê é
   * dito uma vez no topo da tela (`AvisoCuidador`).
   */
  bloqueado?: boolean;
  onPerguntar: (mensagem: string, chave: string) => void;
  onAbrirExame: (exameId: string) => void;
}

export const CardAviso = memo(function CardAviso({
  aviso,
  ocupado,
  bloqueado = false,
  onPerguntar,
  onAbrirExame,
}: Props) {
  const cor = aviso.tom === 'warn' ? colors.warn : colors.info;
  const travado = bloqueado && aviso.acao.tipo === 'perguntar';

  return (
    <GlassCard style={styles.card}>
      <View style={styles.topo}>
        <View style={[styles.icone, { borderColor: `${cor}44` }]}>
          {aviso.tom === 'warn' ? (
            <PackageOpen size={16} color={cor} />
          ) : (
            <CalendarClock size={16} color={cor} />
          )}
        </View>
        <View style={styles.textos}>
          <Text style={styles.titulo}>{aviso.titulo}</Text>
          <Text style={styles.detalhe}>{aviso.detalhe}</Text>
        </View>
      </View>

      <GlassButton
        variant={aviso.tom === 'warn' ? 'primary' : 'secondary'}
        size="md"
        style={styles.botao}
        loading={ocupado}
        disabled={travado}
        onPress={() => {
          if (aviso.acao.tipo === 'perguntar') onPerguntar(aviso.acao.mensagem, aviso.chave);
          else onAbrirExame(aviso.acao.exameId);
        }}
        accessibilityLabel={`${aviso.acao.rotulo}: ${aviso.titulo}`}
      >
        {aviso.acao.rotulo}
      </GlassButton>
    </GlassCard>
  );
});

const styles = StyleSheet.create({
  card: { padding: 14, gap: 12 },
  topo: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  icone: {
    width: 30,
    height: 30,
    borderRadius: radii.md,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
  },
  textos: { flex: 1, gap: 3 },
  titulo: { color: colors.text, fontSize: 15, fontWeight: '600', lineHeight: 20 },
  detalhe: { color: colors.textDim, fontSize: 13, lineHeight: 18 },
  // 44pt de alvo: o `md` do GlassButton tem 40 e o `hitSlop` do primitivo é assunto de
  // outra frente — aqui a altura resolve sem depender daquilo.
  botao: { height: 44, alignSelf: 'flex-start' },
});
